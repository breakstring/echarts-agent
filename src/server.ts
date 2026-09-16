import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { rawRequestSchema, chartRequestSchema, generateRequestSchema, LIMITS, type Artifact } from './contracts.js';
import { safeError, AppError } from './errors.js';
import { ChartService } from './service.js';
import { registerA2A } from './a2a.js';
import { openApiDocument } from './openapi.js';

const metadataSchema = z.object({ requestId: z.string(), mimeType: z.string(), width: z.number(), height: z.number(), bytes: z.number() });
export function createServer(service: ChartService, options: { apiKey?: string; allowAnonymous?: boolean; log?: boolean; a2aPublicUrl?: string } = {}) {
  if (!options.apiKey && !options.allowAnonymous) throw new Error('需要 SERVICE_API_KEY 或显式 ALLOW_ANONYMOUS=true');
  const app = Fastify({ bodyLimit: LIMITS.bodyBytes, logger: false, genReqId: () => randomUUID(), requestTimeout: 70_000, connectionTimeout: 75_000, forceCloseConnections: true, onProtoPoisoning: 'error', onConstructorPoisoning: 'error' });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id).header('x-content-type-options', 'nosniff').header('cache-control', 'no-store');
    if (request.url.split('?')[0]?.startsWith('/health/')) return;
    const expected = options.apiKey ? Buffer.from(`Bearer ${options.apiKey}`) : undefined;
    const actual = Buffer.from(request.headers.authorization ?? '');
    if (expected && (expected.length !== actual.length || !timingSafeEqual(expected, actual))) throw new AppError('UNAUTHORIZED', 401, '需要有效 Bearer key');
  });
  app.addHook('onResponse', async (request, reply) => {
    if (options.log) console.log(JSON.stringify({ requestId: request.id, route: request.routeOptions.url ?? 'unknown', status: reply.statusCode, durationMs: Math.round(reply.elapsedTime) }));
  });
  app.setErrorHandler((error, request, reply) => {
    let safe = safeError(error);
    if ((error as any).code === 'FST_ERR_CTP_BODY_TOO_LARGE') safe = new AppError('REQUEST_TOO_LARGE', 413, '请求超过 1 MiB');
    else if ((error as any).statusCode === 400) safe = new AppError('INVALID_JSON', 400, 'JSON 请求无法解析');
    else if ((error as any).statusCode === 415) safe = new AppError('UNSUPPORTED_MEDIA_TYPE', 415, '请使用 application/json');
    reply.status(safe.status).send({ error: { code: safe.code, message: safe.message, requestId: request.id, details: safe.details } });
  });
  function cancellation(request: FastifyRequest, reply: FastifyReply) {
    const controller = new AbortController();
    request.raw.once('aborted', () => controller.abort());
    reply.raw.once('close', () => { if (!reply.raw.writableEnded) controller.abort(); });
    return controller.signal;
  }
  function binary(artifact: Artifact, reply: FastifyReply) {
    reply.header('content-disposition', `attachment; filename="chart.${artifact.svg ? 'svg' : 'png'}"`).type(artifact.svg ? 'image/svg+xml; charset=utf-8' : 'image/png').send(artifact.svg ?? Buffer.from(artifact.base64!, 'base64'));
  }
  app.get('/health/live', async () => ({ status: 'alive' }));
  app.get('/health/ready', async (_request, reply) => reply.status(service.pool.ready ? 200 : 503).send({ status: service.pool.ready ? 'ready' : 'unavailable', render: service.pool.stats, ai: service.aiStatus }));
  app.get('/v1/capabilities', async () => service.capabilities());
  app.post('/v1/render', async (request, reply) => binary(await service.raw(request.body, cancellation(request, reply)), reply));
  app.post('/v1/charts', async (request, reply) => binary(await service.chart(request.body, cancellation(request, reply)), reply));
  app.post('/v1/generate', async (request, reply) => ({ requestId: request.id, ...await service.generate(request.body, cancellation(request, reply)) }));
  app.get('/openapi.json', async () => openApiDocument());
  app.all('/mcp', async (request, reply) => {
    const signal = cancellation(request, reply);
    const mcp = new McpServer({ name: 'echarts-agent', version: '0.1.0' });
    mcp.registerTool('get_chart_capabilities', { description: '查询支持的图表、主题和限额', inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: JSON.stringify(service.capabilities()) }] }));
    const call = async (action: () => Promise<Artifact>) => {
      try {
        const artifact = await action();
        const { svg, base64, ...metadata } = artifact;
        const result = { structuredContent: { requestId: request.id, ...metadata }, content: svg ? [{ type: 'text' as const, text: svg }] : [{ type: 'image' as const, data: base64!, mimeType: 'image/png' }] };
        if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.outputBytes) throw new AppError('OUTPUT_TOO_LARGE', 413, 'MCP 响应超限，请减小尺寸或改用 HTTP');
        return result;
      } catch (error) { const safe = safeError(error); return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: safe.code, message: safe.message, requestId: request.id } }) }] }; }
    };
    mcp.registerTool('render_echarts', { description: '安全 ECharts JSON option 生成 SVG 或 PNG', inputSchema: rawRequestSchema, outputSchema: metadataSchema }, async input => call(() => service.raw(input, signal)));
    mcp.registerTool('render_chart', { description: 'ChartSpec 数据与字段映射生成 SVG 或 PNG', inputSchema: chartRequestSchema, outputSchema: metadataSchema }, async input => call(() => service.chart(input, signal)));
    if (service.aiStatus === 'ready') mcp.registerTool('generate_chart', { description: '根据结构化数据和意图设计图表，需要服务已配置模型', inputSchema: generateRequestSchema, outputSchema: metadataSchema.extend({ spec: z.unknown(), option: z.unknown(), warnings: z.array(z.string()) }) }, async input => {
      let generation: Awaited<ReturnType<ChartService['generate']>> | undefined;
      const result = await call(async () => { generation = await service.generate(input, signal); return generation.artifact; });
      if (generation && 'structuredContent' in result) {
        const complete = { ...result, structuredContent: { ...result.structuredContent, spec: generation.spec, option: generation.option, warnings: generation.warnings } };
        if (Buffer.byteLength(JSON.stringify(complete)) > LIMITS.outputBytes) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: 'OUTPUT_TOO_LARGE', message: 'MCP 响应超限，请减小尺寸或改用 HTTP', requestId: request.id } }) }] };
        return complete;
      }
      return result;
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(name, value);
    reply.raw.once('close', () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    try { await transport.handleRequest(request.raw, reply.raw, request.body); }
    catch { if (!reply.raw.headersSent) reply.raw.writeHead(500, { 'content-type': 'application/json' }); if (!reply.raw.writableEnded) reply.raw.end(JSON.stringify({ error: { code: 'MCP_FAILED', message: 'MCP 请求失败', requestId: request.id } })); }
  });
  if (options.a2aPublicUrl) {
    if (!options.apiKey) throw new Error('A2A 需要 SERVICE_API_KEY');
    registerA2A(app, service, options.a2aPublicUrl);
  }
  app.addHook('onClose', async () => service.pool.close());
  return app;
}
