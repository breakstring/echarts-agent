import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { inspect } from 'node:util';
import { ChartService } from '../dist/service.js';
import { configuredPlanner } from '../dist/llm.js';
import { createDiagnostics } from '../dist/diagnostics.js';
import { ModelOutputError } from '../dist/errors.js';

const privateMarker = 'private-sensitive-marker';
const request = { data: [{ name: `甲-${privateMarker}`, value: 12 }], intent: `数量比较 ${privateMarker}` };
const validPlan = { type: 'bar', title: '数量比较', encoding: { x: 'name', y: ['value'] } };
const artifact = { svg: '<svg/>', mimeType: 'image/svg+xml', width: 960, height: 540, bytes: 6 };
const pool = { render: async () => artifact };

async function withUpstream(responses, run) {
  const bodies = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    bodies.push(body);
    const response = responses[Math.min(bodies.length - 1, responses.length - 1)];
    if (response.disconnect) { res.destroy(); return; }
    if (response.status) {
      res.writeHead(response.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: privateMarker, type: 'provider_error' } }));
      return;
    }
    const content = response.content ?? JSON.stringify(validPlan);
    const finishReason = response.finishReason ?? 'stop';
    const base = { id: 'local-completion', created: 1, model: 'test' };
    const usage = { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168, completion_tokens_details: { reasoning_tokens: 0 } };
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = choices => ({ ...base, object: 'chat.completion.chunk', choices });
      res.write(`data: ${JSON.stringify(chunk([{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk([{ index: 0, delta: {}, finish_reason: finishReason }]))}\n\n`);
      res.write(`data: ${JSON.stringify({ ...chunk([]), usage })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }], usage }));
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  try {
    await run({ bodies, env: { LLM_API_KEY: `local-key-${privateMarker}`, LLM_MODEL: 'test', LLM_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1` } });
  } finally {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
}

function captureLogs(t, level = 'debug', onEvent) {
  const lines = [];
  const consoleLines = [];
  const stderrLines = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, method, (...args) => { consoleLines.push(args.map(value => inspect(value)).join(' ')); });
  }
  t.mock.method(process.stderr, 'write', (chunk, encoding, callback) => {
    stderrLines.push(String(chunk));
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) done();
    return true;
  });
  const diagnostics = createDiagnostics(level, line => {
    lines.push(line);
    onEvent?.(JSON.parse(line));
  });
  return { diagnostics, events: () => lines.map(line => JSON.parse(line)), assertPrivate: () => assert.ok(![...lines, ...consoleLines, ...stderrLines].join('\n').includes(privateMarker), '诊断、console 和 stderr 不得泄露请求、凭据或上游正文') };
}

