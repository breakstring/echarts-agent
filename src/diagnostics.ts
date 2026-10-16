const levels = { debug: 10, info: 20, warn: 30, error: 40, off: Infinity } as const;
type Level = Exclude<keyof typeof levels, 'off'>;
type Event = 'generation_started' | 'model_started' | 'model_completed' | 'model_failed' | 'plan_rejected' | 'plan_validated' | 'render_started' | 'render_completed' | 'generation_completed' | 'generation_failed';
type Reason = 'invalid_output' | 'invalid_plan' | 'upstream' | 'cancelled' | 'timeout' | 'render' | 'invalid_input' | 'internal';
interface Fields {
  generationId: string;
  entry?: 'http' | 'mcp' | 'a2a' | 'direct';
  attempt?: number;
  durationMs?: number;
  rows?: number;
  fields?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  upstreamStatus?: number;
  finishReason?: string;
  reason?: Reason;
  retry?: boolean;
  responseFormat?: 'json_object';
  thinking?: boolean;
}
export type Diagnostics = (level: Level, event: Event, fields: Fields) => void;
export const noDiagnostics: Diagnostics = () => {};
export function safeDiagnostics(log: Diagnostics): Diagnostics {
  return (...args) => { try { log(...args); } catch { /* 日志故障不影响请求与并发名额。 */ } };
}

export function createDiagnostics(level = 'info', write: (line: string) => void = line => console.log(line)): Diagnostics {
  const normalized = level.toLowerCase();
  if (!Object.hasOwn(levels, normalized)) throw new Error('LLM_LOG_LEVEL 必须为 debug/info/warn/error/off');
  const threshold = levels[normalized as keyof typeof levels];
  return (severity, event, fields) => {
    if (levels[severity] < threshold) return;
    // 只投影允许的元数据，绝不序列化异常对象、提示词或模型正文。
    const safe: Record<string, unknown> = { timestamp: new Date().toISOString(), level: severity, event, generationId: /^[\da-f-]{36}$/i.test(fields.generationId) ? fields.generationId : '[redacted]' };
    for (const key of ['attempt', 'durationMs', 'rows', 'fields', 'inputTokens', 'outputTokens', 'reasoningTokens'] as const) {
      const value = fields[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) safe[key] = Math.round(value);
    }
    if (fields.entry && ['http', 'mcp', 'a2a', 'direct'].includes(fields.entry)) safe.entry = fields.entry;
    if (fields.reason && ['invalid_output', 'invalid_plan', 'upstream', 'cancelled', 'timeout', 'render', 'invalid_input', 'internal'].includes(fields.reason)) safe.reason = fields.reason;
    if (fields.finishReason !== undefined) safe.finishReason = ['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other', 'unknown'].includes(fields.finishReason) ? fields.finishReason : 'unknown';
    if (Number.isInteger(fields.upstreamStatus) && fields.upstreamStatus! >= 100 && fields.upstreamStatus! <= 599) safe.upstreamStatus = fields.upstreamStatus;
    if (typeof fields.retry === 'boolean') safe.retry = fields.retry;
    if (typeof fields.thinking === 'boolean') safe.thinking = fields.thinking;
    if (fields.responseFormat === 'json_object') safe.responseFormat = fields.responseFormat;
    try { write(JSON.stringify(safe)); } catch { /* 日志失败不能重发模型请求或中断制图。 */ }
  };
}
