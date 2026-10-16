import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ChartService } from '../dist/service.js';
import { RenderPool } from '../dist/pool.js';
import { createServer } from '../dist/server.js';

const execute = promisify(execFile);
const key = 'synthetic-consumer-test-key';
const sample = { type: 'bar', data: [{ month: '一月', count: 12 }, { month: '二月', count: 18 }], encoding: { x: 'month', y: ['count'] } };
const raw = { option: { xAxis: { type: 'category', data: ['一月', '二月'] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: [12, 18] }] } };
let directory, chartClient, checkClient, app, service, base, plannerCalls = 0;
test.before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'echarts-consumer-'));
  chartClient = join(directory, 'chart-client.mjs');
  checkClient = join(directory, 'check-service.mjs');
  // 独立复制后的脚本没有仓库源码或 node_modules 依赖。
  await copyFile(new URL('../skills/echarts-agent-chart/scripts/chart-client.mjs', import.meta.url), chartClient);
  await copyFile(new URL('../skills/echarts-agent-connect/scripts/check-service.mjs', import.meta.url), checkClient);
  const pool = new RenderPool({ size: 1 });
  await pool.waitReady();
  service = new ChartService(pool, async () => { plannerCalls++; return { type: 'bar', encoding: { x: 'month', y: ['count'] } }; });
  app = createServer(service, { apiKey: key });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(async () => { await app?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

function environment(url = base, extra = {}) {
  return { PATH: process.env.PATH, CHART_URL: url, SERVICE_API_KEY: key, ...extra };
}
async function run(script, args = [], env = {}) {
  try {
    const result = await execute(process.execPath, [script, ...args], { cwd: directory, env: environment(base, env), timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    return { code: 0, ...result };
  } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}
async function request(name, payload) {
  const path = join(directory, `${name}.json`);
  await writeFile(path, JSON.stringify(payload));
  return path;
}
function error(result, expected) {
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stdout, '');
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.error.code, expected);
  assert.ok(!result.stderr.includes(key));
  return parsed.error;
}
async function absent(path) { await assert.rejects(stat(path), { code: 'ENOENT' }); }
async function mock(handler, use) {
  const server = httpServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { return await use(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('独立消费者脚本查询能力及健康，不以 AI 关闭或配置不全阻塞渲染', async () => {
  const capabilities = await run(chartClient, ['capabilities']);
  assert.equal(capabilities.code, 0, capabilities.stderr);
  assert.ok(JSON.parse(capabilities.stdout).chartTypes.includes('bar'));
  for (const status of ['disabled', 'misconfigured', 'ready']) {
    service.aiStatus = status;
    const checked = await run(checkClient);
    assert.equal(checked.code, 0, checked.stderr);
    const report = JSON.parse(checked.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.render, 'ready');
    assert.equal(report.ai, status);
  }
});

test('ChartSpec 和原始 option 保存真实 PNG/SVG，并且不覆盖已有文件', async () => {
  const png = join(directory, 'chart.png');
  const input = await request('chart-png', { spec: sample, output: { format: 'png', width: 480, height: 300 } });
  const rendered = await run(chartClient, ['chart', input, png]);
  assert.equal(rendered.code, 0, rendered.stderr);
  const metadata = await sharp(await readFile(png)).metadata();
  assert.equal(metadata.width, 480);
  assert.equal(metadata.height, 300);
  assert.equal(JSON.parse(rendered.stdout).mimeType, 'image/png');
  assert.ok(!rendered.stdout.includes('base64'));
  const original = await readFile(png);
  error(await run(chartClient, ['chart', input, png]), 'OUTPUT_EXISTS');
  assert.deepEqual(await readFile(png), original);
  const svg = join(directory, 'raw.svg');
  const rawInput = await request('raw-svg', raw);
  const result = await run(chartClient, ['render', rawInput, svg]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(await readFile(svg, 'utf8'), /^<svg/);
  assert.match(await readFile(svg, 'utf8'), /一月/);
});

test('generate 用本地 mock planner 解码 artifact，分别保存 PNG/SVG', async () => {
  for (const format of ['png', 'svg']) {
    const input = await request(`generate-${format}`, { data: sample.data, intent: '月度数量比较', output: { format, width: 480, height: 300 } });
    const output = join(directory, `generated.${format}`);
    const result = await run(chartClient, ['generate', input, output]);
    assert.equal(result.code, 0, result.stderr);
    if (format === 'png') assert.equal((await sharp(await readFile(output)).metadata()).width, 480);
    else assert.match(await readFile(output, 'utf8'), /^<svg/);
    assert.ok(!result.stdout.includes('月度数量比较'));
  }
  assert.equal(plannerCalls, 2);
});

test('鉴权和合同错误保留安全状态，不保存错误响应', async () => {
  const unauth = error(await run(chartClient, ['capabilities'], { SERVICE_API_KEY: 'wrong' }), 'UNAUTHORIZED');
  assert.equal(unauth.status, 401);
  assert.match(unauth.requestId, /^[\da-f-]{36}$/);
  const denied = error(await run(checkClient, [], { SERVICE_API_KEY: 'wrong' }), 'UNAUTHORIZED');
  assert.equal(denied.stage, 'capabilities');
  const input = await request('invalid-chart', { spec: { ...sample, data: [] } });
  const output = join(directory, 'invalid.svg');
  const invalid = error(await run(chartClient, ['chart', input, output]), 'INVALID_INPUT');
  assert.equal(invalid.status, 422);
  await absent(output);
});

test('拒绝非 origin 地址、格式不一致和超限文件，网络请求前失败', async () => {
  let calls = 0;
  await mock((_request, response) => { calls++; response.end('{}'); }, async url => {
    for (const invalid of [`${url}/mcp`, `${url}?key=private`, `${url}#fragment`, url.replace('http://', 'http://private:password@'), 'file:///tmp/example']) {
      for (const script of [chartClient, checkClient]) error(await run(script, script === chartClient ? ['capabilities'] : [], { CHART_URL: invalid }), 'INVALID_CHART_URL');
    }
    const input = await request('wrong-extension', { spec: sample });
    error(await run(chartClient, ['chart', input, join(directory, 'mismatch.png')], { CHART_URL: url }), 'OUTPUT_FORMAT_MISMATCH');
    const huge = join(directory, 'huge.json');
    await writeFile(huge, ' '.repeat(1024 * 1024 + 1));
    error(await run(chartClient, ['chart', huge, join(directory, 'huge.svg')], { CHART_URL: url }), 'REQUEST_TOO_LARGE');
    assert.equal(calls, 0);
  });
});

test('拒绝重定向且不向目标转发认证，错误报文不回显', async () => {
  let destinationCalls = 0, sourceCalls = 0;
  await mock((_request, response) => { destinationCalls++; response.end('{}'); }, async destination => {
    await mock((_request, response) => { sourceCalls++; response.writeHead(307, { location: destination }).end(); }, async url => {
      for (const script of [chartClient, checkClient]) error(await run(script, script === chartClient ? ['capabilities'] : [], { CHART_URL: url }), 'REDIRECT_REJECTED');
    });
  });
  assert.equal(sourceCalls, 2);
  assert.equal(destinationCalls, 0);
  await mock((_request, response) => response.writeHead(422, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: `PRIVATE_${key}`, message: `https://private.example/${key}`, requestId: key } })), async url => {
    const result = await run(chartClient, ['capabilities'], { CHART_URL: url });
    const details = error(result, 'HTTP_ERROR');
    assert.equal(details.status, 422);
    assert.equal(details.requestId, undefined);
    assert.ok(!result.stderr.includes('private.example'));
  });
});

test('错误 MIME、损坏图片、损坏生成 artifact 和响应超限不创建输出', async () => {
  const input = await request('bad-response', { spec: sample, output: { format: 'png' } });
  const scenarios = [
    { type: 'text/html', body: '<html>private upstream error</html>', expected: 'UNEXPECTED_CONTENT_TYPE' },
    { type: 'image/png', body: 'not a PNG', expected: 'INVALID_IMAGE' },
    { type: 'image/png', body: Buffer.alloc(10 * 1024 * 1024 + 1), expected: 'RESPONSE_TOO_LARGE' },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const output = join(directory, `malformed-${index}.png`);
    await mock((_request, response) => { response.writeHead(200, { 'content-type': scenario.type }); response.write(scenario.body); response.end(); }, async url => {
      error(await run(chartClient, ['chart', input, output], { CHART_URL: url }), scenario.expected);
      await absent(output);
    });
  }
  const generated = join(directory, 'bad-artifact.png');
  await mock((_request, response) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ artifact: { mimeType: 'image/png', base64: 'not base64', bytes: 4 } })), async url => {
    error(await run(chartClient, ['generate', input, generated], { CHART_URL: url }), 'INVALID_IMAGE');
    await absent(generated);
  });
  await mock((_request, response) => response.writeHead(200, { 'content-type': 'application/json' }).end('{broken'), async url => {
    error(await run(chartClient, ['capabilities'], { CHART_URL: url }), 'INVALID_RESPONSE');
    error(await run(checkClient, [], { CHART_URL: url }), 'INVALID_RESPONSE');
  });
});

test('总超时中止流式响应，没有隐式重试或残留图片', async () => {
  let calls = 0;
  const input = await request('timeout', { spec: sample });
  const output = join(directory, 'timeout.svg');
  await mock((_request, response) => { calls++; response.writeHead(200, { 'content-type': 'image/svg+xml' }); response.write('<svg>'); }, async url => {
    error(await run(chartClient, ['chart', input, output], { CHART_URL: url, CHART_TIMEOUT_MS: '100' }), 'TIMEOUT');
    await absent(output);
  });
  assert.equal(calls, 1);
  await mock(() => { calls++; }, async url => {
    error(await run(checkClient, [], { CHART_URL: url, CHART_TIMEOUT_MS: '100' }), 'TIMEOUT');
  });
  assert.equal(calls, 2);
});

test('SIGINT 取消在途请求并返回有限诊断', async () => {
  const input = await request('cancel', { spec: sample });
  const output = join(directory, 'cancel.svg');
  let child;
  await mock(() => child.kill('SIGINT'), async url => {
    child = spawn(process.execPath, [chartClient, 'chart', input, output], { cwd: directory, env: environment(url), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'close');
    error({ code, stdout, stderr }, 'CANCELLED');
    await absent(output);
  });
});
