import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
import sharp from 'sharp';
import { SendMessageRequest, GetTaskRequest, CancelTaskRequest, Task, TaskState } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory, DefaultAgentCardResolver } from '@a2a-js/sdk/client';
import { ClientFactory as LegacyClientFactory, JsonRpcTransportFactory as LegacyJsonRpcTransportFactory, DefaultAgentCardResolver as LegacyAgentCardResolver } from '@a2a-js/sdk-v0_3/client';
import { ChartService } from '../dist/service.js';
import { RenderPool } from '../dist/pool.js';
import { createServer } from '../dist/server.js';
import { EphemeralTaskStore } from '../dist/a2a.js';
import { extendedSamples } from '../examples/extended/samples.mjs';

const spec = { type: 'bar', data: [{ name: '甲', value: 12 }, { name: '乙', value: 18 }], encoding: { x: 'name', y: ['value'] } };
const chartInput = (format = 'svg') => ({ operation: 'chart', request: { spec, output: { format } } });
const wireMessage = data => ({ message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data }] } });
const legacyMessage = data => ({ message: { kind: 'message', messageId: randomUUID(), role: 'user', parts: [{ kind: 'data', data }] } });
const message = data => SendMessageRequest.fromJSON(wireMessage(data));
const getTask = id => GetTaskRequest.fromJSON({ id, historyLength: 0 });
const cancelTask = id => CancelTaskRequest.fromJSON({ id });
const storedTask = state => Task.fromJSON({ id: randomUUID(), contextId: randomUUID(), status: { state } });
let app, client, legacyClient, base;
let cancelled = 0;

async function rpc(method, params, { version = '1.0', authorization = 'Bearer a2a-test', id = randomUUID() } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (version !== null) headers['A2A-Version'] = version;
  if (authorization !== null) headers.authorization = authorization;
  const response = await fetch(`${base}/a2a`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  return { response, body: await response.json() };
}

test.before(async () => {
  const probe = httpServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  const pool = new RenderPool({ size: 1 });
  await pool.waitReady();
  const service = new ChartService(pool, async (request, _feedback, signal) => {
    if (request.intent === '等待取消') await new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      cancelled++;
      reject(new Error('cancelled'));
    }, { once: true }));
    return { type: 'bar', encoding: { x: 'name', y: ['value'] } };
  });
  app = createServer(service, { apiKey: 'a2a-test', a2aPublicUrl: base });
  await app.listen({ port, host: '127.0.0.1' });
  const fetchImpl = (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', 'Bearer a2a-test');
    return fetch(url, { ...init, headers });
  };
  client = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })], cardResolver: new DefaultAgentCardResolver({ fetchImpl }) }).createFromUrl(base);
  legacyClient = await new LegacyClientFactory({ transports: [new LegacyJsonRpcTransportFactory({ fetchImpl })], cardResolver: new LegacyAgentCardResolver({ fetchImpl }) }).createFromUrl(base);
});

test.after(async () => { await app?.close(); });

test('A2A 版本协商提供 1.0 和兼容 0.3 的发现卡片', async () => {
  for (const version of [null, '0.3', '1.0']) {
    const headers = { authorization: 'Bearer a2a-test' };
    if (version) headers['A2A-Version'] = version;
    const response = await fetch(`${base}/.well-known/agent-card.json`, { headers });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('vary'), /(?:^|,\s*)A2A-Version(?:,|$)/i);
    const card = await response.json();
    assert.equal(card.capabilities?.streaming ?? false, false);
    assert.equal(card.capabilities?.pushNotifications ?? false, false);
    if (version === '1.0') {
      assert.ok(card.supportedInterfaces.some(value => value.protocolVersion === '1.0' && value.protocolBinding === 'JSONRPC' && value.url === `${base}/a2a`));
      assert.equal(card.protocolVersion, undefined);
      assert.equal(card.url, undefined);
      assert.equal(card.securitySchemes.bearerAuth.httpAuthSecurityScheme.scheme, 'bearer');
      assert.deepEqual(Object.keys(card.securityRequirements[0].schemes), ['bearerAuth']);
      assert.deepEqual(card.securityRequirements[0].schemes.bearerAuth.list ?? [], []);
    } else {
      assert.equal(card.protocolVersion, '0.3.0');
      assert.equal(card.url, `${base}/a2a`);
      assert.equal(card.securitySchemes.bearerAuth.type, 'http');
      assert.deepEqual(card.security, [{ bearerAuth: [] }]);
    }
  }
});

