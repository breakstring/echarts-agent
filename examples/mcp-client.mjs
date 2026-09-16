import { readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const root = process.env.CHART_URL ?? 'http://127.0.0.1:3000';
const headers = process.env.SERVICE_API_KEY ? { authorization: `Bearer ${process.env.SERVICE_API_KEY}` } : {};
const client = new Client({ name: 'chart-example', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${root}/mcp`), { requestInit: { headers } }));
try {
  const request = JSON.parse(await readFile(new URL('./chart.json', import.meta.url), 'utf8'));
  const result = await client.callTool({ name: 'render_chart', arguments: request });
  if (result.isError || result.content[0]?.type !== 'image') throw new Error('图表生成失败，请检查参数和能力');
  await writeFile('chart-mcp.png', Buffer.from(result.content[0].data, 'base64'));
  console.log('已保存 chart-mcp.png');
} finally { await client.close(); }
