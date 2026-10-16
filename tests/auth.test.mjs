import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
import sharp from 'sharp';
import { SendMessageRequest, GetTaskRequest, CancelTaskRequest, TaskState } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory, DefaultAgentCardResolver } from '@a2a-js/sdk/client';
import { ClientFactory as LegacyClientFactory, JsonRpcTransportFactory as LegacyJsonRpcTransportFactory, DefaultAgentCardResolver as LegacyAgentCardResolver } from '@a2a-js/sdk-v0_3/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ChartService } from '../dist/service.js';
import { RenderPool } from '../dist/pool.js';
import { createServer } from '../dist/server.js';

const apiKey = 'synthetic-auth-test-key';
const spec = { type: 'bar', data: [{ name: '甲', value: 12 }, { name: '乙', value: 18 }], encoding: { x: 'name', y: ['value'] } };
const output = { format: 'png', width: 480, height: 300 };
const generateInput = { data: spec.data, intent: '比较两个类别的数量', output };
const chartInput = { spec, output };
const rawInput = { option: { xAxis: { type: 'category', data: ['甲', '乙'] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: [12, 18] }] } };
const wireMessage = data => ({ message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data }] } });
const legacyMessage = data => ({ message: { kind: 'message', messageId: randomUUID(), role: 'user', parts: [{ kind: 'data', data }] } });

function stubService() {
  const counts = { renders: 0, plans: 0 };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const pool = { ready: true, stats: {}, close: async () => {}, render: async () => { counts.renders++; return { svg, mimeType: 'image/svg+xml', width: 960, height: 540, bytes: Buffer.byteLength(svg) }; } };
  return { counts, service: new ChartService(pool, async () => { counts.plans++; return { type: 'bar', encoding: spec.encoding }; }) };
}

const protectedRequests = [
  { method: 'GET', url: '/v1/capabilities' },
  { method: 'POST', url: '/v1/render', payload: rawInput },
  { method: 'POST', url: '/v1/charts', payload: { spec } },
  { method: 'POST', url: '/v1/generate', payload: { data: spec.data, intent: '比较数量' } },
  { method: 'GET', url: '/openapi.json' },
  { method: 'GET', url: '/.well-known/agent-card.json' },
  { method: 'GET', url: '/.well-known/agent-card.json', headers: { 'A2A-Version': '1.0' } },
  { method: 'POST', url: '/a2a', payload: { jsonrpc: '2.0', id: 'legacy-auth', method: 'tasks/get', params: { id: randomUUID() } } },
  { method: 'POST', url: '/a2a', headers: { 'A2A-Version': '1.0' }, payload: { jsonrpc: '2.0', id: 'current-auth', method: 'GetTask', params: { id: randomUUID() } } },
  { method: 'POST', url: '/mcp', headers: { accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'auth-test', version: '1' } } } },
];

function assertSecurity(document, requireAuth, version) {
  const requirements = version === '1.0' ? document.securityRequirements : document.security;
  assert.equal((requirements?.length ?? 0) > 0, requireAuth);
  const schemes = document.components?.securitySchemes ?? document.securitySchemes ?? {};
  assert.equal(Object.hasOwn(schemes, 'bearerAuth'), requireAuth);
  if (requireAuth) {
    if (version === '1.0') assert.ok(requirements[0].schemes.bearerAuth);
    else assert.deepEqual(requirements, [{ bearerAuth: [] }]);
  }
}

