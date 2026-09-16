import { z } from 'zod';
import { rawRequestSchema, chartRequestSchema, generateRequestSchema, planSchema, specSchema } from './contracts.js';

const artifact = z.object({ mimeType: z.enum(['image/svg+xml', 'image/png']), width: z.number(), height: z.number(), bytes: z.number(), svg: z.string().optional(), base64: z.string().optional() });
const error = z.object({ error: z.object({ code: z.string(), message: z.string(), requestId: z.string(), details: z.array(z.object({ path: z.string(), reason: z.string() })) }) });
const generated = z.object({ requestId: z.string(), spec: specSchema, option: z.record(z.string(), z.unknown()), warnings: z.array(z.string()), artifact });
const jsonResponse = (schema: object, description: string) => ({ description, content: { 'application/json': { schema } } });

export function openApiDocument() {
  const schemas = Object.fromEntries(Object.entries({ RenderRequest: rawRequestSchema, ChartRequest: chartRequestSchema, GenerateRequest: generateRequestSchema, ChartPlan: planSchema, ChartSpec: specSchema }).map(([name, schema]) => [name, z.toJSONSchema(schema, { io: 'input' })]));
  const paths: Record<string, unknown> = {};
  for (const [path, name] of [['render', 'RenderRequest'], ['charts', 'ChartRequest'], ['generate', 'GenerateRequest']]) {
    paths[`/v1/${path}`] = { post: {
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } },
      responses: {
        '200': path === 'generate' ? jsonResponse({ $ref: '#/components/schemas/GenerateResponse' }, '最终设计与内联图像') : { description: '直接返回图像字节；PNG 是二进制响应', headers: { 'X-Request-Id': { schema: { type: 'string' } }, 'Content-Disposition': { schema: { type: 'string' } } }, content: { 'image/svg+xml': { schema: { type: 'string' } }, 'image/png': {} } },
        default: jsonResponse({ $ref: '#/components/schemas/ErrorResponse' }, '错误；400/401/413/415/422/429/499/502/503/504'),
      },
    } };
  }
  paths['/v1/capabilities'] = { get: { responses: { '200': jsonResponse({ type: 'object' }, '图表类型、主题、资源限额与模型配置状态') } } };
  for (const name of ['live', 'ready']) paths[`/health/${name}`] = { get: { security: [], responses: { '200': jsonResponse({ type: 'object' }, '运行状态'), ...(name === 'ready' ? { '503': jsonResponse({ type: 'object' }, '渲染进程不可用') } : {}) } } };
  return { openapi: '3.1.0', info: { title: 'ECharts Agent', version: '0.1.0' }, security: [{ bearerAuth: [] }], components: { schemas: { ...schemas, Artifact: z.toJSONSchema(artifact), GenerateResponse: z.toJSONSchema(generated), ErrorResponse: z.toJSONSchema(error) }, securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } }, paths };
}
