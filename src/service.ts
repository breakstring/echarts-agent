import { chartRequestSchema, rawRequestSchema, generateRequestSchema, planSchema, LIMITS, chartTypes, type Artifact, type ChartSpec, type ChartPlan } from './contracts.js';
import { compile } from './compiler.js';
import { prepareOption, inspectJson } from './policy.js';
import { RenderPool } from './pool.js';
import { randomUUID } from 'node:crypto';
import { AppError, ModelOutputError, safeError } from './errors.js';
import { noDiagnostics, safeDiagnostics, type Diagnostics } from './diagnostics.js';
import type { z } from 'zod';

export type Planner = (request: z.infer<typeof generateRequestSchema>, feedback: boolean, signal: AbortSignal, context?: { generationId: string }) => Promise<unknown>;
export class ChartService {
  private activeGenerations = 0;
  constructor(public pool: RenderPool, private planner?: Planner, public aiStatus: 'disabled' | 'ready' | 'misconfigured' = planner ? 'ready' : 'disabled', private aiTimeoutMs = 60_000, private diagnostics: Diagnostics = noDiagnostics) { this.diagnostics = safeDiagnostics(diagnostics); }
  capabilities() { return { version: '0.2.0', chartTypes, themes: ['light', 'dark', 'report'], formats: ['svg', 'png'], fonts: ['Noto Sans CJK SC'], limits: LIMITS, ai: { status: this.aiStatus, maxCalls: 2, timeoutMs: this.aiTimeoutMs }, mcp: { transport: 'streamable-http', stateless: true, protocolVersion: '2025-11-25' } }; }
  async raw(input: unknown, signal?: AbortSignal): Promise<Artifact> {
    inspectJson(input);
    const request = rawRequestSchema.parse(input);
    return this.pool.render({ option: prepareOption(request.option, request.style), output: request.output }, signal);
  }
  async chart(input: unknown, signal?: AbortSignal): Promise<Artifact> {
    inspectJson(input);
    const request = chartRequestSchema.parse(input);
    return this.pool.render({ option: prepareOption(compile(request.spec as ChartSpec, request.output.width), request.style), output: request.output }, signal);
  }
  async generate(input: unknown, signal?: AbortSignal, entry: 'http' | 'mcp' | 'a2a' | 'direct' = 'direct') {
    if (!this.planner) throw new AppError('AI_UNAVAILABLE', 503, '自然语言生成未启用或配置不完整');
    if (this.activeGenerations >= 2) throw new AppError('AI_BUSY', 429, '生成并发已满');
    this.activeGenerations++;
    const generationId = randomUUID();
    const started = performance.now();
    this.diagnostics('debug', 'generation_started', { generationId, entry });
    try {
      const result = await this.generateInner(input, generationId, signal);
      this.diagnostics('info', 'generation_completed', { generationId, entry, durationMs: performance.now() - started });
      return result;
    }
    catch (error) {
      const code = safeError(error).code;
      const reason = code === 'CANCELLED' ? 'cancelled' : code === 'AI_TIMEOUT' ? 'timeout' : code === 'AI_INVALID_PLAN' ? 'invalid_plan' : code === 'AI_FAILED' ? 'upstream' : code === 'INVALID_INPUT' ? 'invalid_input' : code === 'INTERNAL_ERROR' ? 'internal' : 'render';
      this.diagnostics('error', 'generation_failed', { generationId, entry, durationMs: performance.now() - started, reason });
      throw error;
    }
    finally { this.activeGenerations--; }
  }
  private async generateInner(input: unknown, generationId: string, signal?: AbortSignal) {
    inspectJson(input);
    const request = generateRequestSchema.parse(input);
    const deadline = AbortSignal.timeout(this.aiTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const checkCancellation = () => {
      if (combined.aborted) throw new AppError(signal?.aborted ? 'CANCELLED' : 'AI_TIMEOUT', signal?.aborted ? 499 : 504, '生成已取消或超过总时限');
    };
    const rejectPlan = (attempt: number, reason: 'invalid_output' | 'invalid_plan') => {
      checkCancellation();
      this.diagnostics('warn', 'plan_rejected', { generationId, attempt: attempt + 1, reason, retry: attempt === 0 });
      if (attempt === 1) throw new AppError('AI_INVALID_PLAN', 502, '模型未能返回有效图表计划');
    };
    let plan: ChartPlan | undefined;
    let spec: ChartSpec | undefined;
    let option: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      checkCancellation();
      let result;
      try { result = await this.planner!(request, attempt > 0, combined, { generationId }); }
      catch (error) {
        checkCancellation();
        if (error instanceof ModelOutputError) { rejectPlan(attempt, 'invalid_output'); continue; }
        throw new AppError('AI_FAILED', 502, '模型调用失败');
      }
      checkCancellation();
      try { plan = planSchema.parse(result); spec = { ...plan, data: request.data }; inspectJson(spec); option = prepareOption(compile(spec, request.output.width), request.style); }
      catch { rejectPlan(attempt, 'invalid_plan'); continue; }
      this.diagnostics('debug', 'plan_validated', { generationId, attempt: attempt + 1, rows: request.data.length, fields: new Set(request.data.flatMap(row => Object.keys(row))).size });
      break;
    }
    checkCancellation();
    const renderStarted = performance.now();
    this.diagnostics('debug', 'render_started', { generationId });
    let artifact: Artifact;
    try { artifact = await this.pool.render({ option: option!, output: request.output }, combined); }
    catch (error) { if (deadline.aborted && !signal?.aborted) throw new AppError('AI_TIMEOUT', 504, '生成超过总时限'); throw error; }
    this.diagnostics('debug', 'render_completed', { generationId, durationMs: performance.now() - renderStarted });
    return { spec: spec!, option: option!, warnings: ['原始数据由程序绑定；模型图表选择仍需调用方复核'], artifact };
  }
}
