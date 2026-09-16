import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(public code: string, public status: number, message: string, public details: { path: string; reason: string }[] = []) { super(message); }
}
export function safeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) return new AppError('INVALID_INPUT', 422, '请求不符合图表合同', error.issues.slice(0, 12).map(i => ({ path: i.path.map(p => typeof p === 'number' ? p : /^[a-zA-Z_][\w-]{0,63}$/.test(String(p)) ? String(p) : '[field]').join('.'), reason: i.code })));
  return new AppError('INTERNAL_ERROR', 500, '服务暂时无法完成请求');
}
export function invalid(message: string, path = ''): never { throw new AppError('INVALID_INPUT', 422, message, path ? [{ path, reason: 'invalid_value' }] : []); }
