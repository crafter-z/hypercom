import { useCallback } from 'react';
import type { DragEndEvent } from '@dnd-kit/core';
import { useAppStore } from '../../../stores/useAppStore';

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

    // Find which panes the active and over targets belong to.
    // The `over` might be a SortableContext tab (tab ID → lookup in pane.tabIds)
    // or a useDroppable pane (pane ID → lookup in panes directly).
    const activePane = state.panes.find(p => p.tabIds.includes(activeTabId));
    let overPane = state.panes.find(p => p.tabIds.includes(overTabId));
    if (!overPane) {
      // Check if over is an empty pane's droppable (over.id == paneId)
      overPane = state.panes.find(p => p.id === overTabId);
    }

    if (!activePane || !overPane) return;

    if (activePane.id === overPane.id) {
      // Same pane — reorder within this pane's tabIds
      const tabIds = [...activePane.tabIds];
      const oldIdx = tabIds.indexOf(activeTabId);
      const newIdx = tabIds.indexOf(overTabId);
      if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx) {
        tabIds.splice(oldIdx, 1);
        tabIds.splice(newIdx, 0, activeTabId);
        reorderPaneTabIds(activePane.id, tabIds);
      }
    } else {
      // Cross-pane — move tab to other pane
      const targetIsEmpty = overPane.tabIds.length === 0;
      moveTabToPane(activeTabId, overPane.id);
      if (!targetIsEmpty) {
        // Zustand + immer `set` is synchronous: getState() here already
        // reflects the moveTabToPane mutation above — no deferral needed.
        const updated = useAppStore.getState();
        const targetPane = updated.panes.find(p => p.id === overPane.id);
        if (targetPane && targetPane.tabIds.includes(activeTabId)) {
          const tabIds = [...targetPane.tabIds];
          const oldIdx = tabIds.indexOf(activeTabId);
          const newIdx = tabIds.indexOf(overTabId);
          if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx) {
            tabIds.splice(oldIdx, 1);
            tabIds.splice(newIdx, 0, activeTabId);
            reorderPaneTabIds(overPane.id, tabIds);
          }
        }
      }
    }
  }, [moveTabToPane, reorderPaneTabIds]);
}