function assertWireFormat(bodies) {
  for (const body of bodies) {
    assert.equal(body.enable_thinking, false);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    const system = body.messages.filter(message => message.role === 'system').map(message => JSON.stringify(message.content)).join('\n');
    assert.match(system, /json/i);
    assert.match(system, /"?encoding/);
    assert.match(system, /required/);
    assert.equal(body.model, 'test');
  }
  if (bodies.length > 1) {
    const firstPrompt = JSON.parse(bodies[0].messages.findLast(message => message.role === 'user').content);
    const correctionPrompt = JSON.parse(bodies[1].messages.findLast(message => message.role === 'user').content);
    assert.equal(firstPrompt.correction, undefined);
    assert.match(correctionPrompt.correction, /JSON/);
    assert.ok(!correctionPrompt.correction.includes(privateMarker));
  }
}

function assertCorrelated(events) {
  assert.ok(events.length > 0);
  assert.equal(new Set(events.map(event => event.generationId)).size, 1);
  assert.match(events[0].generationId, /^[\da-f-]{36}$/i);
  for (const event of events.filter(event => ['model_completed', 'model_failed', 'generation_completed', 'generation_failed'].includes(event.event))) {
    assert.ok(Number.isFinite(event.durationMs) && event.durationMs >= 0, `${event.event} 需要有效耗时`);
  }
}

for (const [name, content, reason] of [
  ['非法 JSON', `not-json-${privateMarker}`, 'invalid_output'],
  ['缺少必填字段', JSON.stringify({ type: 'bar', title: privateMarker }), 'invalid_output'],
  ['额外 data', JSON.stringify({ ...validPlan, data: [{ name: privateMarker, value: 999 }] }), 'invalid_output'],
  ['未知字段映射', JSON.stringify({ ...validPlan, encoding: { x: 'name', y: ['invented'] } }), 'invalid_plan'],
]) {
  test(`真实模型适配器 ${name} 后有限纠错，保持 JSON object 与关闭思考`, async t => {
    const logs = captureLogs(t);
    await withUpstream([{ content }, {}], async ({ bodies, env }) => {
      const configured = configuredPlanner(env, logs.diagnostics);
      assert.equal(configured.status, 'ready');
      assert.equal(typeof configured.diagnostics, 'function');
      let renders = 0;
      const service = new ChartService({ render: async () => { renders++; return artifact; } }, configured.planner, configured.status, 10_000, configured.diagnostics);
      const result = await service.generate(request);
      assert.equal(bodies.length, 2);
      assert.equal(renders, 1);
      assert.deepEqual(result.spec.data, request.data);
      assert.deepEqual(result.option.series[0].data, [12]);
      assertWireFormat(bodies);
      const events = logs.events();
      assertCorrelated(events);
      assert.deepEqual(events.filter(event => event.event === 'model_started').map(event => event.attempt), [1, 2]);
      assert.ok(events.some(event => event.event === 'plan_rejected' && event.attempt === 1 && event.reason === reason && event.retry === true));
      const success = events.find(event => event.event === 'model_completed' && event.attempt === 2);
      assert.equal(success.inputTokens, 123);
      assert.equal(success.outputTokens, 45);
      assert.equal(success.finishReason, 'stop');
      assert.equal(events.filter(event => event.event === 'generation_completed').length, 1);
      assert.equal(events.filter(event => event.event === 'generation_failed').length, 0);
    });
    logs.assertPrivate();
  });
}

test('持续坏输出最多两次，不渲染且错误和日志均不含上游正文', async t => {
  const logs = captureLogs(t);
  await withUpstream([{ content: `not-json-${privateMarker}` }], async ({ bodies, env }) => {
    const { planner, status, diagnostics } = configuredPlanner(env, logs.diagnostics);
    let renders = 0;
    const service = new ChartService({ render: async () => { renders++; return artifact; } }, planner, status, 10_000, diagnostics);
    await assert.rejects(() => service.generate(request), error => error.code === 'AI_INVALID_PLAN' && !inspect(error).includes(privateMarker));
    assert.equal(bodies.length, 2);
    assert.equal(renders, 0);
    assertWireFormat(bodies);
    const events = logs.events();
    assertCorrelated(events);
    assert.deepEqual(events.filter(event => event.event === 'plan_rejected').map(event => event.retry), [true, false]);
    assert.equal(events.filter(event => event.event === 'generation_failed').length, 1);
  });
  logs.assertPrivate();
});

test('格式纠错与语义纠错共享两次总调用上限', async t => {
  const logs = captureLogs(t);
  await withUpstream([{ content: 'invalid-json' }, { content: JSON.stringify({ ...validPlan, encoding: { x: 'name', y: ['missing'] } }) }], async ({ bodies, env }) => {
    const { planner, status, diagnostics } = configuredPlanner(env, logs.diagnostics);
    const service = new ChartService({ render: async () => assert.fail('无有效计划不得渲染') }, planner, status, 10_000, diagnostics);
    await assert.rejects(() => service.generate(request), { code: 'AI_INVALID_PLAN' });
    assert.equal(bodies.length, 2);
  });
});

for (const statusCode of [401, 503]) {
  test(`真实模型适配器 HTTP ${statusCode} 不重试或暴露上游报文`, async t => {
    const logs = captureLogs(t);
    await withUpstream([{ status: statusCode }], async ({ bodies, env }) => {
      const { planner, status, diagnostics } = configuredPlanner(env, logs.diagnostics);
      const service = new ChartService({ render: async () => assert.fail('上游失败不得渲染') }, planner, status, 10_000, diagnostics);
      await assert.rejects(() => service.generate(request), error => error.code === 'AI_FAILED' && !inspect(error).includes(privateMarker));
      assert.equal(bodies.length, 1);
      assertWireFormat(bodies);
      const events = logs.events();
      assertCorrelated(events);
      assert.equal(events.filter(event => event.event === 'model_started').length, 1);
      assert.ok(events.some(event => event.event === 'model_failed' && event.reason === 'upstream' && event.upstreamStatus === statusCode));
      assert.equal(events.filter(event => event.event === 'generation_failed').length, 1);
      assert.equal(events.filter(event => event.event === 'plan_rejected').length, 0);
    });
    logs.assertPrivate();
  });
}

test('真实模型适配器连接中断不进入格式纠错', async t => {
  const logs = captureLogs(t);
  await withUpstream([{ disconnect: true }], async ({ bodies, env }) => {
    const { planner, status, diagnostics } = configuredPlanner(env, logs.diagnostics);
    const service = new ChartService(pool, planner, status, 10_000, diagnostics);
    await assert.rejects(() => service.generate(request), { code: 'AI_FAILED' });
    assert.equal(bodies.length, 1);
  });
  logs.assertPrivate();
});

test('输出达到 token 上限时使用一次格式纠错', async t => {
  const logs = captureLogs(t);
  await withUpstream([{ finishReason: 'length' }, {}], async ({ bodies, env }) => {
    const { planner, status, diagnostics } = configuredPlanner(env, logs.diagnostics);
    await new ChartService(pool, planner, status, 10_000, diagnostics).generate(request);
    assert.equal(bodies.length, 2);
    assert.ok(logs.events().some(event => event.event === 'model_completed' && event.attempt === 1 && event.finishReason === 'length'));
  });
});

test('连续达到 token 上限最多调用两次，即使 JSON 完整也不渲染', async t => {
  const logs = captureLogs(t);
  await withUpstream([{ finishReason: 'length' }], async ({ bodies, env }) => {
    const { planner, status, diagnostics } = configuredPlanner(env, logs.diagnostics);
    const service = new ChartService({ render: async () => assert.fail('被截断的输出不得渲染') }, planner, status, 10_000, diagnostics);
    await assert.rejects(() => service.generate(request), { code: 'AI_INVALID_PLAN' });
    assert.equal(bodies.length, 2);
  });
});

test('首次坏输出后取消，不发第二次模型请求', async t => {
  const controller = new AbortController();
  const logs = captureLogs(t, 'debug', event => { if (event.event === 'plan_rejected') controller.abort(); });
  await withUpstream([{ content: `invalid-json-${privateMarker}` }, {}], async ({ bodies, env }) => {
    const { planner, status, diagnostics } = configuredPlanner(env, logs.diagnostics);
    const service = new ChartService({ render: async () => assert.fail('取消后不得渲染') }, planner, status, 10_000, diagnostics);
    await assert.rejects(() => service.generate(request, controller.signal), { code: 'CANCELLED' });
    assert.equal(bodies.length, 1);
    assert.ok(logs.events().some(event => event.event === 'generation_failed' && event.reason === 'cancelled'));
  });
  logs.assertPrivate();
});

test('首次格式错误遇到总时限后不重试', async () => {
  let calls = 0;
  const planner = async (_request, _feedback, signal) => {
    calls++;
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw new ModelOutputError();
  };
  const hold = setInterval(() => {}, 1000);
  try {
    await assert.rejects(() => new ChartService(pool, planner, 'ready', 20).generate(request), { code: 'AI_TIMEOUT' });
    assert.equal(calls, 1);
  } finally { clearInterval(hold); }
});

test('诊断日志按 debug/info/off 过滤且只记录允许的元数据', () => {
  for (const [level, expected] of [['debug', ['debug', 'info', 'warn', 'error']], ['info', ['info', 'warn', 'error']], ['off', []]]) {
    const lines = [];
    const diagnostics = createDiagnostics(level, line => lines.push(line));
    for (const severity of ['debug', 'info', 'warn', 'error']) {
      diagnostics(severity, 'model_completed', { generationId: privateMarker, attempt: 1, durationMs: 1.2, finishReason: privateMarker, reason: privateMarker, entry: privateMarker, responseFormat: privateMarker, request, error: new Error(privateMarker), apiKey: privateMarker, text: privateMarker });
    }
    assert.deepEqual(lines.map(line => JSON.parse(line).level), expected);
    assert.ok(!lines.join('\n').includes(privateMarker));
    for (const event of lines.map(line => JSON.parse(line))) {
      assert.equal(event.generationId, '[redacted]');
      assert.equal(event.finishReason, 'unknown');
      assert.equal(event.request, undefined);
      assert.equal(event.error, undefined);
      assert.equal(event.reason, undefined);
    }
  }
});

test('诊断输出失败不重发模型请求或中断制图', async () => {
  const diagnostics = createDiagnostics('debug', () => { throw new Error('log sink unavailable'); });
  await withUpstream([{}], async ({ bodies, env }) => {
    const { planner, status } = configuredPlanner(env, diagnostics);
    const result = await new ChartService(pool, planner, status, 10_000, diagnostics).generate(request);
    assert.equal(bodies.length, 1);
    assert.equal(result.artifact, artifact);
  });
});

test('自定义诊断回调持续抛错不重复请求、不占住生成并发名额', async t => {
  const logs = captureLogs(t);
  const throwingDiagnostics = () => { throw new Error(privateMarker); };
  await withUpstream([{}], async ({ bodies, env }) => {
    const { planner, status } = configuredPlanner(env, throwingDiagnostics);
    const service = new ChartService(pool, planner, status, 10_000, throwingDiagnostics);
    for (let call = 1; call <= 4; call++) {
      const result = await service.generate(request);
      assert.equal(result.artifact, artifact);
      assert.equal(bodies.length, call);
    }
  });
  logs.assertPrivate();
});

test('LLM 总时限、取消和并发上限', async () => {
  let aborts = 0;
  const planner = async (_request, _feedback, signal) => new Promise((_resolve, reject) => {
    if (signal.aborted) { aborts++; reject(new Error('aborted')); }
    else signal.addEventListener('abort', () => { aborts++; reject(new Error('aborted')); }, { once: true });
  });
  const service = new ChartService(pool, planner, 'ready', 80);
  const a = service.generate(request);
  const b = service.generate(request);
  const outcomes = Promise.allSettled([a, b]);
  await assert.rejects(() => service.generate(request), { code: 'AI_BUSY' });
  // AbortSignal.timeout 不保活进程；模拟请求 socket 的存活期。
  const hold = setInterval(() => {}, 1000);
  try {
    const settled = await outcomes;
    for (const entry of settled) { assert.equal(entry.status, 'rejected'); assert.equal(entry.reason.code, 'AI_TIMEOUT'); }
    assert.equal(aborts, 2);
    const controller = new AbortController();
    const pending = service.generate(request, controller.signal);
    controller.abort();
    await assert.rejects(pending, { code: 'CANCELLED' });
    assert.equal(aborts, 3);
  } finally { clearInterval(hold); }
});
