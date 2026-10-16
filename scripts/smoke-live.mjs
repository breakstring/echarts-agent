import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import sharp from 'sharp';
import { SendMessageRequest, GetTaskRequest, TaskState } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory, DefaultAgentCardResolver } from '@a2a-js/sdk/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RenderPool } from '../dist/pool.js';
import { ChartService } from '../dist/service.js';
import { configuredPlanner } from '../dist/llm.js';
import { createServer } from '../dist/server.js';

const directory = 'artifacts/live';
const output = { width: 960, height: 640 };
const cases = [
  { name: 'trend', data: [{ month: '一月', count: 12 }, { month: '二月', count: 18 }, { month: '三月', count: 25 }], intent: '用折线图呈现各月数量趋势，标题为“各月数量趋势”，保留原始数量', title: '各月数量趋势', type: 'line', encoding: { x: 'month', y: ['count'] }, format: 'svg' },
  { name: 'share', data: [{ category: '产品甲', amount: 40 }, { category: '产品乙', amount: 60 }], intent: '请用环形图呈现两个产品的占比，标题为“产品数量占比”，显示真实数量', title: '产品数量占比', type: 'pie', encoding: { name: 'category', value: 'amount' }, format: 'png' },
];
const evidence = [];
const testedAt = new Date().toISOString();
let app, pool;
let stage = 'configuration';
let generationRequests = 0;

async function unusedLoopbackPort() {
  const probe = createHttpServer();
  probe.listen(0, '127.0.0.1');
  try { await once(probe, 'listening'); return probe.address().port; }
  finally { await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve())); }
}

