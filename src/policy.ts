import { XMLValidator, XMLParser } from 'fast-xml-parser';
import { LIMITS, chartTypes, visualMapSchema, type Style } from './contracts.js';
import { AppError, invalid } from './errors.js';
import { validateFlow, validateHierarchy } from './structured-data.js';

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor', 'renderItem', 'graphic', 'image', 'decal', 'dataset', 'dataZoom', 'toolbox', 'media', 'baseOption', 'options', 'timeline']);
export function inspectJson(value: unknown): void {
  let nodes = 0;
  const walk = (v: unknown, depth: number) => {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth) invalid('JSON 结构超限');
    if (typeof v === 'number' && !Number.isFinite(v)) invalid('数值必须有限');
    if (typeof v === 'string') {
      if (v.length > LIMITS.text) invalid('文本长度超限');
      if (/(?:https?:|file:|data:|javascript:|image:\/\/|url\s*\(|<\s*\/?(?:script|iframe|svg|img)|=>|\bfunction\s*\()/i.test(v)) invalid('不支持脚本、资源引用或主动内容');
    } else if (v && typeof v === 'object') {
      if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) invalid('只接受 JSON 对象');
      for (const [k, child] of Object.entries(v)) {
        if (forbiddenKeys.has(k) || /^on[A-Z]/.test(k)) invalid('包含不支持的配置字段');
        walk(child, depth + 1);
      }
    } else if (v !== null && !['boolean', 'number'].includes(typeof v)) invalid('只接受 JSON 值');
  };
  walk(value, 0);
}
const themes = {
  light: { backgroundColor: '#ffffff', text: '#334155', color: ['#2563eb', '#0d9488', '#f59e0b', '#8b5cf6', '#f43f5e'] },
  dark: { backgroundColor: '#111827', text: '#e5e7eb', color: ['#60a5fa', '#2dd4bf', '#fbbf24', '#c4b5fd', '#fb7185'] },
  report: { backgroundColor: '#fffdf8', text: '#292524', color: ['#315b77', '#a1633d', '#728b65', '#9b829d', '#bd9b46'] },
};
function merge(a: Record<string, any>, b: Record<string, any>): Record<string, any> {
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) out[key] = value && typeof value === 'object' && !Array.isArray(value) ? merge(out[key] && typeof out[key] === 'object' && !Array.isArray(out[key]) ? out[key] : {}, value) : structuredClone(value);
  return out;
}
export function prepareOption(option: Record<string, any>, style: Style): Record<string, unknown> {
  inspectJson(option);
  const series = Array.isArray(option.series) ? option.series : option.series ? [option.series] : [];
  if (!series.length || series.length > LIMITS.series) invalid('series 数量必须在 1–20 之间', 'option.series');
  const visualMap = option.visualMap === undefined ? undefined : visualMapSchema.parse(option.visualMap);
  if (visualMap?.seriesIndex !== undefined && visualMap.seriesIndex >= series.length) invalid('visualMap 引用不存在的 series');
  let points = 0;
  for (const s of series) {
    if (!s || !chartTypes.includes(s.type) || !Array.isArray(s.data) || !s.data.length) invalid('系列类型不支持或缺少 data', 'option.series');
    if (['tree', 'treemap', 'sunburst'].includes(s.type)) points += validateHierarchy(s.data, s.type !== 'tree');
    else if (s.type === 'sankey') {
      if (s.nodes !== undefined || s.edges !== undefined) invalid('桑基图请使用 data 和 links，不能混用别名');
      validateFlow(s.data, s.links);
      points += s.data.length + s.links.length;
      if (s.layoutIterations !== undefined && (!Number.isInteger(s.layoutIterations) || s.layoutIterations < 0 || s.layoutIterations > 64)) invalid('桑基图布局迭代必须为 0–64');
    } else points += s.type === 'radar' ? s.data.reduce((n: number, d: any) => n + (Array.isArray(d?.value) ? d.value.length : 1), 0) : s.data.length;
    if (s.type === 'pie' || s.type === 'funnel') {
      const values = s.data.map((d: any) => typeof d === 'number' ? d : d?.value);
      if (values.some((v: any) => typeof v !== 'number' || !Number.isFinite(v) || v < 0) || !values.some((v: number) => v > 0)) invalid('饼图/漏斗图需要非负数且至少一个正数');
    }
    if (s.type === 'gauge') {
      const min = s.min ?? 0; const max = s.max ?? 100;
      const value = typeof s.data[0] === 'number' ? s.data[0] : s.data[0]?.value;
      if (s.data.length !== 1 || typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(max - min) || !(min < max) || typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid('仪表盘需要一个范围内数值及有限递增范围');
    }
    if (s.type === 'heatmap') {
      if (s.coordinateSystem !== undefined && s.coordinateSystem !== 'cartesian2d') invalid('热力图当前仅支持二维笛卡尔坐标系');
      const pairs = new Set<string>();
      for (const d of s.data) {
        const value = Array.isArray(d) ? d : d?.value;
        if (!Array.isArray(value) || value.length !== 3 || value.slice(0, 2).some((v: unknown) => !['string', 'number'].includes(typeof v)) || typeof value[2] !== 'number' || !Number.isFinite(value[2])) invalid('热力图数据需要 [x,y,value]');
        const key = JSON.stringify(value.slice(0, 2));
        if (pairs.has(key)) invalid('热力图坐标重复');
        pairs.add(key);
      }
    }
  }
  if (points > LIMITS.points) invalid('数据点数量超限');
  const theme = themes[style.theme];
  const result = merge({ backgroundColor: style.background ?? theme.backgroundColor, color: style.palette ?? theme.color, textStyle: { fontFamily: 'Noto Sans CJK SC', fontSize: style.fontSize, color: theme.text }, title: { textStyle: { color: theme.text } }, legend: { textStyle: { color: theme.text } } }, option);
  result.animation = false;
  result.tooltip = { show: false };
  result.useUTC = true;
  if (visualMap) result.visualMap = { ...visualMap, textStyle: { color: theme.text, ...visualMap.textStyle } };
  for (const name of ['xAxis', 'yAxis']) if (result[name]) {
    const axisStyle = { axisLabel: { color: theme.text }, nameTextStyle: { color: theme.text }, axisLine: { lineStyle: { color: style.theme === 'dark' ? '#64748b' : '#94a3b8' } }, splitLine: { lineStyle: { color: style.theme === 'dark' ? '#334155' : '#e2e8f0' } } };
    result[name] = Array.isArray(result[name]) ? result[name].map((axis: any) => merge(axisStyle, axis)) : merge(axisStyle, result[name]);
  }
  result.series = series.map((s: any) => {
    let themed = s;
    if (['tree', 'sunburst', 'sankey'].includes(s.type)) themed = merge({ label: { color: theme.text } }, s);
    if (s.type === 'gauge') themed = merge({ axisLabel: { color: theme.text }, title: { color: theme.text }, detail: { color: theme.text } }, s);
    return { ...themed, animation: false, silent: true };
  });
  return result;
}
export function validateSvg(svg: string): void {
  if (Buffer.byteLength(svg) > LIMITS.outputBytes) throw new AppError('OUTPUT_TOO_LARGE', 413, '图像输出超限');
  if (/<!DOCTYPE|<!ENTITY|<\?/i.test(svg) || XMLValidator.validate(svg) !== true) throw new AppError('UNSAFE_OUTPUT', 502, 'SVG 未通过安全校验');
  const root = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: false }).parse(svg);
  if (!root.svg) throw new AppError('UNSAFE_OUTPUT', 502, 'SVG 结构无效');
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    for (const [key, value] of Object.entries(v)) {
      if (/^(script|foreignObject|iframe|image|a|animate\w*|set)$/i.test(key) || /^@_on/i.test(key) || (/^@_(?:.*:)?href$/i.test(key) && !String(value).startsWith('#')) || (typeof value === 'string' && /(?:javascript:|https?:|file:|data:|url\s*\(\s*[^#])/i.test(value) && !['@_xmlns', '@_xmlns:xlink'].includes(key))) throw new AppError('UNSAFE_OUTPUT', 502, 'SVG 包含不支持的主动内容');
      walk(value);
    }
  };
  walk(root);
}
