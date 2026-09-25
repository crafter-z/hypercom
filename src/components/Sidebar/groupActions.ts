import { useAppStore } from '../../stores/useAppStore';

/**
 * 分组创建的**唯一**实现。
 *
 * 建组时 `portIds` 一律留空，成员关系只由 `movePortToGroup` 写入——它同时维护
 * 组内 `portIds` 与端口的 `groupId`。此前侧边栏拖拽项菜单与「新建分组」按钮各写
 * 一份建组逻辑（一份填 `[port.id]`、一份填 `[]`），成员关系因此在两条路径上不一致。
 */
export function createGroupWithPort(portId: string, name: string): void {
  const { groups, addGroup, movePortToGroup } = useAppStore.getState();
  const id = `group-${Date.now()}`;
  addGroup({ id, name, isExpanded: true, portIds: [], order: groups.length });
  movePortToGroup(portId, id);
}

/** 新建空分组（工具栏「新建分组」）。 */
export function createEmptyGroup(name: string): void {
  const { groups, addGroup } = useAppStore.getState();
  addGroup({ id: `group-${Date.now()}`, name, isExpanded: true, portIds: [], order: groups.length });
}
