import { LIMITS } from './contracts.js';
import { invalid } from './errors.js';

export interface HierarchyNode { id?: string; name: string; value?: number; children?: HierarchyNode[] }
export interface FlowNode { name: string }
export interface FlowLink { source: string; target: string; value: number }

export function validateHierarchy(nodes: unknown[], requireValue: boolean): number {
  let count = 0;
  const ids = new Set<string>();
  function visit(value: unknown, depth: number): number | undefined {
    if (++count > LIMITS.hierarchyNodes || depth > LIMITS.hierarchyDepth) invalid('层级节点数量或深度超限');
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('层级节点必须为对象');
    const node = value as Record<string, unknown>;
    if (typeof node.name !== 'string' || !node.name.trim()) invalid('层级节点需要非空 name');
    if (node.id !== undefined) {
      if (typeof node.id !== 'string' || !node.id.trim() || ids.has(node.id)) invalid('层级节点 id 必须唯一且非空');
      ids.add(node.id);
    }
    if (requireValue || node.value !== undefined) {
      if (typeof node.value !== 'number' || !Number.isFinite(node.value) || node.value < 0) invalid('层级数值必须为非负有限数');
    }
    if (node.children !== undefined && !Array.isArray(node.children)) invalid('children 必须为数组');
    const children = (node.children ?? []) as unknown[];
    const values = children.map(child => visit(child, depth + 1));
    if (node.value !== undefined && values.every(v => v !== undefined)) {
      const sum = values.reduce<number>((total, v) => total + v!, 0);
      // 允许十进制输入求和产生的浮点舍入误差，不改写提交的数值。
      const tolerance = Number.EPSILON * Math.max(Math.abs(sum), node.value as number) * Math.max(1, values.length);
      if (!Number.isFinite(sum) || sum - (node.value as number) > tolerance) invalid('父节点 value 不能小于直接子节点数值之和');
    }
    return node.value as number | undefined;
  }
  for (const root of nodes) visit(root, 1);
  if (requireValue && !nodes.some(node => (node as HierarchyNode).value! > 0)) invalid('面积型层级图至少需要一个正数根节点');
  return count;
}

export function validateFlow(nodes: unknown[], links: unknown): void {
  if (nodes.length > LIMITS.sankeyNodes || !Array.isArray(links) || !links.length || links.length > LIMITS.sankeyLinks) invalid('桑基图节点或边数量超限/为空');
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  const totals = new Map<string, { incoming: number; outgoing: number }>();
  for (const value of nodes) {
    const name = (value as FlowNode | null)?.name;
    if (typeof name !== 'string' || !name.trim() || indegree.has(name)) invalid('桑基图节点 name 必须非空且唯一');
    indegree.set(name, 0); outgoing.set(name, []); totals.set(name, { incoming: 0, outgoing: 0 });
  }
  const pairs = new Set<string>();
  for (const link of links) {
    if (!link || typeof link.source !== 'string' || typeof link.target !== 'string' || !indegree.has(link.source) || !indegree.has(link.target)) invalid('桑基图边引用了不存在的节点');
    const key = JSON.stringify([link.source, link.target]);
    if (link.source === link.target || pairs.has(key)) invalid('桑基图不支持自环或重复边');
    if (typeof link.value !== 'number' || !Number.isFinite(link.value) || link.value <= 0) invalid('桑基图边的 value 必须为正有限数');
    pairs.add(key); outgoing.get(link.source)!.push(link.target); indegree.set(link.target, indegree.get(link.target)! + 1);
    totals.get(link.source)!.outgoing += link.value; totals.get(link.target)!.incoming += link.value;
  }
  for (const total of totals.values()) if (!Number.isFinite(total.incoming) || !Number.isFinite(total.outgoing) || total.incoming + total.outgoing === 0) invalid('桑基图不支持孤立节点或溢出的流量总和');
  const queue = [...indegree].filter(([, degree]) => degree === 0).map(([name]) => name);
  for (let i = 0; i < queue.length; i++) for (const target of outgoing.get(queue[i]!)!) {
    const degree = indegree.get(target)! - 1;
    indegree.set(target, degree);
    if (degree === 0) queue.push(target);
  }
  if (queue.length !== nodes.length) invalid('桑基图只支持无环有向关系');
}
