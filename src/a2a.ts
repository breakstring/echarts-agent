import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AgentCard, Artifact, Message, Task, TaskState, type Part, type ListTasksResponse } from '@a2a-js/sdk';
import { AgentEvent, DefaultRequestHandler, JsonRpcTransportHandler, ServerCallContext, validateVersion, type TaskStore, type AgentExecutor, type RequestContext, type ExecutionEventBus } from '@a2a-js/sdk/server';
import { TaskNotCancelableError, UnsupportedOperationError, VersionNotSupportedError, toRestErrorBody } from '@a2a-js/sdk/errors';
import { LegacyJsonRpcTransportHandler } from '@a2a-js/sdk/compat/v0_3/server';
import { ChartService } from './service.js';
import { safeError, AppError } from './errors.js';
import { rawRequestSchema, chartRequestSchema, generateRequestSchema, LIMITS } from './contracts.js';

const inputSchema = z.discriminatedUnion('operation', [z.strictObject({ operation: z.literal('render'), request: rawRequestSchema }), z.strictObject({ operation: z.literal('chart'), request: chartRequestSchema }), z.strictObject({ operation: z.literal('generate'), request: generateRequestSchema })]);
const rpcSchema = z.strictObject({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(128), z.number().finite(), z.null()]), method: z.string().max(80), params: z.unknown().optional() });
const legacySendSchema = z.strictObject({ message: z.strictObject({ kind: z.literal('message'), messageId: z.string().min(1).max(128), role: z.literal('user'), parts: z.array(z.strictObject({ kind: z.literal('data'), data: inputSchema })).length(1) }), configuration: z.strictObject({ blocking: z.boolean().default(true), acceptedOutputModes: z.array(z.string().max(80)).max(8).optional(), historyLength: z.literal(0).optional() }).optional() });
const metadataSchema = z.record(z.string(), z.unknown()).optional();
const sendSchema = z.strictObject({
  tenant: z.literal('').optional(),
  metadata: metadataSchema,
  message: z.strictObject({
    messageId: z.string().min(1).max(128), role: z.union([z.literal('ROLE_USER'), z.literal(1)]),
    contextId: z.literal('').optional(), taskId: z.literal('').optional(),
    referenceTaskIds: z.array(z.string()).length(0).optional(), extensions: z.array(z.string()).length(0).optional(), metadata: metadataSchema,
    parts: z.array(z.strictObject({ data: inputSchema, mediaType: z.enum(['', 'application/json']).optional(), filename: z.literal('').optional(), metadata: metadataSchema })).length(1)
  }),
  configuration: z.strictObject({ returnImmediately: z.boolean().optional(), acceptedOutputModes: z.array(z.string().max(80)).max(8).optional(), historyLength: z.literal(0).optional() }).optional()
});
const taskSchema = z.strictObject({ id: z.string().uuid(), historyLength: z.literal(0).optional() });
const getTaskSchema = taskSchema.extend({ tenant: z.literal('').optional() });
const cancelTaskSchema = z.strictObject({ id: z.string().uuid(), tenant: z.literal('').optional(), metadata: metadataSchema });
const terminal = (task: Task) => task.status !== undefined && [TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED].includes(task.status.state);