async function saveArtifact(name, format, bytes) {
  const image = await sharp(bytes).metadata();
  assert.equal(image.width, output.width);
  assert.equal(image.height, output.height);
  if (format === 'png') {
    assert.equal(image.format, 'png');
    await sharp(bytes).raw().toBuffer();
  } else assert.match(bytes.toString('utf8'), /<svg/);
  const file = `${directory}/${name}.${format}`;
  await writeFile(file, bytes);
  return { file, bytes: bytes.length, width: image.width, height: image.height, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function metadata(status) {
  return { testedAt, status, provider: process.env.LLM_PROVIDER ?? process.env.llm_provider ?? 'openai-compatible', model: process.env.LLM_MODEL ?? process.env.llm_default_model, generationRequests, results: evidence };
}

try {
  await mkdir(directory, { recursive: true });
  const config = configuredPlanner(process.env);
  assert.equal(config.status, 'ready');
  stage = 'local-server';
  pool = new RenderPool({ size: 1 });
  await pool.waitReady();
  const port = await unusedLoopbackPort();
  const base = `http://127.0.0.1:${port}`;
  const apiKey = randomUUID();
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  app = createServer(new ChartService(pool, config.planner, config.status, undefined, config.diagnostics), { apiKey, a2aPublicUrl: base });
  await app.listen({ host: '127.0.0.1', port });

  for (const item of cases) {
    stage = `HTTP-${item.name}`;
    const began = performance.now();
    generationRequests++;
    const response = await fetch(`${base}/v1/generate`, { method: 'POST', headers, body: JSON.stringify({ data: item.data, intent: item.intent, output: { ...output, format: item.format } }), signal: AbortSignal.timeout(75_000) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.spec.type, item.type);
    assert.deepEqual(body.spec.encoding, item.encoding);
    assert.deepEqual(body.spec.data, item.data);
    assert.equal(body.spec.title, item.title);
    if (item.type === 'pie') assert.equal(body.spec.donut, true);
    const artifact = body.artifact;
    const bytes = artifact.svg ? Buffer.from(artifact.svg) : Buffer.from(artifact.base64, 'base64');
    if (artifact.svg) {
      assert.ok(artifact.svg.includes(item.title));
      for (const row of item.data) assert.ok(artifact.svg.includes(row.month));
    }
    const saved = await saveArtifact(item.name, item.format, bytes);
    assert.equal(artifact.bytes, saved.bytes);
    evidence.push({ entry: 'HTTP', case: item.name, chartType: body.spec.type, encoding: body.spec.encoding, title: body.spec.title, originalDataPreserved: true, format: item.format, durationMs: Math.round(performance.now() - began), ...saved });
  }

  stage = 'MCP-generate';
  const client = new Client({ name: 'live-smoke', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'generate_chart'));
    const began = performance.now();
    generationRequests++;
    const result = await client.callTool({ name: 'generate_chart', arguments: { data: cases[0].data, intent: '使用柱状图比较各月数量，标题为“每月数量比较”，保留原始数量', output: { ...output, format: 'png' } } }, undefined, { timeout: 75_000 });
    assert.notEqual(result.isError, true);
    assert.equal(result.content[0].type, 'image');
    assert.equal(result.content[0].mimeType, 'image/png');
    assert.equal(result.structuredContent.spec.type, 'bar');
    assert.deepEqual(result.structuredContent.spec.encoding, cases[0].encoding);
    assert.deepEqual(result.structuredContent.spec.data, cases[0].data);
    assert.equal(result.structuredContent.spec.title, '每月数量比较');
    const saved = await saveArtifact('mcp', 'png', Buffer.from(result.content[0].data, 'base64'));
    assert.equal(result.structuredContent.bytes, saved.bytes);
    evidence.push({ entry: 'MCP', chartType: result.structuredContent.spec.type, encoding: result.structuredContent.spec.encoding, title: result.structuredContent.spec.title, originalDataPreserved: true, format: 'png', durationMs: Math.round(performance.now() - began), ...saved });
  } finally { await client.close(); }

  stage = 'A2A-generate';
  const fetchImpl = (url, init) => {
    const requestHeaders = new Headers(init?.headers);
    requestHeaders.set('authorization', `Bearer ${apiKey}`);
    return fetch(url, { ...init, headers: requestHeaders, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(75_000)]) : AbortSignal.timeout(75_000) });
  };
  const a2a = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })], cardResolver: new DefaultAgentCardResolver({ fetchImpl }) }).createFromUrl(base);
  assert.equal(a2a.protocolVersion, '1.0');
  const began = performance.now();
  generationRequests++;
  const task = await a2a.sendMessage(SendMessageRequest.fromJSON({
    message: { role: 'ROLE_USER', messageId: randomUUID(), parts: [{ data: { operation: 'generate', request: { data: cases[0].data, intent: '用柱状图比较各月数量，标题为“A2A各月数量”，保留原始数量', output: { ...output, format: 'png' } } } }] },
    configuration: { returnImmediately: false, historyLength: 0 },
  }));
  assert.equal(task.status?.state, TaskState.TASK_STATE_COMPLETED);
  const part = task.artifacts[0]?.parts[0];
  assert.equal(part?.content?.$case, 'raw');
  assert.equal(part.mediaType, 'image/png');
  assert.equal(part.filename, 'chart.png');
  const bytes = Buffer.from(part.content.value);
  const saved = await saveArtifact('a2a', 'png', bytes);
  assert.equal(task.artifacts[0].metadata.width, saved.width);
  assert.equal(task.artifacts[0].metadata.height, saved.height);
  assert.equal(task.artifacts[0].metadata.bytes, saved.bytes);
  stage = 'A2A-getTask';
  const stored = await a2a.getTask(GetTaskRequest.fromJSON({ id: task.id, historyLength: 0 }));
  assert.equal(stored.id, task.id);
  assert.equal(stored.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.deepEqual(stored.history, []);
  assert.equal(stored.artifacts[0]?.parts[0]?.content?.$case, 'raw');
  assert.deepEqual(Buffer.from(stored.artifacts[0].parts[0].content.value), bytes);
  evidence.push({ entry: 'A2A', protocolVersion: a2a.protocolVersion, operation: 'generate', requestedChartType: 'bar', requestedTitle: 'A2A各月数量', taskId: task.id, state: 'completed', getTaskReadback: true, format: 'png', durationMs: Math.round(performance.now() - began), ...saved });

  stage = 'save-evidence';
  await writeFile(`${directory}/evidence.json`, JSON.stringify(metadata('passed'), null, 2));
  console.log(JSON.stringify({ live: 'passed', ...metadata('passed') }));
} catch (error) {
  const name = ['AssertionError', 'TypeError', 'AbortError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error';
  const failure = { live: 'failed', stage, name, message: '实测未通过；请检查脱敏诊断日志及 evidence.json 中已完成的检查' };
  await writeFile(`${directory}/evidence.json`, JSON.stringify({ ...metadata('failed'), failure }, null, 2)).catch(() => {});
  console.error(JSON.stringify(failure));
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  else if (pool) await pool.close();
}