test('A2A 1.0 SDK 发现、图像 artifact 和跨版本 task 获取', async () => {
  for (const format of ['svg', 'png']) {
    const task = await client.sendMessage(message(chartInput(format)));
    assert.equal(task.status.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(task.kind, undefined);
    const part = task.artifacts[0].parts[0];
    assert.equal(part.content.$case, 'raw');
    assert.equal(part.mediaType, format === 'svg' ? 'image/svg+xml' : 'image/png');
    assert.equal(part.filename, `chart.${format}`);
    const bytes = Buffer.from(part.content.value);
    if (format === 'svg') assert.match(bytes.toString(), /<svg/);
    else assert.equal((await sharp(bytes).metadata()).width, 960);
    const stored = await client.getTask(getTask(task.id));
    assert.equal(stored.status.state, TaskState.TASK_STATE_COMPLETED);
    assert.deepEqual(stored.history, []);
    const legacy = await legacyClient.getTask({ id: task.id, historyLength: 0 });
    assert.equal(legacy.kind, 'task');
    assert.equal(legacy.status.state, 'completed');
    assert.equal(legacy.artifacts[0].parts[0].kind, 'file');
    assert.deepEqual(Buffer.from(legacy.artifacts[0].parts[0].file.bytes, 'base64'), bytes);
  }
});

test('真实 A2A 0.3 SDK 保持图像交付且任务可由 1.0 获取', async () => {
  for (const format of ['svg', 'png']) {
    const task = await legacyClient.sendMessage(legacyMessage(chartInput(format)));
    assert.equal(task.kind, 'task');
    assert.equal(task.status.state, 'completed');
    const bytes = Buffer.from(task.artifacts[0].parts[0].file.bytes, 'base64');
    if (format === 'svg') assert.match(bytes.toString(), /<svg/);
    else assert.equal((await sharp(bytes).metadata()).width, 960);
    const stored = await client.getTask(getTask(task.id));
    assert.equal(stored.status.state, TaskState.TASK_STATE_COMPLETED);
    assert.deepEqual(Buffer.from(stored.artifacts[0].parts[0].content.value), bytes);
    assert.deepEqual(stored.history, []);
  }
});

test('A2A 0.3 未设置 blocking 时保留阻塞行为', async () => {
  const task = await legacyClient.sendMessage({ ...legacyMessage(chartInput()), configuration: { historyLength: 0 } });
  assert.equal(task.status.state, 'completed');
  assert.equal(task.artifacts.length, 1);
});

test('A2A 1.0 wire 使用 protobuf JSON 的 task、状态和 raw 图像结构', async () => {
  const id = 'wire-render';
  const { response, body } = await rpc('SendMessage', wireMessage(chartInput()), { id });
  assert.equal(response.status, 200);
  assert.equal(body.id, id);
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.error, undefined);
  assert.equal(body.result.kind, undefined);
  const task = body.result.task;
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(task.kind, undefined);
  const part = task.artifacts[0].parts[0];
  assert.equal(part.kind, undefined);
  assert.equal(part.file, undefined);
  assert.equal(part.mediaType, 'image/svg+xml');
  assert.match(Buffer.from(part.raw, 'base64').toString(), /<svg/);
  const stored = await rpc('GetTask', { id: task.id, historyLength: 0 });
  assert.equal(stored.body.result.id, task.id);
  assert.equal(stored.body.result.status.state, 'TASK_STATE_COMPLETED');
  assert.deepEqual(stored.body.result.history ?? [], []);
  assert.equal((await rpc('CancelTask', { id: task.id })).body.error.code, -32002);
});

