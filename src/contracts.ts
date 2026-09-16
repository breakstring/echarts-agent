import { z } from 'zod';

export const LIMITS = { bodyBytes: 1024 * 1024, series: 20, points: 10_000, pixels: 16_000_000, outputBytes: 10 * 1024 * 1024, depth: 24, nodes: 100_000, text: 4096, hierarchyNodes: 1000, hierarchyDepth: 8, sankeyNodes: 500, sankeyLinks: 2000 } as const;
export const chartTypes = ['bar', 'line', 'pie', 'scatter', 'radar', 'gauge', 'funnel', 'heatmap', 'tree', 'treemap', 'sunburst', 'sankey'] as const;
const field = z.string().min(1).max(64).regex(/^[\p{L}_][\p{L}\p{N}_ -]*$/u).refine(v => !['__proto__', 'constructor', 'prototype'].includes(v));
const cell = z.union([z.string().max(512), z.number().finite()]);
export const dataSchema = z.array(z.record(field, cell)).min(1).max(LIMITS.points).superRefine((rows, ctx) => {
  const fields = new Set(rows.flatMap(row => Object.keys(row)));
  if (fields.size > 64) ctx.addIssue({ code: 'custom', message: '最多支持 64 个字段' });
});
const common = { title: z.string().max(180).optional(), labels: z.record(field, z.string().max(80)).optional() };
const metricFields = z.array(field).min(1).max(LIMITS.series);
const xy = { ...common, encoding: z.strictObject({ x: field, y: metricFields }), xType: z.enum(['category', 'time']).default('category'), horizontal: z.boolean().default(false), stacked: z.boolean().default(false), area: z.boolean().default(false) };
const hierarchy = { id: field, parent: field, name: field };
const shapes = [
  z.strictObject({ type: z.literal('bar'), ...xy }),
  z.strictObject({ type: z.literal('line'), ...xy }),
  z.strictObject({ type: z.literal('pie'), ...common, encoding: z.strictObject({ name: field, value: field }), donut: z.boolean().default(false) }),
  z.strictObject({ type: z.literal('scatter'), ...common, encoding: z.strictObject({ x: field, y: field }) }),
  z.strictObject({ type: z.literal('radar'), ...common, encoding: z.strictObject({ name: field, metrics: metricFields }), max: z.number().positive().finite().optional() }),
  z.strictObject({ type: z.literal('gauge'), ...common, encoding: z.strictObject({ name: field, value: field }), min: z.number().finite().default(0), max: z.number().finite().default(100), unit: z.string().max(16).regex(/^[\p{L}\p{N}%‰°℃ /._-]*$/u).default('') }),
  z.strictObject({ type: z.literal('funnel'), ...common, encoding: z.strictObject({ name: field, value: field }) }),
  z.strictObject({ type: z.literal('heatmap'), ...common, encoding: z.strictObject({ x: field, y: field, value: field }) }),
  z.strictObject({ type: z.literal('tree'), ...common, encoding: z.strictObject({ ...hierarchy, value: field.optional() }), layout: z.enum(['orthogonal', 'radial']).default('orthogonal') }),
  z.strictObject({ type: z.literal('treemap'), ...common, encoding: z.strictObject({ ...hierarchy, value: field }) }),
  z.strictObject({ type: z.literal('sunburst'), ...common, encoding: z.strictObject({ ...hierarchy, value: field }) }),
  z.strictObject({ type: z.literal('sankey'), ...common, encoding: z.strictObject({ source: field, target: field, value: field }), orient: z.enum(['horizontal', 'vertical']).default('horizontal') }),
] as const;
export const planSchema = z.discriminatedUnion('type', shapes);
export const specSchema = z.discriminatedUnion('type', [
  shapes[0].extend({ data: dataSchema }), shapes[1].extend({ data: dataSchema }), shapes[2].extend({ data: dataSchema }),
  shapes[3].extend({ data: dataSchema }), shapes[4].extend({ data: dataSchema }), shapes[5].extend({ data: dataSchema }),
  shapes[6].extend({ data: dataSchema }), shapes[7].extend({ data: dataSchema }), shapes[8].extend({ data: dataSchema }),
  shapes[9].extend({ data: dataSchema }), shapes[10].extend({ data: dataSchema }), shapes[11].extend({ data: dataSchema }),
]);
export type ChartPlan = z.infer<typeof planSchema>;
export type ChartSpec = ChartPlan & { data: z.infer<typeof dataSchema> };
const color = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
const position = z.union([z.number().finite().min(0).max(2400), z.enum(['left', 'right', 'top', 'bottom', 'center']), z.string().regex(/^(?:100|\d{1,2})(?:\.\d+)?%$/)]);
export const visualMapSchema = z.strictObject({
  type: z.literal('continuous').default('continuous'), min: z.number().finite(), max: z.number().finite(),
  dimension: z.number().int().min(0).max(63).optional(), seriesIndex: z.number().int().min(0).max(LIMITS.series - 1).optional(),
  inRange: z.strictObject({ color: z.array(color).min(2).max(20) }), calculable: z.literal(false).default(false),
  show: z.boolean().optional(), orient: z.enum(['horizontal', 'vertical']).optional(),
  left: position.optional(), right: position.optional(), top: position.optional(), bottom: position.optional(),
  text: z.array(z.string().max(80)).length(2).optional(),
  textStyle: z.strictObject({ color }).optional(),
}).refine(v => v.min < v.max && Number.isFinite(v.max - v.min), { message: 'visualMap 需要有限且递增的范围' });
export const styleSchema = z.strictObject({ theme: z.enum(['light', 'dark', 'report']).default('light'), palette: z.array(color).min(1).max(20).optional(), fontSize: z.number().int().min(10).max(32).default(14), background: z.union([color, z.literal('transparent')]).optional() }).default({ theme: 'light', fontSize: 14 });
export const outputSchema = z.strictObject({ format: z.enum(['svg', 'png']).default('svg'), width: z.number().int().min(240).max(2400).default(960), height: z.number().int().min(180).max(2400).default(540), pixelRatio: z.number().min(1).max(3).default(1) }).default({ format: 'svg', width: 960, height: 540, pixelRatio: 1 }).superRefine((v, ctx) => {
  if (v.format === 'svg' && v.pixelRatio !== 1) ctx.addIssue({ code: 'custom', message: 'SVG pixelRatio 必须为 1', path: ['pixelRatio'] });
  if (!Number.isInteger(v.width * v.pixelRatio) || !Number.isInteger(v.height * v.pixelRatio) || v.width * v.height * v.pixelRatio ** 2 > LIMITS.pixels) ctx.addIssue({ code: 'custom', message: 'PNG 像素超限或非整数', path: ['pixelRatio'] });
});
const renderFields = { style: styleSchema, output: outputSchema };
export const rawRequestSchema = z.strictObject({ option: z.record(z.string(), z.unknown()), ...renderFields });
export const chartRequestSchema = z.strictObject({ spec: specSchema, ...renderFields });
export const generateRequestSchema = z.strictObject({ data: dataSchema, intent: z.string().min(1).max(2000), ...renderFields });
export type Style = z.infer<typeof styleSchema>;
export type Output = z.infer<typeof outputSchema>;
export interface RenderJob { option: Record<string, unknown>; output: Output }
export interface Artifact { mimeType: 'image/svg+xml' | 'image/png'; width: number; height: number; bytes: number; svg?: string; base64?: string }