export class EphemeralTaskStore implements TaskStore {
  private tasks = new Map<string, { task: Task; updated: number; bytes: number }>();
  constructor(private ttlMs = 600_000, private maxBytes = 64 * 1024 * 1024) {}
  sweep() { for (const [id, entry] of this.tasks) if (terminal(entry.task) && Date.now() - entry.updated >= this.ttlMs) this.tasks.delete(id); }
  clear() { this.tasks.clear(); }
  async load(id: string): Promise<Task | undefined> { this.sweep(); const found = this.tasks.get(id); return found ? Task.fromJSON(Task.toJSON(found.task)) : undefined; }
  async list(): Promise<ListTasksResponse> { throw new UnsupportedOperationError('不支持任务列表'); }
  async save(task: Task) {
    this.sweep();
    // 用 wire JSON 计算预算并复制二进制，避免 Buffer 被 structuredClone 转成数字键对象。
    const json = Task.toJSON({ ...task, history: [] });
    const bytes = Buffer.byteLength(JSON.stringify(json));
    if (bytes > this.maxBytes) throw new AppError('OUTPUT_TOO_LARGE', 413, '任务内容超出内存限额');
    let total = [...this.tasks.values()].reduce((sum, entry) => sum + entry.bytes, 0) - (this.tasks.get(task.id)?.bytes ?? 0);
    let count = this.tasks.size - (this.tasks.has(task.id) ? 1 : 0);
    const evicted: string[] = [];
    for (const [id, entry] of this.tasks) {
      if (total + bytes <= this.maxBytes && count < 100) break;
      if (id !== task.id && terminal(entry.task)) { total -= entry.bytes; count--; evicted.push(id); }
    }
    if (total + bytes > this.maxBytes || count >= 100) throw new AppError('A2A_BUSY', 429, '任务内存已满');
    for (const id of evicted) this.tasks.delete(id);
    this.tasks.delete(task.id);
    this.tasks.set(task.id, { task: Task.fromJSON(json), updated: Date.now(), bytes });
  }
}
class ChartExecutor implements AgentExecutor {
  active = new Map<string, { controller: AbortController; contextId: string }>();
  pending = new Set<ServerCallContext>();
  constructor(private service: ChartService) {}
  close() { for (const entry of this.active.values()) entry.controller.abort(); }
  async execute(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const controller = new AbortController();
    this.active.set(context.taskId, { controller, contextId: context.contextId });
    this.pending.delete(context.context);
    const task = Task.fromJSON({ id: context.taskId, contextId: context.contextId, status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() } });
    bus.publish(AgentEvent.task(task));
    try {
      const part = context.userMessage.parts[0];
      const input = inputSchema.parse(part?.content?.$case === 'data' ? part.content.value : undefined);
      const artifact = input.operation === 'render' ? await this.service.raw(input.request, controller.signal) : input.operation === 'chart' ? await this.service.chart(input.request, controller.signal) : (await this.service.generate(input.request, controller.signal, 'a2a')).artifact;
      if (controller.signal.aborted) return;
      const file: Part = { filename: artifact.svg ? 'chart.svg' : 'chart.png', mediaType: artifact.mimeType, content: { $case: 'raw', value: artifact.base64 ? Buffer.from(artifact.base64, 'base64') : Buffer.from(artifact.svg!) }, metadata: undefined };
      const result: Artifact = { artifactId: randomUUID(), name: 'chart', description: '', extensions: [], parts: [file], metadata: { width: artifact.width, height: artifact.height, bytes: artifact.bytes } };
      if (Buffer.byteLength(JSON.stringify(Artifact.toJSON(result))) > LIMITS.outputBytes) throw new AppError('OUTPUT_TOO_LARGE', 413, 'A2A 图像输出超限');
      bus.publish(AgentEvent.artifactUpdate({ taskId: context.taskId, contextId: context.contextId, artifact: result, lastChunk: true, append: false, metadata: undefined }));
      bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString(), message: undefined }, metadata: undefined }));
    } catch (error) {
      if (!controller.signal.aborted) {
        const safe = safeError(error);
        bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: { state: TaskState.TASK_STATE_FAILED, timestamp: new Date().toISOString(), message: Message.fromJSON({ role: 'ROLE_AGENT', messageId: randomUUID(), taskId: context.taskId, contextId: context.contextId, parts: [{ data: { error: { code: safe.code, message: safe.message } } }] }) }, metadata: undefined }));
      }
    } finally { this.active.delete(context.taskId); bus.finished(); }
  }
  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    const active = this.active.get(taskId);
    if (!active) throw new TaskNotCancelableError(taskId);
    active.controller.abort();
    bus.publish(AgentEvent.statusUpdate({ taskId, contextId: active.contextId, status: { state: TaskState.TASK_STATE_CANCELED, timestamp: new Date().toISOString(), message: undefined }, metadata: undefined }));
    bus.finished();
  }
}

