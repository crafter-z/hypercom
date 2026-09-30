/**
 * paneTree 纯函数模块：递归树遍历 / 修剪 / 节点 ID 生成。
 *
 * 这些函数与 Zustand 无关（纯数据进、纯数据出），原先内联在 useAppStore.ts
 * 里，把 787 行的 store 又撑大了 110 行。store 只负责 Immer 变更，树算法放这里。
 */
import type { PaneNode, LeafPane, BranchPane } from '../types';

// 分屏节点 ID 自增计数器：与 Date.now() 组合，防同毫秒连点产生碰撞 ID（P2-20）
let paneIdCounter = 0;

/** 生成唯一分屏节点 ID（`pane-<ms>-<seq>` / `branch-<ms>-<seq>`）。 */
export function newPaneId(kind: 'pane' | 'branch'): string {
  return `${kind}-${Date.now()}-${paneIdCounter++}`;
}

/** 查找指定 ID 的叶子节点 */
export function findLeafById(node: PaneNode, id: string): LeafPane | undefined {
  if (node.type === 'leaf') {
    return node.id === id ? node : undefined;
  }
  for (const child of node.children) {
    const found = findLeafById(child, id);
    if (found) return found;
  }
  return undefined;
}

/** 查找包含指定标签页 ID 的叶子节点 */
export function findLeafByTabId(node: PaneNode, tabId: string): LeafPane | undefined {
  if (node.type === 'leaf') {
    return node.tabIds.includes(tabId) ? node : undefined;
  }
  for (const child of node.children) {
    const found = findLeafByTabId(child, tabId);
    if (found) return found;
  }
  return undefined;
}

/** 查找指定 ID 的分支节点 */
export function findBranchById(node: PaneNode, id: string): BranchPane | undefined {
  if (node.type === 'leaf') return undefined;
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findBranchById(child, id);
    if (found) return found;
  }
  return undefined;
}

/** 查找指定叶子节点的父分支节点 */
export function findParentBranch(node: PaneNode, leafId: string): BranchPane | undefined {
  if (node.type === 'leaf') return undefined;
  if (node.children.some((c) => c.type === 'leaf' && c.id === leafId)) {
    return node;
  }
  for (const child of node.children) {
    if (child.type === 'branch') {
      const found = findParentBranch(child, leafId);
      if (found) return found;
    }
  }
  return undefined;
}

/** 收集树中所有叶子节点（深度优先，从左到右） */
export function collectLeaves(node: PaneNode): LeafPane[] {
  if (node.type === 'leaf') return [node];
  return node.children.flatMap((c) => collectLeaves(c));
}

/** 统计树中叶子节点数量 */
export function countLeaves(node: PaneNode): number {
  if (node.type === 'leaf') return 1;
  return node.children.reduce((sum, c) => sum + countLeaves(c), 0);
}

/**
 * 递归修剪分屏树（原地修改传入节点及其子树）：
 * - 移除空叶子节点（非根）
 * - 移除空分支节点
 * - 将只有 1 个子节点的分支折叠为该子节点（继承父分支的 size）
 * - 根节点若为空分支则替换为空叶子
 */
export function pruneTree(tree: PaneNode): PaneNode {
  if (tree.type === 'leaf') {
    return tree; // 根叶子保留（即使为空）
  }
  tree.children = pruneChildrenArray(tree.children);
  if (tree.children.length === 0) {
    return { id: 'main', type: 'leaf', tabIds: [], size: 1 };
  }
  if (tree.children.length === 1) {
    const sole = tree.children[0];
    sole.size = 1;
    return sole;
  }
  return tree;
}

function pruneChildrenArray(children: PaneNode[]): PaneNode[] {
  const result: PaneNode[] = [];
  for (const child of children) {
    if (child.type === 'branch') {
      child.children = pruneChildrenArray(child.children);
      if (child.children.length === 0) {
        continue; // 丢弃空分支
      } else if (child.children.length === 1) {
        // 折叠：用唯一子节点替换此分支，继承 size
        const sole = child.children[0];
        sole.size = child.size;
        result.push(sole);
      } else {
        result.push(child);
      }
    } else {
      // 叶子节点 — 空则丢弃
      if (child.tabIds.length === 0) {
        continue;
      }
      result.push(child);
    }
  }
  return result;
}
