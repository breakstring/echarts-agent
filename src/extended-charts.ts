import { LIMITS, type ChartSpec } from './contracts.js';
import { invalid } from './errors.js';
import { validateFlow, validateHierarchy, type HierarchyNode } from './structured-data.js';

type ExtendedSpec = Extract<ChartSpec, { type: 'gauge' | 'funnel' | 'heatmap' | 'tree' | 'treemap' | 'sunburst' | 'sankey' }>;
type Row = Record<string, string | number>;
const number = (row: Row, key: string) => { const v = row[key]; if (typeof v !== 'number' || !Number.isFinite(v)) invalid('映射字段缺失或不是有限数值', 'spec.encoding'); return v; };
const text = (row: Row, key: string, allowEmpty = false) => { const v = row[key]; if (typeof v !== 'string' || (!allowEmpty && !v.trim())) invalid('映射字段需要字符串', 'spec.encoding'); return v; };
const category = (row: Row, key: string) => { const v = row[key]; if (v === undefined || String(v).trim() === '') invalid('分类字段缺失或为空', 'spec.encoding'); return String(v); };

function hierarchy(spec: Extract<ExtendedSpec, { type: 'tree' | 'treemap' | 'sunburst' }>): HierarchyNode[] {
  if (spec.data.length > LIMITS.hierarchyNodes) invalid('层级节点数量超限');
  const e = spec.encoding;
  const nodes = new Map<string, HierarchyNode>();
  const parents = new Map<string, string>();
  for (const row of spec.data) {
    const id = text(row, e.id);
    if (nodes.has(id)) invalid('层级节点 id 重复');
    nodes.set(id, { id, name: text(row, e.name), ...(e.value ? { value: number(row, e.value) } : {}) });
    parents.set(id, text(row, e.parent, true));
  }
  const roots: HierarchyNode[] = [];
  for (const [id, node] of nodes) {
    const parent = parents.get(id)!;
    if (parent === '') roots.push(node);
    else {
      if (!nodes.has(parent) || parent === id) invalid('父节点不存在或引用自身');
      (nodes.get(parent)!.children ??= []).push(node);
    }
  }
  if (roots.length !== 1) invalid('层级图必须有且只有一个 parent 为空字符串的根节点');
  // 已连接的有环分量不会从根可达；按深度检查也避免在无效结构上递归序列化。
  const count = validateHierarchy(roots, spec.type !== 'tree');
  if (count !== nodes.size) invalid('层级图存在循环或不可达节点');
  return roots;
}

