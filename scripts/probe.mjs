import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

process.env.FONTCONFIG_FILE = resolve('assets/fonts/fonts.conf');
const [{ default: sharp }, echarts, { McpServer }, { StreamableHTTPServerTransport }, { z }, { Client }, { StreamableHTTPClientTransport }] = await Promise.all([
  import('sharp'), import('echarts'), import('@modelcontextprotocol/sdk/server/mcp.js'), import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
  import('zod'), import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
]);
const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 960, height: 540 });
let svg;
try {
  chart.setOption({ animation: false, textStyle: { fontFamily: 'Noto Sans CJK SC' }, title: { text: '中文图表技术验证 · 数量趋势' }, xAxis: { type: 'category', data: ['一月', '二月', '三月'] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: [12, 18, 25] }] });
  svg = chart.renderToSVGString();
} finally { chart.dispose(); }
const png = await sharp(Buffer.from(svg)).png().toBuffer();
assert.equal((await sharp(png).metadata()).width, 960);
await mkdir('artifacts/probe', { recursive: true });
await writeFile('artifacts/probe/chinese.svg', svg);
await writeFile('artifacts/probe/chinese.png', png);
const http = createServer(async (req, res) => {
  const mcp = new McpServer({ name: 'probe', version: '0.1.0' });
  mcp.registerTool('render_probe', { description: '验证图表内容传递', inputSchema: z.object({ format: z.enum(['svg', 'png']) }), outputSchema: z.object({ format: z.enum(['svg', 'png']) }) }, async ({ format }) => ({ structuredContent: { format }, content: format === 'png' ? [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] : [{ type: 'text', text: svg }] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void mcp.close(); });
  try { await mcp.connect(transport); await transport.handleRequest(req, res); }
  catch { res.writeHead(500).end(); }
});
await new Promise(r => http.listen(0, '127.0.0.1', r));
const client = new Client({ name: 'probe-client', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`)));
  assert.equal((await client.listTools()).tools.length, 1);
  for (const format of ['png', 'svg']) {
    const result = await client.callTool({ name: 'render_probe', arguments: { format } });
    if (result.content[0].type !== (format === 'png' ? 'image' : 'text')) console.log(JSON.stringify({ contentType: result.content[0].type, isError: result.isError, preview: result.content[0].text?.slice(0, 600) }));
    assert.equal(result.content[0].type, format === 'png' ? 'image' : 'text');
    if (format === 'png') assert.equal(Buffer.from(result.content[0].data, 'base64').equals(png), true);
    else assert.equal(result.content[0].text, svg);
  }
  console.log(JSON.stringify({ render: 'passed', mcp: 'passed', svgBytes: Buffer.byteLength(svg), pngBytes: png.length }));
} finally { await client.close(); await new Promise(r => http.close(r)); }

if (process.argv.includes('--live')) {
  const { Agent } = await import('@mastra/core/agent');
  const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
  const provider = createOpenAICompatible({ name: 'dashscope', baseURL: process.env.llm_base_url, apiKey: process.env.llm_api_key, transformRequestBody: body => ({ ...body, enable_thinking: false }) });
  const agent = new Agent({ id: 'probe', name: 'probe', instructions: '只返回要求的 JSON，使用提供的数据字段，不要添加数值。', model: provider(process.env.llm_default_model) });
  const { noopLogger } = await import('@mastra/core/logger');
  agent.__setLogger(noopLogger);
  const began = performance.now();
  try {
    const result = await agent.generate('返回 JSON 图表计划。月度数量趋势，字段 month、count。选择 line 或 bar，x 为 month，y 为 count。', { structuredOutput: { schema: z.object({ type: z.enum(['line', 'bar']), x: z.string(), y: z.string() }), jsonPromptInjection: true }, modelSettings: { maxRetries: 0, maxOutputTokens: 512 }, abortSignal: AbortSignal.timeout(30_000), maxSteps: 1 });
    assert.equal(result.object.x, 'month'); assert.equal(result.object.y, 'count');
    console.log(JSON.stringify({ provider: 'dashscope', model: process.env.llm_default_model, live: 'passed', durationMs: Math.round(performance.now() - began), plan: result.object }));
  } catch (error) {
    console.error(JSON.stringify({ live: 'failed', name: error?.name, durationMs: Math.round(performance.now() - began) }));
    process.exitCode = 1;
  }
}
