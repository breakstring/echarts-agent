import { RenderPool } from './pool.js';
import { ChartService } from './service.js';
import { configuredPlanner } from './llm.js';
import { createServer } from './server.js';

const integer = (key: string, fallback: number, min: number, max: number) => { const v = Number(process.env[key] ?? fallback); if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${key} 配置超出范围`); return v; };
let pool: RenderPool | undefined;
try {
  const apiKey = process.env.SERVICE_API_KEY;
  const allowAnonymous = process.env.ALLOW_ANONYMOUS === 'true';
  if (!apiKey && !allowAnonymous) throw new Error('需要 SERVICE_API_KEY 或 ALLOW_ANONYMOUS=true');
  pool = new RenderPool({ size: integer('RENDER_WORKERS', 2, 1, 4), queueLimit: integer('RENDER_QUEUE_LIMIT', 8, 0, 32), timeoutMs: integer('RENDER_TIMEOUT_MS', 10_000, 100, 30_000) });
  const llm = configuredPlanner(process.env);
  if (process.env.A2A_ENABLED === 'true' && !process.env.A2A_PUBLIC_URL) throw new Error('启用 A2A 需要 A2A_PUBLIC_URL');
  const app = createServer(new ChartService(pool, llm.planner, llm.status, integer('LLM_TIMEOUT_MS', 60_000, 100, 60_000)), { apiKey, allowAnonymous, log: true, a2aPublicUrl: process.env.A2A_ENABLED === 'true' ? process.env.A2A_PUBLIC_URL : undefined });
  await pool.waitReady();
  await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: integer('PORT', 3000, 1, 65535) });
  console.log(JSON.stringify({ event: 'ready', port: Number(process.env.PORT ?? 3000), ai: llm.status }));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; const timer = setTimeout(() => process.exit(1), 5000).unref(); await pool?.close(); await app.close(); clearTimeout(timer); };
  process.on('SIGTERM', () => { void stop(); });
  process.on('SIGINT', () => { void stop(); });
} catch { console.error(JSON.stringify({ event: 'startup_failed', message: '启动失败，请检查鉴权、数值配置和 Worker 环境' })); await pool?.close(); process.exitCode = 1; }