test('A2A 七种新增静态图表通过 1.0 SDK 交付 PNG', async () => {
  for (const spec of Object.values(extendedSamples)) {
    const task = await client.sendMessage(message({ operation: 'chart', request: { spec, output: { format: 'png' } } }));
    assert.equal(task.status.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal((await sharp(Buffer.from(task.artifacts[0].parts[0].content.value)).metadata()).width, 960);
  }
});

test('A2A 业务失败在 1.0 和 0.3 中保持结构化错误', async () => {
  const data = { operation: 'chart', request: { spec: { ...spec, encoding: { x: 'name', y: ['missing'] } } } };
  const task = await client.sendMessage(message(data));
  assert.equal(task.status.state, TaskState.TASK_STATE_FAILED);
  assert.equal(task.status.message.parts[0].content.value.error.code, 'INVALID_INPUT');
  const legacy = await legacyClient.sendMessage(legacyMessage(data));
  assert.equal(legacy.status.state, 'failed');
  assert.equal(legacy.status.message.parts[0].data.error.code, 'INVALID_INPUT');
  for (const [method, version] of [['GetTask', '1.0'], ['CancelTask', '1.0'], ['tasks/get', null], ['tasks/cancel', null]]) {
    assert.equal((await rpc(method, { id: randomUUID() }, { version })).body.error.code, -32001);
  }
});

test('A2A 发现和调用继续要求有效凭据', async () => {
  for (const version of [null, '1.0']) {
    const headers = version ? { 'A2A-Version': version } : {};
    assert.equal((await fetch(`${base}/.well-known/agent-card.json`, { headers })).status, 401);
    for (const authorization of [null, 'Bearer wrong']) {
      assert.equal((await rpc(version ? 'GetTask' : 'tasks/get', { id: randomUUID() }, { version, authorization })).response.status, 401);
    }
  }
});

test('A2A 不支持版本、错误版本与方法组合及流式或列表方法不会执行', async () => {
  const unsupportedCard = await fetch(`${base}/.well-known/agent-card.json`, { headers: { authorization: 'Bearer a2a-test', 'A2A-Version': '2.0' } });
  assert.ok(unsupportedCard.status >= 400 && unsupportedCard.status < 500);
  for (const version of ['2.0', '0.2']) {
    assert.equal((await rpc('SendMessage', wireMessage(chartInput()), { version })).body.error.code, -32009);
  }
  for (const [method, version] of [['SendMessage', null], ['SendMessage', '0.3'], ['message/send', '1.0']]) {
    assert.ok((await rpc(method, version === '1.0' ? legacyMessage(chartInput()) : wireMessage(chartInput()), { version })).body.error);
  }
  for (const [method, version] of [['SendStreamingMessage', '1.0'], ['SubscribeToTask', '1.0'], ['ListTasks', '1.0'], ['CreateTaskPushNotificationConfig', '1.0'], ['message/stream', null], ['tasks/resubscribe', null]]) {
    assert.equal((await rpc(method, {}, { version })).body.error.code, -32601);
  }
});

test('A2A 1.0 接受 protobuf 默认值及 metadata', async () => {
  const params = wireMessage(chartInput());
  Object.assign(params, { tenant: '', metadata: { caller: 'wire-test' }, configuration: { acceptedOutputModes: [], historyLength: 0, returnImmediately: false } });
  Object.assign(params.message, { contextId: '', taskId: '', extensions: [], referenceTaskIds: [], metadata: { correlation: 'fixture' } });
  params.message.role = 1;
  Object.assign(params.message.parts[0], { filename: '', mediaType: 'application/json', metadata: { source: 'fixture' } });
  const { body } = await rpc('SendMessage', params);
  assert.equal(body.error, undefined);
  assert.equal(body.result.task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal((await rpc('GetTask', { tenant: '', id: body.result.task.id, historyLength: 0 })).body.result.id, body.result.task.id);
});

test('A2A 1.0 拒绝续写、非 data 输入、历史、租户和推送配置', async () => {
  const invalid = [
    params => { params.message.parts = []; },
    params => { params.message.parts.push({ data: chartInput() }); },
    params => { params.message.parts = [{ text: '画图' }]; },
    params => { params.message.parts = [{ raw: 'dGVzdA==', mediaType: 'text/plain' }]; },
    params => { params.message.parts = [{ url: 'https://example.com/file.svg' }]; },
    params => { params.message.parts[0].text = '同时提供另一种内容'; },
    params => { params.message.parts[0].data = null; },
    params => { params.message.role = 'ROLE_AGENT'; },
    params => { params.message.messageId = ''; },
    params => { params.message.taskId = randomUUID(); },
    params => { params.message.contextId = randomUUID(); },
    params => { params.message.referenceTaskIds = [randomUUID()]; },
    params => { params.message.extensions = ['https://example.com/extension']; },
    params => { params.tenant = 'another-tenant'; },
    params => { params.configuration = { historyLength: 1 }; },
    params => { params.configuration = { taskPushNotificationConfig: { pushNotificationConfig: { url: 'https://example.com/callback' } } }; },
    params => { params.configuration = { blocking: false }; },
    params => { params.unrecognized = true; },
  ];
  for (const mutate of invalid) {
    const params = wireMessage(chartInput());
    mutate(params);
    assert.equal((await rpc('SendMessage', params)).body.error?.code, -32602, JSON.stringify(params));
  }
  for (const method of ['GetTask', 'CancelTask']) {
    assert.equal((await rpc(method, { id: randomUUID(), tenant: 'another-tenant' })).body.error.code, -32602);
    assert.equal((await rpc(method, { id: 'not-a-task-id' })).body.error.code, -32602);
  }
  assert.equal((await rpc('GetTask', { id: randomUUID(), historyLength: 1 })).body.error.code, -32602);
});

test('A2A 0.3 保持严格输入边界', async () => {
  for (const mutate of [
    params => { params.message.parts = [{ kind: 'file', file: { bytes: 'dGVzdA==' } }]; },
    params => { params.message.taskId = randomUUID(); },
    params => { params.configuration = { historyLength: 1 }; },
    params => { params.configuration = { pushNotificationConfig: { url: 'https://example.com/callback' } }; },
    params => { params.configuration = { returnImmediately: true }; },
  ]) {
    const params = legacyMessage(chartInput());
    mutate(params);
    assert.equal((await rpc('message/send', params, { version: null })).body.error.code, -32602);
  }
});

test('A2A 1.0 非阻塞提交可由 0.3 取消，下游中止并保持终态', { timeout: 10_000 }, async () => {
  const before = cancelled;
  const params = SendMessageRequest.fromJSON({ ...wireMessage({ operation: 'generate', request: { data: spec.data, intent: '等待取消' } }), configuration: { returnImmediately: true } });
  const task = await client.sendMessage(params);
  assert.equal(task.status.state, TaskState.TASK_STATE_WORKING);
  const cancel = await legacyClient.cancelTask({ id: task.id });
  assert.equal(cancel.status.state, 'canceled');
  assert.equal(cancelled, before + 1);
  assert.equal((await client.getTask(getTask(task.id))).status.state, TaskState.TASK_STATE_CANCELED);
  const repeated = await rpc('CancelTask', { id: task.id, metadata: { reason: 'retry' } });
  assert.equal(repeated.body.result.status.state, 'TASK_STATE_CANCELED');
  assert.equal(cancelled, before + 1);
});

test('A2A 0.3 非阻塞任务可由 1.0 取消', { timeout: 10_000 }, async () => {
  const before = cancelled;
  const task = await legacyClient.sendMessage({ ...legacyMessage({ operation: 'generate', request: { data: spec.data, intent: '等待取消' } }), configuration: { blocking: false } });
  assert.equal(task.status.state, 'working');
  const cancel = await client.cancelTask(cancelTask(task.id));
  assert.equal(cancel.status.state, TaskState.TASK_STATE_CANCELED);
  assert.equal(cancelled, before + 1);
  assert.equal((await legacyClient.getTask({ id: task.id })).status.state, 'canceled');
});

test('A2A 双版本阻塞与非阻塞请求共享四个任务名额', { timeout: 15_000 }, async () => {
  let completeBlocking, notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"/>';
  const artifact = { requestId: 'fixture', mimeType: 'image/svg+xml', width: 960, height: 540, bytes: Buffer.byteLength(svg), svg };
  const pool = {
    render: async (_request, signal) => new Promise((resolve, reject) => {
      completeBlocking ??= resolve;
      notifyStarted();
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }),
    close: async () => {},
  };
  const local = createServer(new ChartService(pool), { apiKey: 'a2a-test', a2aPublicUrl: 'http://a2a.test' });
  const call = async (method, params, version = '1.0') => (await local.inject({ method: 'POST', url: '/a2a', headers: { authorization: 'Bearer a2a-test', 'A2A-Version': version }, payload: { jsonrpc: '2.0', id: randomUUID(), method, params } })).json();
  const tasks = [];
  let blockingSettled = false;
  const blocking = call('SendMessage', wireMessage(chartInput())).then(result => { blockingSettled = true; return result; });
  try {
    await started;
    for (let index = 0; index < 3; index++) {
      const legacy = index % 2 === 0;
      const result = legacy
        ? await call('message/send', { ...legacyMessage(chartInput()), configuration: { blocking: false } }, '0.3')
        : await call('SendMessage', { ...wireMessage(chartInput()), configuration: { returnImmediately: true } });
      assert.equal(result.error, undefined);
      const task = legacy ? result.result : result.result.task;
      assert.equal(task.status.state, legacy ? 'working' : 'TASK_STATE_WORKING');
      tasks.push(task.id);
    }
    assert.equal(blockingSettled, false);
    assert.equal((await call('SendMessage', wireMessage(chartInput()))).error.code, -32000);
    assert.equal((await call('message/send', legacyMessage(chartInput()), '0.3')).error.code, -32000);
    completeBlocking(artifact);
    assert.equal((await blocking).result.task.status.state, 'TASK_STATE_COMPLETED');
    const replacement = await call('message/send', { ...legacyMessage(chartInput()), configuration: { blocking: false } }, '0.3');
    assert.equal(replacement.result.status.state, 'working');
    tasks.push(replacement.result.id);
    assert.equal((await call('SendMessage', wireMessage(chartInput()))).error.code, -32000);
    assert.equal((await call('CancelTask', { id: tasks.shift() })).result.status.state, 'TASK_STATE_CANCELED');
    const afterCancel = await call('SendMessage', { ...wireMessage(chartInput()), configuration: { returnImmediately: true } });
    assert.equal(afterCancel.result.task.status.state, 'TASK_STATE_WORKING');
    tasks.push(afterCancel.result.task.id);
  } finally {
    completeBlocking?.(artifact);
    await blocking;
    await Promise.all(tasks.map(id => call('CancelTask', { id })));
    await local.close();
  }
});

test('A2A 终态过期、活动任务保留且重启不保留数据', async () => {
  const store = new EphemeralTaskStore(5);
  const completed = storedTask('TASK_STATE_COMPLETED');
  completed.history = [message(chartInput()).message];
  const working = storedTask('TASK_STATE_WORKING');
  await store.save(completed);
  await store.save(working);
  assert.deepEqual((await store.load(completed.id)).history, []);
  const copy = await store.load(working.id);
  copy.status.state = TaskState.TASK_STATE_COMPLETED;
  assert.equal((await store.load(working.id)).status.state, TaskState.TASK_STATE_WORKING);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await store.load(completed.id), undefined);
  assert.equal((await store.load(working.id)).status.state, TaskState.TASK_STATE_WORKING);
  assert.equal(await new EphemeralTaskStore().load(working.id), undefined);
  store.clear();
  assert.equal(await store.load(working.id), undefined);
});

test('A2A 内存容量优先逐出终态，拒绝超大任务和活动任务溢出', async () => {
  const active = storedTask('TASK_STATE_WORKING');
  const completed = storedTask('TASK_STATE_COMPLETED');
  const second = storedTask('TASK_STATE_WORKING');
  const size = Math.max(...[active, completed].map(task => Buffer.byteLength(JSON.stringify(Task.toJSON(task)))));
  const store = new EphemeralTaskStore(60_000, size * 2);
  await store.save(active);
  await store.save(completed);
  await store.save(second);
  assert.equal(await store.load(completed.id), undefined);
  assert.ok(await store.load(active.id));
  assert.ok(await store.load(second.id));
  await assert.rejects(() => store.save(storedTask('TASK_STATE_WORKING')), error => error.code === 'A2A_BUSY');
  await assert.rejects(() => store.save({ ...active, metadata: { padding: 'x'.repeat(32) } }), error => error.code === 'A2A_BUSY');
  await assert.rejects(() => store.save({ ...active, metadata: { padding: 'x'.repeat(size * 3) } }), error => error.code === 'OUTPUT_TOO_LARGE');
  assert.equal((await store.load(active.id)).metadata, undefined);
  assert.ok(await store.load(second.id));
});

test('A2A 图像缓存按 base64 wire 字节计量并隔离二进制副本', async () => {
  const bytes = Buffer.alloc(1024, 255);
  const task = Task.fromJSON({ id: randomUUID(), contextId: randomUUID(), status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ artifactId: randomUUID(), parts: [{ raw: bytes.toString('base64'), mediaType: 'image/png' }] }] });
  const store = new EphemeralTaskStore(60_000, Buffer.byteLength(JSON.stringify(Task.toJSON(task))));
  await store.save(task);
  task.artifacts[0].parts[0].content.value[0] = 0;
  const copy = await store.load(task.id);
  assert.deepEqual(Buffer.from(copy.artifacts[0].parts[0].content.value), bytes);
  copy.artifacts[0].parts[0].content.value[1] = 0;
  assert.deepEqual(Buffer.from((await store.load(task.id)).artifacts[0].parts[0].content.value), bytes);
});

test('A2A 最多保留 100 个活动任务', async () => {
  const store = new EphemeralTaskStore();
  const tasks = Array.from({ length: 100 }, () => storedTask('TASK_STATE_WORKING'));
  for (const task of tasks) await store.save(task);
  await assert.rejects(() => store.save(storedTask('TASK_STATE_WORKING')), error => error.code === 'A2A_BUSY');
  assert.ok(await store.load(tasks[0].id));
  assert.ok(await store.load(tasks.at(-1).id));
});
