import { useCallback } from 'react';
import type { DragEndEvent } from '@dnd-kit/core';
import { useAppStore } from '../../../stores/useAppStore';

/**
 * 组头 droppable 的 id 约定：`GroupItem` 用它注册落点，这里用它反解落点属于哪个
 * 组。两侧共用同一份拼装函数，避免「注册用 droppable-、解析用 drop-」这类漂移。
 */
export const GROUP_DROPPABLE_PREFIX = 'droppable-';

export function groupDroppableId(groupId: string): string {
  return `${GROUP_DROPPABLE_PREFIX}${groupId}`;
}

/**
 * Unified DnD end handler for the sidebar port list.
 *
 * Supports same-group reordering, cross-group moves, and
 * moving ports into / out of the "ungrouped" area.
 *
 * The handler reads fresh state via `useAppStore.getState()` for
 * all port/group lookups — including post-mutation reads — so that
 * operations like `movePortToGroup` are reflected immediately.
 */
export function usePortDragEnd(): (event: DragEndEvent) => void {
  return useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeId = String(active.id);
    const overId = String(over.id);

    const store = useAppStore.getState();
    const allPorts = store.ports;

    const activePort = allPorts.find(p => p.id === activeId);
    let overPort = allPorts.find(p => p.id === overId);
    let overGroupId: string | undefined;

    if (overPort) {
      // Dropped onto a port — use that port's group
      overGroupId = overPort.groupId;
    } else if (overId.startsWith(GROUP_DROPPABLE_PREFIX)) {
      // Dropped onto a group header droppable — use that group directly
      overGroupId = overId.slice(GROUP_DROPPABLE_PREFIX.length);
    } else {
      return; // Unknown target
    }

    if (!activePort) return;

    const activeGroupId = activePort.groupId;

    if (activeGroupId === overGroupId) {
      // Same group (or both ungrouped) — reorder within the group
      if (overPort) {
        const oldGlobal = allPorts.findIndex(p => p.id === activeId);
        const newGlobal = allPorts.findIndex(p => p.id === overId);
        if (oldGlobal !== -1 && newGlobal !== -1) {
          store.reorderPorts(oldGlobal, newGlobal);
        }
      }
      return;
    }

    // Cross-group move: move active port into the target group
    store.movePortToGroup(activeId, overGroupId);

    // Position the moved port next to the over target within the target group
    if (overPort && overGroupId) {
      const refreshedGroups = useAppStore.getState().groups;
      const newGroup = refreshedGroups.find(g => g.id === overGroupId);
      if (newGroup) {
        const idxOfActive = newGroup.portIds.indexOf(activeId);
        const idxOfOver = newGroup.portIds.indexOf(overId);
        if (idxOfActive !== -1 && idxOfOver !== -1 && idxOfActive !== idxOfOver) {
          const next = [...newGroup.portIds];
          next.splice(idxOfActive, 1);
          next.splice(idxOfOver, 0, activeId);
          useAppStore.getState().updateGroup(overGroupId, { portIds: next });
        }
      }
    }

    if (overGroupId === undefined && overPort) {
      // Move to ungrouped: also adjust global port order so active sits next to over
      const refreshed = useAppStore.getState().ports;
      const newGlobalOldIdx = refreshed.findIndex(p => p.id === activeId);
      const newGlobalOverIdx = refreshed.findIndex(p => p.id === overId);
      if (newGlobalOldIdx !== -1 && newGlobalOverIdx !== -1 && newGlobalOldIdx !== newGlobalOverIdx) {
        useAppStore.getState().reorderPorts(newGlobalOldIdx, newGlobalOverIdx);
      }
    }
  }, []);
}
