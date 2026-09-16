import type { ChartSpec } from './contracts.js';
import { invalid } from './errors.js';
import { compileExtended } from './extended-charts.js';

export function compile(spec: ChartSpec, width = 960): Record<string, unknown> {
  const { data } = spec;
  const number = (row: Record<string, string | number>, key: string): number => { const v = row[key]; if (typeof v !== 'number' || !Number.isFinite(v)) invalid('映射字段缺失或不是有限数值', 'spec.encoding'); return v; };
  const categories = (key: string) => {
    const values = data.map(row => { const v = row[key]; if (v === undefined || v === '') invalid('分类字段缺失或为空', 'spec.encoding'); return String(v); });
    if (new Set(values).size !== values.length) invalid('分类值重复；请先显式聚合数据', 'spec.data');
    return values;
  };
  const label = (key: string) => spec.labels?.[key] ?? key;
  const title = { text: spec.title ?? '', left: 28, top: 20, textStyle: { fontSize: 20, overflow: 'truncate', width: width - 56 } };
  const base = { title, legend: { top: 65, type: 'plain' }, grid: { left: 36, right: 36, top: 112, bottom: 36, containLabel: true } };
  if (spec.type === 'bar' || spec.type === 'line') {
    const encoding = spec.encoding;
    if (new Set(encoding.y).size !== encoding.y.length) invalid('指标字段不能重复');
    if (data.length * encoding.y.length > 10_000) invalid('数据点数量超限');
    const xs = categories(encoding.x);
    if (spec.xType === 'time' && (spec.horizontal || xs.some(x => !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(x) || !Number.isFinite(Date.parse(x))))) invalid('时间轴需要 ISO 日期且不支持横向');
    const categoryAxis = { type: spec.xType, ...(spec.xType === 'category' ? { data: xs } : {}), axisLabel: { hideOverlap: true, width: 100, overflow: 'truncate' } };
    return { ...base, xAxis: spec.horizontal ? { type: 'value' } : categoryAxis, yAxis: spec.horizontal ? categoryAxis : { type: 'value' }, series: encoding.y.map(key => ({ type: spec.type, name: label(key), data: data.map((row, i) => spec.xType === 'time' ? [xs[i], number(row, key)] : number(row, key)), ...(spec.stacked ? { stack: 'total' } : {}), ...(spec.type === 'line' && spec.area ? { areaStyle: { opacity: 0.18 } } : {}), ...(spec.type === 'bar' ? { barMaxWidth: 64 } : { symbolSize: 7 }) })) };
  }
  if (spec.type === 'pie') {
    const names = categories(spec.encoding.name);
    const values = data.map(row => number(row, spec.encoding.value));
    if (values.some(v => v < 0) || !values.some(v => v > 0)) invalid('饼图需要非负数且总和大于零');
    return { ...base, legend: { bottom: 12 }, series: [{ type: 'pie', radius: spec.donut ? ['38%', '64%'] : '64%', center: ['50%', '53%'], label: { formatter: '{b}: {c}', overflow: 'truncate', width: 140 }, data: names.map((name, i) => ({ name, value: values[i] })) }] };
  }
  if (spec.type === 'scatter') return { ...base, xAxis: { type: 'value', name: label(spec.encoding.x) }, yAxis: { type: 'value', name: label(spec.encoding.y) }, series: [{ type: 'scatter', symbolSize: 11, data: data.map(row => [number(row, spec.encoding.x), number(row, spec.encoding.y)]) }] };
  if (spec.type !== 'radar') return compileExtended(spec, width);
  const names = categories(spec.encoding.name);
  if (data.length > 20 || spec.encoding.metrics.length < 3 || new Set(spec.encoding.metrics).size !== spec.encoding.metrics.length) invalid('雷达图需要 3–20 个不同指标和最多 20 行');
  const values = data.map(row => spec.encoding.metrics.map(key => number(row, key)));
  if (values.flat().some(v => v < 0)) invalid('雷达图数值必须非负');
  const max = spec.max ?? Math.max(1, ...values.flat()) * 1.1;
  if (values.flat().some(v => v > max)) invalid('雷达图 max 不能小于数据值');
  return { ...base, radar: { center: ['50%', '58%'], radius: '58%', indicator: spec.encoding.metrics.map(key => ({ name: label(key), max })) }, series: [{ type: 'radar', data: values.map((value, i) => ({ name: names[i], value })) }] };
}
