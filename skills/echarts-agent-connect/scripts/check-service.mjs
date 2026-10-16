#!/usr/bin/env node

class CheckError extends Error {
  constructor(code, details = {}) { super(code); this.details = { code, ...details }; }
}
function fail(code, details) { throw new CheckError(code, details); }
function configuration() {
  if (process.argv.length !== 2) fail('USAGE');
  let url;
  try { url = new URL(process.env.CHART_URL); } catch { fail('INVALID_CHART_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('INVALID_CHART_URL');
  const timeout = process.env.CHART_TIMEOUT_MS ?? '15000';
  if (!/^\d+$/.test(timeout) || Number(timeout) < 100 || Number(timeout) > 120000) fail('INVALID_TIMEOUT');
  return { base: url.origin, timeout: Number(timeout) };
}
function requestId(value) { return typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value) ? value : undefined; }
async function body(response, limit) {
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
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
  catch { fail('INVALID_RESPONSE'); }
}
async function get(base, path, signal, authenticated = false) {
  const headers = { accept: 'application/json' };
  if (authenticated && process.env.SERVICE_API_KEY) headers.authorization = `Bearer ${process.env.SERVICE_API_KEY}`;
  const response = await fetch(`${base}${path}`, { headers, signal, redirect: 'manual' });
  const id = requestId(response.headers.get('x-request-id'));
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); fail('REDIRECT_REJECTED', { status: response.status, requestId: id }); }
  const isJson = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() === 'application/json';
  if (!response.ok) {
    let payload;
    try { if (isJson) payload = await body(response, 65536); else await response.body?.cancel(); }
    catch { /* 只返回有限的诊断字段，远端消息可能含敏感内容。 */ }
    const known = ['UNAUTHORIZED', 'INTERNAL_ERROR', 'WORKER_UNAVAILABLE'];
    fail(known.includes(payload?.error?.code) ? payload.error.code : 'HTTP_ERROR', { status: response.status, requestId: id ?? requestId(payload?.error?.requestId) });
  }
  if (!isJson) { await response.body?.cancel(); fail('UNEXPECTED_CONTENT_TYPE'); }
  return body(response, 1024 * 1024);
}
async function run() {
  const { base, timeout } = configuration();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let stage = 'live';
  try {
    const live = await get(base, '/health/live', controller.signal);
    if (live?.status !== 'alive') fail('SERVICE_NOT_ALIVE');
    stage = 'ready';
    const ready = await get(base, '/health/ready', controller.signal);
    if (ready?.status !== 'ready') fail('RENDER_NOT_READY');
    stage = 'capabilities';
    const capabilities = await get(base, '/v1/capabilities', controller.signal, true);
    const chartTypes = ['bar', 'line', 'pie', 'scatter', 'radar', 'gauge', 'funnel', 'heatmap', 'tree', 'treemap', 'sunburst', 'sankey'];
    if (!capabilities || !Array.isArray(capabilities.chartTypes) || !Array.isArray(capabilities.formats) || !capabilities.formats.some(v => ['png', 'svg'].includes(v))) fail('INVALID_CAPABILITIES');
    const ai = ['ready', 'disabled', 'misconfigured'].includes(capabilities.ai?.status) ? capabilities.ai.status : 'unknown';
    console.log(JSON.stringify({ ok: true, live: 'alive', render: 'ready', ai, chartTypes: chartTypes.filter(v => capabilities.chartTypes.includes(v)), formats: ['svg', 'png'].filter(v => capabilities.formats.includes(v)) }));
  } catch (error) {
    if (controller.signal.aborted) fail(timedOut ? 'TIMEOUT' : 'CANCELLED', { stage });
    if (error instanceof CheckError) throw new CheckError(error.details.code, { ...error.details, stage });
    fail('NETWORK_ERROR', { stage });
  } finally { clearTimeout(timer); process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
run().catch(error => { console.error(JSON.stringify({ ok: false, error: error instanceof CheckError ? error.details : { code: 'CLIENT_ERROR' } })); process.exitCode = 1; });
