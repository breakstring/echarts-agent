import { chartRequestSchema, rawRequestSchema, generateRequestSchema, planSchema, LIMITS, chartTypes, type Artifact, type ChartSpec, type ChartPlan } from './contracts.js';
import { compile } from './compiler.js';
import { prepareOption, inspectJson } from './policy.js';
import { RenderPool } from './pool.js';
import { AppError } from './errors.js';
import type { z } from 'zod';

export type Planner = (request: z.infer<typeof generateRequestSchema>, feedback: boolean, signal: AbortSignal) => Promise<unknown>;
export class ChartService {
  private activeGenerations = 0;
  constructor(public pool: RenderPool, private planner?: Planner, public aiStatus: 'disabled' | 'ready' | 'misconfigured' = planner ? 'ready' : 'disabled', private aiTimeoutMs = 60_000) {}
  capabilities() { return { version: '0.1.0', chartTypes, themes: ['light', 'dark', 'report'], formats: ['svg', 'png'], fonts: ['Noto Sans CJK SC'], limits: LIMITS, ai: { status: this.aiStatus, maxCalls: 2, timeoutMs: this.aiTimeoutMs }, mcp: { transport: 'streamable-http', stateless: true, protocolVersion: '2025-11-25' } }; }
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
  async generate(input: unknown, signal?: AbortSignal) {
    if (!this.planner) throw new AppError('AI_UNAVAILABLE', 503, '自然语言生成未启用或配置不完整');
    if (this.activeGenerations >= 2) throw new AppError('AI_BUSY', 429, '生成并发已满');
    this.activeGenerations++;
    try { return await this.generateInner(input, signal); }
    finally { this.activeGenerations--; }
  }
  private async generateInner(input: unknown, signal?: AbortSignal) {
    inspectJson(input);
    const request = generateRequestSchema.parse(input);
    const deadline = AbortSignal.timeout(this.aiTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let plan: ChartPlan | undefined;
    let spec: ChartSpec | undefined;
    let option: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      let result;
      try { result = await this.planner!(request, attempt > 0, combined); }
      catch { if (combined.aborted) throw new AppError(signal?.aborted ? 'CANCELLED' : 'AI_TIMEOUT', signal?.aborted ? 499 : 504, '生成已取消或超过总时限'); throw new AppError('AI_FAILED', 502, '模型调用失败'); }
      try { plan = planSchema.parse(result); spec = { ...plan, data: request.data }; inspectJson(spec); option = prepareOption(compile(spec, request.output.width), request.style); break; }
      catch { if (attempt === 1) throw new AppError('AI_INVALID_PLAN', 502, '模型未能返回有效字段映射'); }
    }
    if (combined.aborted) throw new AppError('AI_TIMEOUT', 504, '生成超过总时限');
    let artifact: Artifact;
    try { artifact = await this.pool.render({ option: option!, output: request.output }, combined); }
    catch (error) { if (deadline.aborted && !signal?.aborted) throw new AppError('AI_TIMEOUT', 504, '生成超过总时限'); throw error; }
    return { spec: spec!, option: option!, warnings: ['原始数据由程序绑定；模型图表选择仍需调用方复核'], artifact };
  }
}
