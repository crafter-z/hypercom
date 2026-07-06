import React, { useCallback, useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore, collectLeaves } from '../../stores/useAppStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useSerialConnection } from '../../hooks/useTauri';
import type { Encoding } from '../../types';
import TabBar from './TabBar';
import TerminalView from './TerminalView';
import { X } from 'lucide-react';
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
  const setTerminalConfig = useTerminalStore((s) => s.setTerminalConfig);
  const clearTerminal = useTerminalStore((s) => s.clearTerminal);
  const removePane = useAppStore((s) => s.removePane);
  const { closePort } = useSerialConnection();

  // Droppable target for the empty pane area — allows tabs to be
  // dragged into this pane even when it has no SortableContext.
  const { setNodeRef: setDropRef, isOver: isDropOver } = useDroppable({
    id: paneId,
    disabled: !isMultiPane,
  });

  const closeTab = useCallback((tabId: string) => {
    const port = ports.find(p => p.id === tabId);
    if (port && port.status === 'connected') {
      // Route through the full connection lifecycle (closeSerialPort +
      // updatePort(disconnected) + stopLogging) instead of bypassing it.
      closePort(tabId).catch((e) => console.debug('[MainDisplay] closePort failed:', e));
    }
    // Free terminal memory for the closed tab (lines cleared, config dropped
    // implicitly when the entry is no longer referenced).
    clearTerminal(tabId);
    storeCloseTab(tabId);
  }, [ports, closePort, clearTerminal, storeCloseTab]);

  // paneTabs must follow the pane's tabIds order, not the global tabs array order.
  // Array.filter preserves original array order, which breaks after reorderPaneTabIds.
  const paneTabs = tabIds.map(id => tabs.find(t => t.id === id)!).filter(Boolean);
  const [localActiveTabId, setLocalActiveTabId] = useState<string | null>(null);
  const displayTabId = (activeTabId && tabIds.includes(activeTabId))
    ? activeTabId
    : (localActiveTabId && tabIds.includes(localActiveTabId) ? localActiveTabId : paneTabs[0]?.id || null);
  const displayTab = paneTabs.find(t => t.id === displayTabId);
  const displayPort = ports.find(p => p.id === displayTabId);
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
            paneId={paneId}
            tabs={paneTabs}
            activeTabId={displayTabId}
            isMultiPane={isMultiPane}
            onTabClick={handleTabClick}
            onTabClose={closeTab}
            onTabPin={pinTab}
            onCloseToRight={closeTabsToRight}
            onCloseToLeft={closeTabsToLeft}
            onCloseOthers={closeOtherTabs}
            moveToPaneTargets={otherPanes}
            onMoveToPane={handleMoveTabToPane}
          />
        </div>
      </div>

      {displayTab && (
        <div className="terminal-toolbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className={`status-dot ${displayPort?.status === 'connected' ? 'connected' : displayPort?.status === 'error' ? 'error' : 'disconnected'}`} />
            <span className="terminal-toolbar-title">{displayTab.title}</span>
            <span className="terminal-toolbar-info">
              ({displayPort?.status || 'disconnected'}
              {displayPort?.baudRate ? `, ${displayPort.baudRate},${displayPort.dataBits || 8}${displayPort.parity?.[0] || 'N'}${displayPort.stopBits === 'One' ? '1' : '2'}` : ''})
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="terminal-toolbar-label">{t('pane.toolbar.encodingLabel')}</span>
            <select
              className="select terminal-toolbar-select"
              value={displayTerminal?.encoding || 'UTF-8'}
              onChange={(e) => {
                if (displayTabId) {
                  setTerminalConfig(displayTabId, { encoding: e.target.value as Encoding });
                }
              }}
            >
              <option value="ASCII">ASCII</option>
              <option value="UTF-8">UTF-8</option>
              <option value="GBK">GBK</option>
              <option value="ISO-8859-1">ISO-8859-1</option>
            </select>
          </div>
        </div>
      )}

      {paneTabs.length > 0 && displayTab ? (
        <TerminalView
          portId={displayTab.id}
          terminal={displayTerminal}
        />
      ) : paneTabs.length === 0 ? (
        <div
          ref={isMultiPane ? setDropRef : undefined}
          className={`terminal-empty-state${isDropOver ? ' drop-active' : ''}`}
          style={{ flex: 1, flexDirection: 'column', gap: 8 }}
        >
          <span style={{ opacity: 0.7 }}>
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