for (const allowAnonymous of [false, true]) {
  test(`配置 key 时三个入口统一要求 Bearer（ALLOW_ANONYMOUS=${allowAnonymous}）`, async () => {
    const { service, counts } = stubService();
    const app = createServer(service, { apiKey, allowAnonymous, a2aPublicUrl: 'http://auth.test' });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      for (const authorization of [undefined, 'Bearer wrong', 'Basic synthetic', `bearer ${apiKey}`]) {
        for (const request of protectedRequests) {
          const headers = { ...request.headers, ...(authorization ? { authorization } : {}) };
          const response = await app.inject({ ...request, headers });
          assert.equal(response.statusCode, 401, `${request.method} ${request.url}`);
          assert.equal(response.json().error.code, 'UNAUTHORIZED');
          assert.ok(!response.body.includes(apiKey));
        }
      }
      assert.deepEqual(counts, { renders: 0, plans: 0 });
      for (const request of protectedRequests) {
        if (request.url === '/mcp') {
          const response = await fetch(`http://127.0.0.1:${app.server.address().port}/mcp`, { method: 'POST', headers: { ...request.headers, 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify(request.payload) });
          assert.equal(response.status, 200);
          assert.equal((await response.json()).result.protocolVersion, '2025-11-25');
          continue;
        }
        const response = await app.inject({ ...request, headers: { ...request.headers, authorization: `Bearer ${apiKey}` } });
        assert.equal(response.statusCode, 200, `${request.method} ${request.url}`);
        if (request.url === '/openapi.json') {
          assertSecurity(response.json(), true);
          for (const path of ['/health/live', '/health/ready']) assert.deepEqual(response.json().paths[path].get.security, []);
        }
        if (request.url === '/.well-known/agent-card.json') assertSecurity(response.json(), true, request.headers?.['A2A-Version']);
      }
      assert.deepEqual(counts, { renders: 3, plans: 1 });
      for (const url of ['/health/live', '/health/ready']) {
        for (const authorization of [undefined, 'Bearer wrong']) {
          assert.equal((await app.inject({ url, headers: authorization ? { authorization } : {} })).statusCode, 200);
        }
      }
    } finally { await app.close(); }
  });
}

test('没有 key 且未显式允许匿名时拒绝启动，包括启用 A2A 的配置', () => {
  for (const apiKey of [undefined, '']) {
    for (const allowAnonymous of [undefined, false]) {
      for (const a2aPublicUrl of [undefined, 'http://auth.test']) {
        const { service } = stubService();
        assert.throws(() => createServer(service, { apiKey, allowAnonymous, a2aPublicUrl }), /SERVICE_API_KEY.*ALLOW_ANONYMOUS/);
      }
    }
  }
});

for (const authenticated of [false, true]) {
  test(`A2A 未启用时不注册 RPC 和发现路由（${authenticated ? 'Bearer' : '匿名'}模式）`, async () => {
    const { service } = stubService();
    const app = createServer(service, authenticated ? { apiKey } : { allowAnonymous: true });
    const headers = authenticated ? { authorization: `Bearer ${apiKey}` } : {};
    try {
      assert.equal((await app.inject({ url: '/.well-known/agent-card.json', headers })).statusCode, 404);
      assert.equal((await app.inject({ method: 'POST', url: '/a2a', headers, payload: {} })).statusCode, 404);
      assert.equal((await app.inject({ url: '/v1/capabilities', headers })).statusCode, 200);
    } finally { await app.close(); }
  });
}

async function assertPng(bytes) {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, output.width);
  assert.equal(info.height, output.height);
  assert.equal(data.length, info.width * info.height * info.channels);
}

