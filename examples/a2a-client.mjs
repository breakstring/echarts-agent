import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SendMessageRequest, TaskState } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory, DefaultAgentCardResolver } from '@a2a-js/sdk/client';
const root = process.env.CHART_URL ?? 'http://127.0.0.1:3000';
if (!process.env.SERVICE_API_KEY) throw new Error('需要 SERVICE_API_KEY');
const fetchImpl = (url, init) => {
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${process.env.SERVICE_API_KEY}`);
  return fetch(url, { ...init, headers });
};
const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })], cardResolver: new DefaultAgentCardResolver({ fetchImpl }) }).createFromUrl(root);
if (client.protocolVersion !== '1.0') throw new Error('服务未提供 A2A 1.0');
const request = JSON.parse(await readFile(new URL('./chart.json', import.meta.url), 'utf8'));
const task = await client.sendMessage(SendMessageRequest.fromJSON({
  message: { role: 'ROLE_USER', messageId: randomUUID(), parts: [{ data: { operation: 'chart', request } }] },
}));
if (!('status' in task) || task.status?.state !== TaskState.TASK_STATE_COMPLETED) throw new Error('图表任务未完成');
const image = task.artifacts[0]?.parts[0];
if (image?.content?.$case !== 'raw' || image.mediaType !== 'image/png') throw new Error('任务未返回 PNG 图片');
await writeFile('chart-a2a.png', image.content.value);
console.log('已保存 chart-a2a.png');
