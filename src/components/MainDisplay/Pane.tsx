import React, { useCallback, useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore, collectLeaves } from '../../stores/useAppStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useSerialConnection } from '../../hooks/useTauri';
import { notifyError } from '../../stores/useToastStore';
import TabBar from './TabBar';
import TerminalView from './TerminalView';
import { X, Cable } from 'lucide-react';
import { useDroppable } from '@dnd-kit/core';

interface PaneProps {
  paneId: string;
  tabIds: string[];
  size: number;
  isFocused: boolean;
  isMultiPane: boolean;
  onFocus: () => void;
}

const Pane: React.FC<PaneProps> = ({ paneId, tabIds, isFocused, isMultiPane, onFocus }) => {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const ports = useAppStore((s) => s.ports);
  const paneTree = useAppStore((s) => s.paneTree);
  const { t } = useTranslation();
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const storeCloseTab = useAppStore((s) => s.closeTab);
  const pinTab = useAppStore((s) => s.pinTab);
  const closeTabsToRight = useAppStore((s) => s.closeTabsToRight);
  const closeTabsToLeft = useAppStore((s) => s.closeTabsToLeft);
  const closeOtherTabs = useAppStore((s) => s.closeOtherTabs);
  const moveTabToPane = useAppStore((s) => s.moveTabToPane);
  const splitPane = useAppStore((s) => s.splitPane);
  const clearTerminal = useTerminalStore((s) => s.clearTerminal);
  const removePane = useAppStore((s) => s.removePane);
  const { closePort } = useSerialConnection();

  // Droppable target for the empty pane area — allows tabs to be
  // dragged into this pane even when it has no SortableContext.
  const { setNodeRef: setDropRef, isOver: isDropOver } = useDroppable({
    id: paneId,
    disabled: !isMultiPane,
  });

  // Shared per-tab close lifecycle: route connected ports through closePort()
  // (stopLogging + status update) and free the terminal buffer. Used by both
  // the single-tab close and the bulk-close wrappers below so bulk actions
  // never bypass the closeTab lifecycle invariant (no log-handle/memory leak).
  const cleanupClosedTab = useCallback((tabId: string) => {
    const port = ports.find(p => p.id === tabId);
    if (port && port.status === 'connected') {
      closePort(tabId).catch((e) => { console.debug('[MainDisplay] closePort failed:', e); notifyError(e); });
    }
    clearTerminal(tabId);
  }, [ports, closePort, clearTerminal]);

  const closeTab = useCallback((tabId: string) => {
    cleanupClosedTab(tabId);
    storeCloseTab(tabId);
  }, [cleanupClosedTab, storeCloseTab]);

  // Bulk-close wrappers: run the close lifecycle for EACH tab about to be
  // closed, computing the close set the SAME way the store action does.
  // close-to-right/left are pane-scoped (this leaf's tabIds order); the store
  // action is invoked afterwards to mutate state.
  const handleCloseToRight = useCallback((tabId: string) => {
    const idx = tabIds.indexOf(tabId);
    if (idx >= 0) {
      for (const id of tabIds.slice(idx + 1)) {
        const tab = tabs.find(t => t.id === id);
        if (!tab || tab.isPinned) continue;
        cleanupClosedTab(id);
      }
    }
    closeTabsToRight(tabId);
  }, [tabIds, tabs, cleanupClosedTab, closeTabsToRight]);

  const handleCloseToLeft = useCallback((tabId: string) => {
    const idx = tabIds.indexOf(tabId);
    if (idx > 0) {
      for (const id of tabIds.slice(0, idx)) {
        const tab = tabs.find(t => t.id === id);
        if (!tab || tab.isPinned) continue;
        cleanupClosedTab(id);
      }
    }
    closeTabsToLeft(tabId);
  }, [tabIds, tabs, cleanupClosedTab, closeTabsToLeft]);

  // close-others is global in the store (keeps only target + pinned across all
  // panes), so run the lifecycle for every non-pinned tab except the target.
  const handleCloseOthers = useCallback((tabId: string) => {
    for (const tab of tabs) {
      if (tab.id === tabId || tab.isPinned) continue;
      cleanupClosedTab(tab.id);
    }
    closeOtherTabs(tabId);
  }, [tabs, cleanupClosedTab, closeOtherTabs]);

  // paneTabs must follow the pane's tabIds order, not the global tabs array order.
  // Array.filter preserves original array order, which breaks after reorderPaneTabIds.
  const paneTabs = tabIds.map(id => tabs.find(t => t.id === id)!).filter(Boolean);
  const [localActiveTabId, setLocalActiveTabId] = useState<string | null>(null);
  const displayTabId = (activeTabId && tabIds.includes(activeTabId))
    ? activeTabId
    : (localActiveTabId && tabIds.includes(localActiveTabId) ? localActiveTabId : paneTabs[0]?.id || null);
  const displayTab = paneTabs.find(t => t.id === displayTabId);
  // Subscribe only to the active terminal — avoids re-rendering on data from other ports (defect #24)
  const displayTerminal = useTerminalStore((s) => (displayTabId ? s.terminals[displayTabId] : undefined));

  const otherPanes = useMemo(
    () => collectLeaves(paneTree).filter(l => l.id !== paneId),
    [paneTree, paneId],
  );

  const handleTabClick = useCallback((tabId: string) => {
    onFocus();
    setActiveTab(tabId);
    setLocalActiveTabId(tabId);
  }, [onFocus, setActiveTab]);

  const handleMoveTabToPane = useCallback((tabId: string, targetPaneId: string) => {
    moveTabToPane(tabId, targetPaneId);
    if (tabId === localActiveTabId && paneTabs.length <= 1) {
      setLocalActiveTabId(null);
    }
  }, [moveTabToPane, localActiveTabId, paneTabs.length]);

  useEffect(() => {
    if (localActiveTabId && !tabIds.includes(localActiveTabId)) {
      setLocalActiveTabId(tabIds[0] || null);
    }
  }, [tabIds, localActiveTabId]);

  return (
    <div
      className={`pane-container-inner${isFocused ? ' pane-focused' : ''}`}
      onClick={onFocus}
    >
      <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-secondary)' }}>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <TabBar
            tabs={paneTabs}
            activeTabId={displayTabId}
            isMultiPane={isMultiPane}
            onTabClick={handleTabClick}
            onTabClose={closeTab}
            onTabPin={pinTab}
            onCloseToRight={handleCloseToRight}
            onCloseToLeft={handleCloseToLeft}
            onCloseOthers={handleCloseOthers}
            moveToPaneTargets={otherPanes}
            onMoveToPane={handleMoveTabToPane}
            onSplitVertical={() => { onFocus(); splitPane('vertical'); }}
            onSplitHorizontal={() => { onFocus(); splitPane('horizontal'); }}
          />
        </div>
      </div>

      {paneTabs.length > 0 && displayTab ? (
        <TerminalView
          key={displayTab.id}
          portId={displayTab.id}
          terminal={displayTerminal}
        />
      ) : paneTabs.length === 0 ? (
        <div
          ref={isMultiPane ? setDropRef : undefined}
          className={`terminal-empty-state${isDropOver ? ' drop-active' : ''}`}
        >
          <Cable size={30} strokeWidth={1.5} className="empty-state-icon" />
          <span className="empty-state-text">
            {isDropOver ? t('pane.emptyState.dropToMove') : isMultiPane ? t('pane.emptyState.dropOrDoubleClick') : t('pane.emptyState.doubleClick')}
          </span>
          {isMultiPane && (
            <button
              className="btn btn-sm"
              title={t('pane.emptyState.closePane')}
              onClick={(e) => { e.stopPropagation(); removePane(paneId); }}
            >
              <X size={12} /> {t('pane.emptyState.closePaneButton')}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
};

export default Pane;
