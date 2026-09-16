import { fork, type ChildProcess } from 'node:child_process';
import type { Artifact, RenderJob } from './contracts.js';
import { AppError } from './errors.js';

interface Pending { job: RenderJob; resolve: (v: Artifact) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; signal?: AbortSignal; abort: () => void; slot?: Slot; done: boolean }
interface Slot { process: ChildProcess; ready: boolean; pending?: Pending; startup: NodeJS.Timeout }
export class RenderPool {
  private slots = new Set<Slot>();
  private queue: Pending[] = [];
  private closing = false;
  private failures: number[] = [];
  public restarts = 0;
  constructor(private options: { size?: number; queueLimit?: number; timeoutMs?: number; workerUrl?: URL; startupMs?: number } = {}) {
    for (let i = 0; i < (options.size ?? 2); i++) this.spawn();
  }
  get stats() { return { workers: this.slots.size, ready: [...this.slots].filter(s => s.ready).length, active: [...this.slots].filter(s => s.pending).length, queued: this.queue.length, restarts: this.restarts }; }
  get ready() { return !this.closing && this.stats.ready > 0; }
  async waitReady(ms = 10_000): Promise<void> {
    const end = Date.now() + ms;
    while (!this.ready) { if (Date.now() > end || this.closing) throw new AppError('WORKER_UNAVAILABLE', 503, '渲染进程未就绪'); await new Promise(r => setTimeout(r, 20)); }
  }
  private spawn(): void {
    if (this.closing || this.failures.filter(t => Date.now() - t < 30_000).length >= 5) return;
    const process = fork(this.options.workerUrl ?? new URL('./worker.js', import.meta.url), [], { execArgv: ['--max-old-space-size=256'], env: { PATH: globalThis.process.env.PATH ?? '', TZ: 'UTC', LANG: 'C.UTF-8', NODE_ENV: 'production' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const slot: Slot = { process, ready: false, startup: setTimeout(() => process.kill('SIGKILL'), this.options.startupMs ?? 10_000) };
    this.slots.add(slot);
    process.on('message', (message: any) => {
      if (message.ready) { clearTimeout(slot.startup); slot.ready = true; this.drain(); return; }
      if (!slot.pending) return;
      const pending = slot.pending;
      slot.pending = undefined;
      this.finish(pending, message.ok ? undefined : new AppError(message.error?.code ?? 'RENDER_FAILED', message.error?.status ?? 502, message.error?.message ?? '渲染失败'), message.artifact);
      this.drain();
    });
    process.on('error', () => { process.kill('SIGKILL'); });
    process.once('exit', () => {
      clearTimeout(slot.startup);
      this.slots.delete(slot);
      if (slot.pending) this.finish(slot.pending, new AppError('WORKER_CRASHED', 502, '渲染进程异常退出'));
      if (!this.closing) {
        this.restarts++;
        this.failures.push(Date.now());
        this.failures = this.failures.filter(t => Date.now() - t < 30_000);
        if (this.failures.length >= 5) { for (const item of [...this.queue]) this.finish(item, new AppError('WORKER_UNAVAILABLE', 503, '渲染进程持续异常，请重启服务')); }
        else setTimeout(() => this.spawn(), 100).unref();
      }
    });
  }
  render(job: RenderJob, signal?: AbortSignal): Promise<Artifact> {
    if (this.closing || this.slots.size === 0) return Promise.reject(new AppError('WORKER_UNAVAILABLE', 503, '渲染服务未就绪'));
    if (signal?.aborted) return Promise.reject(new AppError('CANCELLED', 499, '请求已取消'));
    const idle = [...this.slots].some(s => s.ready && !s.pending);
    if (!idle && this.queue.length >= (this.options.queueLimit ?? 8)) return Promise.reject(new AppError('QUEUE_FULL', 429, '渲染队列已满'));
    return new Promise((resolve, reject) => {
      const pending: Pending = { job, resolve, reject, signal, done: false, timer: undefined as any, abort: () => this.cancel(pending, new AppError('CANCELLED', 499, '请求已取消')) };
      pending.timer = setTimeout(() => this.cancel(pending, new AppError('RENDER_TIMEOUT', 504, '渲染超过总时限')), this.options.timeoutMs ?? 10_000);
      signal?.addEventListener('abort', pending.abort, { once: true });
      this.queue.push(pending);
      this.drain();
    });
  }
  private cancel(pending: Pending, error: AppError) {
    if (pending.done) return;
    if (pending.slot) { pending.slot.ready = false; pending.slot.process.kill('SIGKILL'); }
    this.finish(pending, error);
  }
  private finish(pending: Pending, error?: Error, artifact?: Artifact) {
    if (pending.done) return;
    pending.done = true;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.abort);
    this.queue = this.queue.filter(q => q !== pending);
    if (error) pending.reject(error); else pending.resolve(artifact!);
  }
  private drain() {
    if (this.closing) return;
    for (const slot of this.slots) {
      if (!slot.ready || slot.pending) continue;
      const pending = this.queue.shift();
      if (!pending) break;
      slot.pending = pending;
      pending.slot = slot;
      slot.process.send(pending.job, error => { if (error) this.cancel(pending, new AppError('WORKER_UNAVAILABLE', 503, '无法连接渲染进程')); });
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const pending of [...this.queue]) this.finish(pending, new AppError('SHUTTING_DOWN', 503, '服务正在停止'));
    await Promise.all([...this.slots].map(slot => new Promise<void>(resolve => {
      if (slot.pending) this.finish(slot.pending, new AppError('SHUTTING_DOWN', 503, '服务正在停止'));
      slot.process.once('exit', () => resolve());
      slot.process.kill('SIGTERM');
      const timer = setTimeout(() => slot.process.kill('SIGKILL'), 1000);
      slot.process.once('exit', () => clearTimeout(timer));
    })));
  }
}
