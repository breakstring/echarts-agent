import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AgentCard, Task, Part } from '@a2a-js/sdk-v0_3';
import { A2AError, DefaultRequestHandler, JsonRpcTransportHandler, type TaskStore, type AgentExecutor, type RequestContext, type ExecutionEventBus } from '@a2a-js/sdk-v0_3/server';
import { ChartService } from './service.js';
import { safeError, AppError } from './errors.js';
import { rawRequestSchema, chartRequestSchema, generateRequestSchema, LIMITS } from './contracts.js';

const inputSchema = z.discriminatedUnion('operation', [z.strictObject({ operation: z.literal('render'), request: rawRequestSchema }), z.strictObject({ operation: z.literal('chart'), request: chartRequestSchema }), z.strictObject({ operation: z.literal('generate'), request: generateRequestSchema })]);
const rpcSchema = z.strictObject({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(128), z.number().finite(), z.null()]), method: z.string().max(80), params: z.unknown().optional() });
const sendSchema = z.strictObject({ message: z.strictObject({ kind: z.literal('message'), messageId: z.string().min(1).max(128), role: z.literal('user'), parts: z.array(z.strictObject({ kind: z.literal('data'), data: inputSchema })).length(1) }), configuration: z.strictObject({ blocking: z.boolean().optional(), acceptedOutputModes: z.array(z.string().max(80)).max(8).optional(), historyLength: z.literal(0).optional() }).optional() });
const taskSchema = z.strictObject({ id: z.string().uuid(), historyLength: z.literal(0).optional() });
const terminal = (task: Task) => ['completed', 'failed', 'canceled', 'rejected'].includes(task.status.state);

export class EphemeralTaskStore implements TaskStore {
  private tasks = new Map<string, { task: Task; updated: number; bytes: number }>();
  constructor(private ttlMs = 600_000, private maxBytes = 64 * 1024 * 1024) {}
  sweep() { for (const [id, entry] of this.tasks) if (terminal(entry.task) && Date.now() - entry.updated >= this.ttlMs) this.tasks.delete(id); }
  clear() { this.tasks.clear(); }
  async load(id: string) { this.sweep(); const found = this.tasks.get(id); return found ? structuredClone(found.task) : undefined; }
  async save(task: Task) {
    this.sweep();
    const stored = structuredClone({ ...task, history: [] });
    const bytes = Buffer.byteLength(JSON.stringify(stored));
    if (bytes > this.maxBytes) throw new AppError('OUTPUT_TOO_LARGE', 413, '任务内容超出内存限额');
    this.tasks.delete(task.id);
    let total = [...this.tasks.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [id, entry] of this.tasks) {
      if (total + bytes <= this.maxBytes && this.tasks.size < 100) break;
      if (terminal(entry.task)) { total -= entry.bytes; this.tasks.delete(id); }
    }
    if (total + bytes > this.maxBytes || this.tasks.size >= 100) throw new AppError('A2A_BUSY', 429, '任务内存已满');
    this.tasks.set(task.id, { task: stored, updated: Date.now(), bytes });
  }
}
class ChartExecutor implements AgentExecutor {
  active = new Map<string, { controller: AbortController; contextId: string }>();
  constructor(private service: ChartService) {}
  close() { for (const entry of this.active.values()) entry.controller.abort(); }
  async execute(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const controller = new AbortController();
    this.active.set(context.taskId, { controller, contextId: context.contextId });
    const task: Task = { kind: 'task', id: context.taskId, contextId: context.contextId, status: { state: 'working', timestamp: new Date().toISOString() } };
    bus.publish(task);
    try {
      const part = context.userMessage.parts[0];
      const input = inputSchema.parse(part?.kind === 'data' ? part.data : undefined);
      const artifact = input.operation === 'render' ? await this.service.raw(input.request, controller.signal) : input.operation === 'chart' ? await this.service.chart(input.request, controller.signal) : (await this.service.generate(input.request, controller.signal)).artifact;
      if (controller.signal.aborted) return;
      const file: Part = { kind: 'file', file: { name: artifact.svg ? 'chart.svg' : 'chart.png', mimeType: artifact.mimeType, bytes: artifact.base64 ?? Buffer.from(artifact.svg!).toString('base64') } };
      const result = { artifactId: randomUUID(), name: 'chart', parts: [file], metadata: { width: artifact.width, height: artifact.height, bytes: artifact.bytes } };
      if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.outputBytes) throw new AppError('OUTPUT_TOO_LARGE', 413, 'A2A 图像输出超限');
      bus.publish({ kind: 'artifact-update', taskId: context.taskId, contextId: context.contextId, artifact: result, lastChunk: true });
      bus.publish({ kind: 'status-update', taskId: context.taskId, contextId: context.contextId, status: { state: 'completed', timestamp: new Date().toISOString() }, final: true });
    } catch (error) {
      if (!controller.signal.aborted) {
        const safe = safeError(error);
        bus.publish({ kind: 'status-update', taskId: context.taskId, contextId: context.contextId, status: { state: 'failed', timestamp: new Date().toISOString(), message: { kind: 'message', role: 'agent', messageId: randomUUID(), parts: [{ kind: 'data', data: { error: { code: safe.code, message: safe.message } } }] } }, final: true });
      }
    } finally { this.active.delete(context.taskId); bus.finished(); }
  }
  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    const active = this.active.get(taskId);
    if (!active) throw A2AError.taskNotCancelable(taskId);
    active.controller.abort();
    bus.publish({ kind: 'status-update', taskId, contextId: active.contextId, status: { state: 'canceled', timestamp: new Date().toISOString() }, final: true });
    bus.finished();
  }
}

