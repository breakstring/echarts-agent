#!/usr/bin/env node
import { open, lstat, unlink } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const REQUEST_LIMIT = 1024 * 1024;
const IMAGE_LIMIT = 10 * 1024 * 1024;
const JSON_LIMIT = 16 * 1024 * 1024;
const ERROR_CODES = new Set(['UNAUTHORIZED', 'REQUEST_TOO_LARGE', 'INVALID_JSON', 'UNSUPPORTED_MEDIA_TYPE', 'INVALID_INPUT', 'INTERNAL_ERROR', 'OUTPUT_TOO_LARGE', 'UNSAFE_OUTPUT', 'WORKER_UNAVAILABLE', 'WORKER_CRASHED', 'CANCELLED', 'QUEUE_FULL', 'RENDER_TIMEOUT', 'SHUTTING_DOWN', 'AI_UNAVAILABLE', 'AI_BUSY', 'AI_FAILED', 'AI_TIMEOUT', 'AI_INVALID_PLAN']);
class ClientError extends Error {
  constructor(code, details = {}) { super(code); this.details = { code, ...details }; }
}
function fail(code, details) { throw new ClientError(code, details); }
function origin() {
  let url;
  try { url = new URL(process.env.CHART_URL); } catch { fail('INVALID_CHART_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('INVALID_CHART_URL');
  return url.origin;
}
function timeout() {
  const value = process.env.CHART_TIMEOUT_MS ?? '90000';
  if (!/^\d+$/.test(value) || Number(value) < 100 || Number(value) > 120000) fail('INVALID_TIMEOUT');
  return Number(value);
}
function requestId(value) { return typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value) ? value : undefined; }
function mime(response) { return (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(); }
function json(buffer) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
  catch { fail('INVALID_RESPONSE'); }
}
async function boundedBody(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); fail('RESPONSE_TOO_LARGE'); }
  const reader = response.body?.getReader();
  if (!reader) fail('EMPTY_RESPONSE');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); fail('RESPONSE_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
async function fetchResponse(base, path, signal, body, limit) {
  const headers = { accept: 'application/json, image/png, image/svg+xml' };
  if (process.env.SERVICE_API_KEY) headers.authorization = `Bearer ${process.env.SERVICE_API_KEY}`;
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', body, headers, signal, redirect: 'manual' });
  const id = requestId(response.headers.get('x-request-id'));
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); fail('REDIRECT_REJECTED', { status: response.status, requestId: id }); }
  if (!response.ok) {
    let payload;
    try { if (mime(response) === 'application/json') payload = json(await boundedBody(response, 65536)); else await response.body?.cancel(); }
    catch { /* 错误体不可信；保留状态，不回显报文。 */ }
    const code = ERROR_CODES.has(payload?.error?.code) ? payload.error.code : 'HTTP_ERROR';
    fail(code, { status: response.status, requestId: id ?? requestId(payload?.error?.requestId) });
  }
  return { buffer: await boundedBody(response, limit), mimeType: mime(response), requestId: id };
}
async function readRequest(path) {
  let file;
  try {
    file = await open(path, 'r');
    const info = await file.stat();
    if (!info.isFile()) fail('INVALID_REQUEST_FILE');
    if (info.size > REQUEST_LIMIT) fail('REQUEST_TOO_LARGE');
    // 按上限读取，避免检查后文件增长造成无界分配。
    const buffer = Buffer.alloc(REQUEST_LIMIT + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await file.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > REQUEST_LIMIT) fail('REQUEST_TOO_LARGE');
    const body = buffer.subarray(0, size);
    let request;
    try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
    catch { fail('INVALID_REQUEST_JSON'); }
    if (!request || typeof request !== 'object' || Array.isArray(request)) fail('INVALID_REQUEST_JSON');
    return { body, request };
  } catch (error) { if (error instanceof ClientError) throw error; fail('REQUEST_FILE_UNREADABLE'); }
  finally { await file?.close(); }
}
function validateImage(buffer, format) {
  if (!buffer.length || buffer.length > IMAGE_LIMIT) fail('INVALID_IMAGE');
  if (format === 'png') {
    if (buffer.length < 45 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('INVALID_IMAGE');
    let offset = 8, imageData = false, ended = false;
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
      if (offset + length + 12 > buffer.length) fail('INVALID_IMAGE');
      if (offset === 8 && (type !== 'IHDR' || length !== 13 || !buffer.readUInt32BE(16) || !buffer.readUInt32BE(20))) fail('INVALID_IMAGE');
      if (type === 'IDAT') imageData = true;
      offset += length + 12;
      if (type === 'IEND') { if (length !== 0 || offset !== buffer.length) fail('INVALID_IMAGE'); ended = true; break; }
    }
    if (!imageData || !ended) fail('INVALID_IMAGE');
  } else {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).trim(); } catch { fail('INVALID_IMAGE'); }
    if (!/^<svg(?:\s|>)/.test(text) || !/(?:<\/svg>|\/>)$/.test(text) || /<!DOCTYPE|<!ENTITY|<\?|<\s*(?:script|foreignObject|iframe)\b|\bon\w+\s*=/i.test(text)) fail('INVALID_IMAGE');
  }
}
function generationImage(result, format) {
  const artifact = result?.artifact;
  const mimeType = format === 'png' ? 'image/png' : 'image/svg+xml';
  if (!artifact || artifact.mimeType !== mimeType) fail('UNEXPECTED_IMAGE_TYPE');
  let buffer;
  if (format === 'svg') {
    if (typeof artifact.svg !== 'string' || artifact.base64 !== undefined) fail('INVALID_IMAGE');
    buffer = Buffer.from(artifact.svg);
  } else {
    if (typeof artifact.base64 !== 'string' || artifact.svg !== undefined || artifact.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(artifact.base64)) fail('INVALID_IMAGE');
    buffer = Buffer.from(artifact.base64, 'base64');
    if (buffer.toString('base64') !== artifact.base64) fail('INVALID_IMAGE');
  }
  if (artifact.bytes !== buffer.length) fail('INVALID_IMAGE');
  return buffer;
}
async function saveNewFile(path, buffer) {
  let file;
  try {
    file = await open(path, 'wx', 0o600);
    await file.writeFile(buffer);
  } catch (error) {
    if (file) { await file.close(); file = undefined; await unlink(path).catch(() => {}); }
    fail(error.code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'OUTPUT_WRITE_FAILED');
  } finally { await file?.close(); }
}
async function run() {
  const [command, input, output, ...extra] = process.argv.slice(2);
  if (extra.length || (command === 'capabilities' ? input !== undefined : !['chart', 'render', 'generate'].includes(command) || !input || !output)) fail('USAGE');
  const base = origin(), controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout());
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    if (command === 'capabilities') {
      const result = await fetchResponse(base, '/v1/capabilities', controller.signal, undefined, 1024 * 1024);
      if (result.mimeType !== 'application/json') fail('UNEXPECTED_CONTENT_TYPE');
      const capabilities = json(result.buffer);
      if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) fail('INVALID_RESPONSE');
      console.log(JSON.stringify(capabilities));
      return;
    }
    const format = extname(output).slice(1).toLowerCase();
    if (!['png', 'svg'].includes(format)) fail('INVALID_OUTPUT_EXTENSION');
    try { await lstat(output); fail('OUTPUT_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') { if (error instanceof ClientError) throw error; fail('OUTPUT_WRITE_FAILED'); } }
    const { body, request } = await readRequest(input);
    if ((request.output?.format ?? 'svg') !== format) fail('OUTPUT_FORMAT_MISMATCH');
    const path = { chart: '/v1/charts', render: '/v1/render', generate: '/v1/generate' }[command];
    const result = await fetchResponse(base, path, controller.signal, body, command === 'generate' ? JSON_LIMIT : IMAGE_LIMIT);
    const expectedMime = format === 'png' ? 'image/png' : 'image/svg+xml';
    if (result.mimeType !== (command === 'generate' ? 'application/json' : expectedMime)) fail('UNEXPECTED_CONTENT_TYPE');
    const buffer = command === 'generate' ? generationImage(json(result.buffer), format) : result.buffer;
    validateImage(buffer, format);
    controller.signal.throwIfAborted();
    await saveNewFile(output, buffer);
    console.log(JSON.stringify({ saved: resolve(output), mimeType: expectedMime, bytes: buffer.length, requestId: result.requestId }));
  } catch (error) {
    if (controller.signal.aborted) fail(timedOut ? 'TIMEOUT' : 'CANCELLED');
    if (error instanceof ClientError) throw error;
    fail('NETWORK_ERROR');
  } finally { clearTimeout(timer); process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
run().catch(error => { console.error(JSON.stringify({ error: error instanceof ClientError ? error.details : { code: 'CLIENT_ERROR' } })); process.exitCode = 1; });
