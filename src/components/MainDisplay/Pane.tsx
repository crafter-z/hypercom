import React, { useCallback, useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore, collectLeaves } from '../../stores/useAppStore';
import { releaseViewportManager } from '../../utils/terminal/viewportManager';
import { useSerialConnection, usePortToolActions } from '../../hooks';
import { notifyError, notifyInfo } from '../../stores/useToastStore';
import { popoutService } from '../../services/tauri';
import { popoutLabel } from '../Popout/popoutLabel';
import TabBar from './TabBar';
import TerminalView from './TerminalView';
import TtyView from './TtyView';
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
  const setTabPoppedOut = useAppStore((s) => s.setTabPoppedOut);
  const removePane = useAppStore((s) => s.removePane);
  const { openPort, closePort } = useSerialConnection();
  const { runTool, killTool, configTool } = usePortToolActions();

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
    // 标签若已弹出，连同其独立窗一起销毁，避免遗留孤儿窗口（关窗事件随后幂等清标记）。
    if (useAppStore.getState().tabs.find(t => t.id === tabId)?.poppedOut) {
      const label = popoutLabel('terminal', tabId);
      if (label) popoutService.closePopout(label).catch((e) => console.debug('[MainDisplay] closePopout failed:', e));
    }
    // 方案B：释放环形缓冲区 + 渲染实例（标签关闭 = 缓冲销毁）。
    releaseViewportManager(tabId);
  }, [ports, closePort]);

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

  // 批量打开/断开「所有标签页」对应的串口（issue #2-1）——作用于全局 tabs
  // （跨分屏、含已弹出标签），而非仅本 pane。与侧边栏一键开/关同款
  // 100ms 节流，避免并发 open/close 在后端抢串口句柄。
  const handleConnectAllTabs = useCallback(async () => {
    for (const tab of useAppStore.getState().tabs) {
      const port = useAppStore.getState().ports.find(p => p.id === tab.id);
      if (!port || port.status === 'connected' || port.status === 'connecting') continue;
      await openPort(tab.id, port.baudRate || 115200);
      await new Promise(r => setTimeout(r, 100));
    }
  }, [openPort]);

  const handleDisconnectAllTabs = useCallback(async () => {
    for (const tab of useAppStore.getState().tabs) {
      const port = useAppStore.getState().ports.find(p => p.id === tab.id);
      if (!port || port.status !== 'connected') continue;
      await closePort(tab.id);
      await new Promise(r => setTimeout(r, 100));
    }
  }, [closePort]);

  // paneTabs must follow the pane's tabIds order, not the global tabs array order.
  // Array.filter preserves original array order, which breaks after reorderPaneTabIds.
  const paneTabs = tabIds.map(id => tabs.find(t => t.id === id)!).filter(Boolean);
  // visibleTabs: Chrome-style detach — popped-out tabs vanish from the main window's
  // TabBar but stay in the data model (tabs + paneTree.tabIds) for reattach-on-close.
  const visibleTabs = paneTabs.filter(t => !t.poppedOut);
  const [localActiveTabId, setLocalActiveTabId] = useState<string | null>(null);
  // displayTabId is always a visible (non-popped) tab or null — popped tabs never
  // render their terminal content in the main pane.
  const visibleTabIds = visibleTabs.map(t => t.id);
  const displayTabId = (activeTabId && visibleTabIds.includes(activeTabId))
    ? activeTabId
    : (localActiveTabId && visibleTabIds.includes(localActiveTabId) ? localActiveTabId : visibleTabs[0]?.id || null);
  const displayTab = visibleTabs.find(t => t.id === displayTabId);

  const otherPanes = useMemo(
    () => collectLeaves(paneTree).filter(l => l.id !== paneId),
    [paneTree, paneId],
  );

  const handleTabClick = useCallback((tabId: string) => {
    onFocus();
    setActiveTab(tabId);
    setLocalActiveTabId(tabId);
  }, [onFocus, setActiveTab]);

  // detach：标记标签弹出 + 开窗（open_popout 对已存在窗口仅聚焦，重复弹出安全）。
  // 若弹出的标签是当前活动/显示标签，焦点迁移到下一个可见（非弹出）标签，
  // 使主窗内容区不会停留在"已被弹出"的空洞状态。
  const handlePopOut = useCallback((tabId: string) => {
    // issue #11：TTY 模式暂不支持弹出窗（弹出窗是快照式独立 webview，不共享
    // ttyService/xterm 实例）——阻止 detach 并提示，避免主窗出现空洞。
    const ttyPort = useAppStore.getState().ports.find(p => p.id === tabId);
    if (ttyPort?.mode === 'tty') {
      notifyInfo('tty.popoutUnsupported');
      return;
    }
    setTabPoppedOut(tabId, true);
    const currentActiveId = useAppStore.getState().activeTabId;
    if (currentActiveId === tabId) {
      const stateTabs = useAppStore.getState().tabs;
      const nextVisible = tabIds.find(
        id => id !== tabId && !stateTabs.find(t => t.id === id)?.poppedOut,
      );
      if (nextVisible) {
        setActiveTab(nextVisible);
        setLocalActiveTabId(nextVisible);
      }
    }
    popoutService.openPopout('terminal', tabId).catch((e) => {
      console.debug('[MainDisplay] openPopout failed:', e);
      notifyError(e);
    });
  }, [setTabPoppedOut, tabIds, setActiveTab]);

  // 回贴：乐观清标记 + 关窗。Rust 关窗事件亦会清标记（幂等），先后顺序无关。
  const handleReattach = useCallback((tabId: string) => {
    setTabPoppedOut(tabId, false);
    const label = popoutLabel('terminal', tabId);
    if (label) popoutService.closePopout(label).catch((e) => console.debug('[MainDisplay] closePopout failed:', e));
  }, [setTabPoppedOut]);

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
            tabs={visibleTabs}
            activeTabId={displayTabId}
            isMultiPane={isMultiPane}
            onTabClick={handleTabClick}
            onTabClose={closeTab}
            onTabPin={pinTab}
            onCloseToRight={handleCloseToRight}
            onCloseToLeft={handleCloseToLeft}
            onCloseOthers={handleCloseOthers}
            onPopOut={handlePopOut}
            moveToPaneTargets={otherPanes}
            onMoveToPane={handleMoveTabToPane}
            onSplitVertical={() => { onFocus(); splitPane('vertical'); }}
            onSplitHorizontal={() => { onFocus(); splitPane('horizontal'); }}
            onConnectAllTabs={handleConnectAllTabs}
            onDisconnectAllTabs={handleDisconnectAllTabs}
            onRunTool={runTool}
            onKillTool={killTool}
            onConfigTool={configTool}
          />
        </div>
      </div>

      {visibleTabs.length > 0 && displayTab ? (
        <div
          className="pane-terminal-wrap"
          onClick={() => {
            // Clicking the output area activates the pane's displayed tab,
            // which also moves the operation-panel target (issue #5-8).
            const target = displayTabId;
            if (target && useAppStore.getState().activeTabId !== target) {
              setActiveTab(target); // also sets focusedPaneId via the store action
            }
          }}
        >
          {/* issue #11/#14：TTY 与 TRX 标签都**常驻挂载**——TTY 的 xterm 缓冲在
              实例内、TRX 的环形缓冲在 viewportManager 内，切走再切回都必须保留。
              非活动标签以 display:none 隐藏（`.tty-view-hidden` / TerminalView 的
              hidden prop），恢复可见时自动 re-render/re-fit。已知限制：跨 Pane
              拖拽/关闭标签仍会销毁实例（会话随实例释放）。 */}
          {visibleTabs
            .filter((tab) => ports.find((p) => p.id === tab.id)?.mode === 'tty')
            .map((tab) => (
              <TtyView key={tab.id} portId={tab.id} hidden={tab.id !== displayTabId} />
            ))}
          {visibleTabs
            .filter((tab) => ports.find((p) => p.id === tab.id)?.mode !== 'tty')
            .map((tab) => (
              <TerminalView key={tab.id} portId={tab.id} hidden={tab.id !== displayTabId} />
            ))}
        </div>
      ) : paneTabs.length > 0 ? (
        // All tabs in this pane are popped out — Chrome-style detach: content area
        // shows per-tab "popped out" hint with an explicit Reattach affordance. This
        // avoids the misleading "double-click to add port" generic empty state.
        <div className="terminal-empty-state">
          <Cable size={30} strokeWidth={1.5} className="empty-state-icon" />
          {paneTabs.filter(pt => pt.poppedOut).map((pt) => (
            <div key={pt.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span className="empty-state-text">
                {t('terminalPopout.poppedOutHint', { port: pt.title || pt.id })}
              </span>
              <button
                className="btn btn-sm"
                onClick={(e) => { e.stopPropagation(); handleReattach(pt.id); }}
              >
                {t('terminalPopout.reattach')}
              </button>
            </div>
          ))}
        </div>
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
