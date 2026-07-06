import { useCallback } from 'react';
import type { DragEndEvent } from '@dnd-kit/core';
import { useAppStore, findLeafByTabId, findLeafById } from '../../../stores/useAppStore';

interface UseTabDragEndOptions {
  moveTabToPane: (tabId: string, paneId: string) => void;
  reorderPaneTabIds: (paneId: string, tabIds: string[]) => void;
}

/**
 * Builds the `onDragEnd` handler for cross-pane tab drag-and-drop.
 *
 * Same-pane drags reorder within the pane's `tabIds`. Cross-pane drags
 * move the tab to the target pane and, if the target was non-empty,
 * position it next to the hovered item.
 *
 * The previous implementation deferred the cross-pane reorder inside
 * `setTimeout(…, 0)`. That is unnecessary: Zustand's `set` (with the
 * immer middleware) applies synchronously, so `useAppStore.getState()`
 * called immediately after `moveTabToPane` already reflects the move.
 * Reading state inline is deterministic and avoids the macro-task gap.
 */
export function useTabDragEnd(
  options: UseTabDragEndOptions,
): (event: DragEndEvent) => void {
  const { moveTabToPane, reorderPaneTabIds } = options;

  return useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeTabId = String(active.id);
    const overTabId = String(over.id);

    const state = useAppStore.getState();

    // Locate the active and over leaves in the pane tree.
    // `over` may be a SortableContext tab (look up by tabId) or an empty
    // pane's useDroppable (over.id == leaf id).
    const activeLeaf = findLeafByTabId(state.paneTree, activeTabId);
    let overLeaf = findLeafByTabId(state.paneTree, overTabId);
    if (!overLeaf) {
      overLeaf = findLeafById(state.paneTree, overTabId);
    }

    if (!activeLeaf || !overLeaf) return;

    if (activeLeaf.id === overLeaf.id) {
      // Same leaf — reorder within this leaf's tabIds
      const tabIds = [...activeLeaf.tabIds];
      const oldIdx = tabIds.indexOf(activeTabId);
      const newIdx = tabIds.indexOf(overTabId);
      if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx) {
        tabIds.splice(oldIdx, 1);
        tabIds.splice(newIdx, 0, activeTabId);
        reorderPaneTabIds(activeLeaf.id, tabIds);
      }
    } else {
      // Cross-pane — move tab to other leaf
      const targetIsEmpty = overLeaf.tabIds.length === 0;
      moveTabToPane(activeTabId, overLeaf.id);
      if (!targetIsEmpty) {
        // Zustand + immer `set` is synchronous: getState() here already
        // reflects the moveTabToPane mutation above — no deferral needed.
        const updated = useAppStore.getState();
        const targetLeaf = findLeafById(updated.paneTree, overLeaf.id);
        if (targetLeaf && targetLeaf.tabIds.includes(activeTabId)) {
          const tabIds = [...targetLeaf.tabIds];
          const oldIdx = tabIds.indexOf(activeTabId);
          const newIdx = tabIds.indexOf(overTabId);
          if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx) {
            tabIds.splice(oldIdx, 1);
            tabIds.splice(newIdx, 0, activeTabId);
            reorderPaneTabIds(overLeaf.id, tabIds);
          }
        }
      }
    }
  }, [moveTabToPane, reorderPaneTabIds]);
}