export function registerA2A(app: FastifyInstance, service: ChartService, publicUrl: string): void {
  const url = new URL(publicUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('A2A_PUBLIC_URL 必须是无路径与凭据的服务 origin');
  const commonCard = { name: 'ECharts Agent', description: '生成受约束的 SVG/PNG 图表；任务内存保留10分钟，重启丢失', version: '0.2.0', capabilities: { streaming: false, pushNotifications: false }, defaultInputModes: ['application/json'], defaultOutputModes: ['image/svg+xml', 'image/png'], skills: [{ id: 'render', name: '图表渲染', description: '单个 data part: {operation:render|chart,request:HTTP请求体}', tags: ['chart', 'svg', 'png'] }, ...(service.aiStatus === 'ready' ? [{ id: 'generate', name: '智能图表', description: '单个 data part: {operation:generate,request:数据与意图}', tags: ['chart', 'llm'] }] : [])] };
  const supportedInterfaces = ['1.0', '0.3'].map(protocolVersion => ({ url: `${url.origin}/a2a`, protocolBinding: 'JSONRPC', protocolVersion }));
  const card = AgentCard.fromJSON({ ...commonCard, supportedInterfaces, securitySchemes: { bearerAuth: { httpAuthSecurityScheme: { scheme: 'bearer' } } }, securityRequirements: [{ schemes: { bearerAuth: { list: [] } } }] });
  const legacyCard = { ...commonCard, supportedInterfaces, protocolVersion: '0.3.0', url: `${url.origin}/a2a`, preferredTransport: 'JSONRPC', capabilities: { ...commonCard.capabilities, stateTransitionHistory: false }, securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, security: [{ bearerAuth: [] }] };
  const store = new EphemeralTaskStore();
  const executor = new ChartExecutor(service);
  const handler = new DefaultRequestHandler(card, store, executor);
  const transport = new JsonRpcTransportHandler(handler);
  const legacyTransport = new LegacyJsonRpcTransportHandler(handler);
  const sweeper = setInterval(() => store.sweep(), 30_000).unref();
  app.get('/.well-known/agent-card.json', async (request, reply) => {
    reply.header('vary', 'A2A-Version');
    const version = request.headers['a2a-version'] ?? '0.3';
    try { validateVersion(String(version), card, 'JSONRPC'); }
    catch (error) { return reply.status(400).send(toRestErrorBody(error, 400)); }
    return version === '1.0' ? AgentCard.toJSON(card) : legacyCard;
  });
  app.post('/a2a', async (request) => {
    const envelope = rpcSchema.safeParse(request.body);
    if (!envelope.success) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    const rpc = envelope.data;
    const legacy = ['message/send', 'tasks/get', 'tasks/cancel'].includes(rpc.method);
    if (!legacy && !['SendMessage', 'GetTask', 'CancelTask'].includes(rpc.method)) return { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not supported' } };
    const version = request.headers['a2a-version'] ?? '0.3';
    if (version !== (legacy ? '0.3' : '1.0')) return { jsonrpc: '2.0', id: rpc.id, error: JsonRpcTransportHandler.mapToJSONRPCError(new VersionNotSupportedError('方法与 A2A-Version 不匹配；支持 1.0 和 0.3，省略版本头表示 0.3')) };
    const sending = rpc.method === 'SendMessage' || rpc.method === 'message/send';
    const schema = legacy ? (sending ? legacySendSchema : taskSchema) : (sending ? sendSchema : rpc.method === 'GetTask' ? getTaskSchema : cancelTaskSchema);
    const params = schema.safeParse(rpc.params);
    if (!params.success) return { jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'Invalid params: 单个结构化 data part，不支持续写、文件输入或推送' } };
    const context = new ServerCallContext({ requestedVersion: version, user: { isAuthenticated: true, userName: 'service-key' } });
    if (sending && executor.pending.size + executor.active.size >= 4) return { jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'A2A busy' } };
    // 预留直到 execute 接管；阻塞请求与后台任务各只占一个并发名额。
    if (sending) executor.pending.add(context);
    try { return await (legacy ? legacyTransport : transport).handle({ ...rpc, params: params.data }, context); }
    finally { executor.pending.delete(context); }
  });
  app.addHook('onClose', async () => { clearInterval(sweeper); executor.close(); store.clear(); });
}