export function compileExtended(spec: ExtendedSpec, width: number): Record<string, unknown> {
  const title = { text: spec.title ?? '', left: 28, top: 20, textStyle: { fontSize: 20, overflow: 'truncate', width: width - 56 } };
  if (spec.type === 'gauge') {
    if (spec.data.length !== 1 || !(spec.min < spec.max) || !Number.isFinite(spec.max - spec.min)) invalid('仪表盘需要一行数据及有限递增范围');
    const row = spec.data[0]!;
    const value = number(row, spec.encoding.value);
    if (value < spec.min || value > spec.max) invalid('仪表盘数值超出 min/max');
    return { title, series: [{ type: 'gauge', min: spec.min, max: spec.max, center: ['50%', '58%'], radius: '68%', progress: { show: true }, axisLabel: { distance: 28 }, axisTick: { length: 6 }, splitLine: { length: 12 }, axisLine: { lineStyle: { width: 16 } }, detail: { formatter: `{value}${spec.unit}`, fontSize: 28, offsetCenter: [0, '70%'] }, title: { offsetCenter: [0, '43%'], fontSize: 16 }, data: [{ name: category(row, spec.encoding.name), value }] }] };
  }
  if (spec.type === 'funnel') {
    const names = spec.data.map(row => category(row, spec.encoding.name));
    const values = spec.data.map(row => number(row, spec.encoding.value));
    if (new Set(names).size !== names.length || values.some(v => v < 0) || !values.some(v => v > 0)) invalid('漏斗图需要唯一类别及非负数，且至少一个正数');
    return { title, series: [{ type: 'funnel', top: 90, bottom: 40, left: '20%', width: '60%', min: 0, max: Math.max(...values), sort: 'none', gap: 4, label: { position: 'inside', formatter: '{b}: {c}', color: '#ffffff', textBorderColor: '#334155', textBorderWidth: 1 }, data: names.map((name, i) => ({ name, value: values[i] })) }] };
  }
  if (spec.type === 'heatmap') {
    const xs = new Map<string, number>(); const ys = new Map<string, number>(); const pairs = new Set<string>();
    const values = spec.data.map(row => {
      const x = category(row, spec.encoding.x); const y = category(row, spec.encoding.y);
      const key = JSON.stringify([x, y]);
      if (pairs.has(key)) invalid('热力图坐标重复；请先显式聚合');
      pairs.add(key); if (!xs.has(x)) xs.set(x, xs.size); if (!ys.has(y)) ys.set(y, ys.size);
      return [xs.get(x)!, ys.get(y)!, number(row, spec.encoding.value)];
    });
    const numbers = values.map(row => row[2]!); const min = Math.min(...numbers); const max = Math.max(...numbers);
    const range = min === max ? { min: min === 0 ? 0 : Math.min(0, min), max: max === 0 ? 1 : Math.max(0, max) } : { min, max };
    return { title, grid: { left: 44, right: 44, top: 96, bottom: 100, containLabel: true }, xAxis: { type: 'category', data: [...xs.keys()], splitArea: { show: true }, axisLabel: { hideOverlap: true, width: 100, overflow: 'truncate' } }, yAxis: { type: 'category', data: [...ys.keys()], axisLabel: { hideOverlap: true, width: 100, overflow: 'truncate' } }, visualMap: { type: 'continuous', ...range, dimension: 2, seriesIndex: 0, calculable: false, orient: 'horizontal', left: 'center', bottom: 15, text: [String(max), String(min)], inRange: { color: ['#eff6ff', '#93c5fd', '#3b82f6'] } }, series: [{ type: 'heatmap', data: values, label: { show: values.length <= 100, color: '#0f172a' }, itemStyle: { borderColor: '#ffffff', borderWidth: 1 } }] };
  }
  if (spec.type === 'sankey') {
    const names = new Set<string>();
    const links = spec.data.map(row => { const source = text(row, spec.encoding.source); const target = text(row, spec.encoding.target); names.add(source); names.add(target); return { source, target, value: number(row, spec.encoding.value) }; });
    const nodes = [...names].map(name => ({ name }));
    validateFlow(nodes, links);
    return { title, series: [{ type: 'sankey', data: nodes, links, orient: spec.orient, top: 90, bottom: 48, left: 64, right: 120, nodeWidth: 20, nodeGap: 22, layoutIterations: 32, lineStyle: { color: 'gradient', opacity: 0.4 }, label: { overflow: 'truncate', width: 110 } }] };
  }
  const data = hierarchy(spec);
  if (spec.type === 'tree') return { title, series: [{ type: 'tree', data, top: 90, bottom: 40, left: 100, right: 160, layout: spec.layout, symbolSize: 10, initialTreeDepth: -1, expandAndCollapse: false, roam: false, label: { position: 'left', align: 'right', width: 100, overflow: 'truncate' }, leaves: { label: { position: 'right', align: 'left' } }, lineStyle: { width: 2 } }] };
  if (spec.type === 'treemap') return { title, series: [{ type: 'treemap', data, top: 90, bottom: 35, left: 28, right: 28, sort: false, roam: false, nodeClick: false, breadcrumb: { show: false }, visibleMin: 0, childrenVisibleMin: 0, levels: [{ upperLabel: { show: false }, itemStyle: { borderWidth: 0 } }], label: { show: true, formatter: '{b}: {c}', color: '#ffffff' }, upperLabel: { show: true, height: 26, color: '#0f172a' }, itemStyle: { borderColor: '#e2e8f0', borderWidth: 2, gapWidth: 3 } }] };
  return { title, series: [{ type: 'sunburst', data, center: ['50%', '57%'], radius: [0, '72%'], sort: null, nodeClick: false, label: { rotate: 'radial', color: '#ffffff', textBorderColor: '#334155', textBorderWidth: 1 }, itemStyle: { borderColor: '#ffffff', borderWidth: 2 } }] };
}