export function registerA2A(app: FastifyInstance, service: ChartService, publicUrl: string): void {
  const url = new URL(publicUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('A2A_PUBLIC_URL 必须是无路径与凭据的服务 origin');
  const card: AgentCard = { name: 'ECharts Agent', description: '生成受约束的 SVG/PNG 图表；任务内存保留10分钟，重启丢失', protocolVersion: '0.3.0', version: '0.1.0', url: `${url.origin}/a2a`, preferredTransport: 'JSONRPC', capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false }, defaultInputModes: ['application/json'], defaultOutputModes: ['image/svg+xml', 'image/png'], securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, security: [{ bearerAuth: [] }], skills: [{ id: 'render', name: '图表渲染', description: '单个 data part: {operation:render|chart,request:HTTP请求体}', tags: ['chart', 'svg', 'png'] }, ...(service.aiStatus === 'ready' ? [{ id: 'generate', name: '智能图表', description: '单个 data part: {operation:generate,request:数据与意图}', tags: ['chart', 'llm'] }] : [])] };
  const store = new EphemeralTaskStore();
  const executor = new ChartExecutor(service);
  const handler = new DefaultRequestHandler(card, store, executor);
  const transport = new JsonRpcTransportHandler(handler);
  const sweeper = setInterval(() => store.sweep(), 30_000).unref();
  let pendingSends = 0;
  app.get('/.well-known/agent-card.json', async () => card);
  app.post('/a2a', async (request) => {
    const envelope = rpcSchema.safeParse(request.body);
    if (!envelope.success) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    const rpc = envelope.data;
    if (!['message/send', 'tasks/get', 'tasks/cancel'].includes(rpc.method)) return { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not supported' } };
    const params = (rpc.method === 'message/send' ? sendSchema : taskSchema).safeParse(rpc.params);
    if (!params.success) return { jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'Invalid params: 单个结构化 data part，不支持续写、文件输入或推送' } };
    if (rpc.method === 'message/send' && pendingSends + executor.active.size >= 4) return { jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'A2A busy' } };
    if (rpc.method === 'message/send') pendingSends++;
    try { return await transport.handle({ ...rpc, params: params.data }); }
    finally { if (rpc.method === 'message/send') pendingSends--; }
  });
  app.addHook('onClose', async () => { clearInterval(sweeper); executor.close(); store.clear(); });
}