async function unusedPort() {
  const probe = httpServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

test('显式匿名支持 HTTP、MCP 与两版官方 A2A SDK 的完整制图和取消', { timeout: 30_000 }, async t => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const pool = new RenderPool({ size: 1 });
  await pool.waitReady();
  let plannerCalls = 0;
  let cancelled = 0;
  const service = new ChartService(pool, async (request, _feedback, signal) => {
    plannerCalls++;
    if (request.intent === '等待匿名取消') await new Promise((_resolve, reject) => signal.addEventListener('abort', () => { cancelled++; reject(new Error('cancelled')); }, { once: true }));
    return { type: 'bar', encoding: spec.encoding };
  });
  let app;
  const mcp = new Client({ name: 'anonymous-auth-test', version: '1' });
  try {
    app = createServer(service, { apiKey: '', allowAnonymous: true, a2aPublicUrl: base });
    await app.listen({ port, host: '127.0.0.1' });
    await t.test('发现卡片和 OpenAPI 不声明不存在的 Bearer 要求', async () => {
      const openapi = await fetch(`${base}/openapi.json`);
      assert.equal(openapi.status, 200);
      assertSecurity(await openapi.json(), false);
      for (const version of [undefined, '0.3', '1.0']) {
        const response = await fetch(`${base}/.well-known/agent-card.json`, { headers: version ? { 'A2A-Version': version } : {} });
        assert.equal(response.status, 200);
        assertSecurity(await response.json(), false, version);
      }
      for (const path of ['/health/live', '/health/ready']) assert.equal((await fetch(`${base}${path}`)).status, 200);
    });
    await t.test('HTTP 无凭据生成并完整解码 PNG', async () => {
      const before = plannerCalls;
      const response = await fetch(`${base}/v1/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(generateInput) });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.deepEqual(result.spec.data, spec.data);
      await assertPng(Buffer.from(result.artifact.base64, 'base64'));
      assert.equal(plannerCalls, before + 1);
    });
    await t.test('MCP 无凭据握手、发现工具与生成 PNG', async () => {
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      assert.ok((await mcp.listTools()).tools.some(tool => tool.name === 'generate_chart'));
      const before = plannerCalls;
      const result = await mcp.callTool({ name: 'generate_chart', arguments: generateInput });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent.spec.data, spec.data);
      assert.equal(result.content[0].type, 'image');
      await assertPng(Buffer.from(result.content[0].data, 'base64'));
      assert.equal(plannerCalls, before + 1);
    });
    const noAuthFetch = (url, init) => {
      assert.equal(new Headers(init?.headers).has('authorization'), false);
      return fetch(url, init);
    };
    const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: noAuthFetch })], cardResolver: new DefaultAgentCardResolver({ fetchImpl: noAuthFetch }) }).createFromUrl(base);
    const legacy = await new LegacyClientFactory({ transports: [new LegacyJsonRpcTransportFactory({ fetchImpl: noAuthFetch })], cardResolver: new LegacyAgentCardResolver({ fetchImpl: noAuthFetch }) }).createFromUrl(base);
    for (const version of ['1.0', '0.3']) {
      await t.test(`A2A ${version} 官方 SDK 匿名 chart/generate/getTask 保持完整 PNG`, async () => {
        for (const operation of ['chart', 'generate']) {
          const before = plannerCalls;
          const input = { operation, request: operation === 'chart' ? chartInput : generateInput };
          const task = version === '1.0' ? await client.sendMessage(SendMessageRequest.fromJSON(wireMessage(input))) : await legacy.sendMessage(legacyMessage(input));
          assert.equal(task.status.state, version === '1.0' ? TaskState.TASK_STATE_COMPLETED : 'completed');
          const part = task.artifacts[0].parts[0];
          const bytes = version === '1.0' ? Buffer.from(part.content.value) : Buffer.from(part.file.bytes, 'base64');
          await assertPng(bytes);
          const stored = version === '1.0' ? await client.getTask(GetTaskRequest.fromJSON({ id: task.id, historyLength: 0 })) : await legacy.getTask({ id: task.id, historyLength: 0 });
          const storedPart = stored.artifacts[0].parts[0];
          assert.equal(stored.status.state, task.status.state);
          assert.deepEqual(version === '1.0' ? Buffer.from(storedPart.content.value) : Buffer.from(storedPart.file.bytes, 'base64'), bytes);
          assert.equal(plannerCalls, before + (operation === 'generate' ? 1 : 0));
        }
      });
    }
    await t.test('匿名非阻塞任务可跨版本取消且下游真实中止', async () => {
      const input = { operation: 'generate', request: { data: spec.data, intent: '等待匿名取消' } };
      const currentTask = await client.sendMessage(SendMessageRequest.fromJSON({ ...wireMessage(input), configuration: { returnImmediately: true } }));
      assert.equal(currentTask.status.state, TaskState.TASK_STATE_WORKING);
      assert.equal((await legacy.cancelTask({ id: currentTask.id })).status.state, 'canceled');
      assert.equal((await client.getTask(GetTaskRequest.fromJSON({ id: currentTask.id }))).status.state, TaskState.TASK_STATE_CANCELED);
      const legacyTask = await legacy.sendMessage({ ...legacyMessage(input), configuration: { blocking: false } });
      assert.equal(legacyTask.status.state, 'working');
      assert.equal((await client.cancelTask(CancelTaskRequest.fromJSON({ id: legacyTask.id }))).status.state, TaskState.TASK_STATE_CANCELED);
      assert.equal((await legacy.getTask({ id: legacyTask.id })).status.state, 'canceled');
      assert.equal(cancelled, 2);
    });
  } finally {
    await mcp.close();
    if (app) await app.close();
    else await pool.close();
  }
});
