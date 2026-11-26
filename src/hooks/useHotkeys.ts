/**
 * useHotkeys — 全局键盘快捷键（副作用 Hook，在 App.tsx 中挂载一次）
 *
 * 全局外壳快捷键（表单焦点内亦可用，弹窗打开时让位）：
 *   Ctrl/Cmd+B        → 切换左侧边栏显示/隐藏
 *   Ctrl/Cmd+/        → 切换快捷键帮助弹窗
 *   Ctrl/Cmd+,        → 打开设置弹窗
 *   F1                → 打开帮助中心
 *   F6 / Shift+F6     → 在分屏之间循环切换焦点
 *   Escape            → 关闭待挂载的快捷键帮助弹窗
 *
 * 非表单焦点快捷键（弹窗打开时让位）：
 *   Ctrl/Cmd+L        → 清空当前终端
 *   Ctrl/Cmd+K        → 连接/断开当前活动端口
 *   Ctrl/Cmd+F        → 委托打开当前终端搜索（未由 TerminalView 消费时）
 *   Ctrl/Cmd+W        → 关闭当前未固定标签页
 *   Ctrl+Tab / Shift  → 在当前分屏切换下一/上一标签页
 *   Ctrl/Cmd+1..9     → 切换到当前分屏第 N 个标签页
 */
import { useEffect, useRef } from 'react';
import { getActivePortId, useAppStore } from '../stores/useAppStore';
import { useSystemStore } from '../stores/useSystemStore';
import { clearTerminal } from '../utils/terminal/viewportManager';
import { collectLeaves, findLeafById } from '../utils/paneTree';
import { useSerialConnection } from './useSerialConnection';
import { isRawSerialDisplay } from '../utils/pluginViewRuntime';
import { openHelpCenter } from '../utils/help/helpNavigation';

function isFormField(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function getFocusedPaneVisibleTabIds(): string[] {
  const state = useAppStore.getState();
  const leaf = findLeafById(state.paneTree, state.focusedPaneId) ?? collectLeaves(state.paneTree)[0];
  if (!leaf) return [];
  return leaf.tabIds.filter((id) => {
    const tab = state.tabs.find((item) => item.id === id);
    return tab != null && (tab.kind !== 'serial' || !tab.poppedOut);
  });
}

export function useHotkeys(): void {
  const { toggleConnection } = useSerialConnection();

  // Keep latest callbacks in refs so the keydown listener is registered only once.
  const toggleRef = useRef(toggleConnection);
  toggleRef.current = toggleConnection;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // A terminal/editor or nested dialog may already own this key. Global
      // fallbacks must not execute the same action against a different target.
      if (e.defaultPrevented || e.isComposing) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const singleMod = ctrl && !e.shiftKey && !e.altKey;
      // Dialogs own their keyboard lifecycle even when this window listener was
      // registered first. Never connect, clear or close background UI through it.
      if ((ctrl || e.key === 'Escape' || e.key === 'F6') && document.querySelector('[aria-modal="true"]')) return;

      // Fallback while a help dialog is still waiting for its native overlay.
      if (e.key === 'Escape') {
        const system = useSystemStore.getState();
        if (system.ui.isHotkeyHelpOpen) {
          e.preventDefault();
          system.setUIState({ isHotkeyHelpOpen: false });
        }
        return;
      }

      // F1 is a documentation affordance and remains available from controls.
      if (e.key === 'F1' && !ctrl && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        void openHelpCenter();
        return;
      }

      // Non-editing shell chords work even when focus is inside a form field.
      const lowerKey = e.key.toLowerCase();
      if (singleMod && lowerKey === 'b') {
        e.preventDefault();
        const system = useSystemStore.getState();
        system.setUIState({ sidebarCollapsed: !system.ui.sidebarCollapsed });
        return;
      }
      if (singleMod && e.key === '/') {
        e.preventDefault();
        const system = useSystemStore.getState();
        system.setUIState({ isHotkeyHelpOpen: !system.ui.isHotkeyHelpOpen });
        return;
      }
      if (singleMod && e.key === ',') {
        e.preventDefault();
        useSystemStore.getState().toggleConfigModal(true);
        return;
      }

      // F6 cycles focus across split panes.
      if (e.key === 'F6' && !ctrl && !e.altKey) {
        const state = useAppStore.getState();
        const leaves = collectLeaves(state.paneTree);
        if (leaves.length > 1) {
          e.preventDefault();
          const currentIdx = leaves.findIndex((leaf) => leaf.id === state.focusedPaneId);
          const step = e.shiftKey ? -1 : 1;
          const nextLeaf = leaves[((currentIdx >= 0 ? currentIdx : 0) + step + leaves.length) % leaves.length];
          const firstVisible = nextLeaf.tabIds.find((id) => {
            const tab = state.tabs.find((item) => item.id === id);
            return tab != null && (tab.kind !== 'serial' || !tab.poppedOut);
          });
          if (firstVisible) {
            state.setActiveTab(firstVisible);
          } else {
            state.setFocusedPane(nextLeaf.id);
          }
        }
        return;
      }

      // Ignore remaining shortcuts when focus is in a form field
      if (isFormField(e.target)) return;

      if (singleMod && lowerKey === 'l') {
        e.preventDefault();
        const state = useAppStore.getState();
        const tab = state.tabs.find((item) => item.id === state.activeTabId);
        if (tab?.kind === 'serial' && isRawSerialDisplay(tab)) clearTerminal(tab.portId);
      } else if (singleMod && lowerKey === 'k') {
        e.preventDefault();
        const portId = getActivePortId(useAppStore.getState());
        if (portId) void toggleRef.current(portId);
      } else if (singleMod && lowerKey === 'f') {
        // Delegate to TerminalView when focus is outside the terminal container.
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('hypercom:open-terminal-search'));
      } else if (singleMod && lowerKey === 'w') {
        e.preventDefault();
        const state = useAppStore.getState();
        const activeTab = state.tabs.find((item) => item.id === state.activeTabId);
        if (activeTab && !activeTab.isPinned) {
          window.dispatchEvent(new CustomEvent('hypercom:close-active-tab', { detail: { tabId: activeTab.id } }));
        }
      } else if (ctrl && !e.altKey && e.key === 'Tab') {
        const visibleIds = getFocusedPaneVisibleTabIds();
        if (visibleIds.length > 1) {
          e.preventDefault();
          const state = useAppStore.getState();
          const currentIdx = state.activeTabId ? visibleIds.indexOf(state.activeTabId) : -1;
          const step = e.shiftKey ? -1 : 1;
          const nextIdx = ((currentIdx >= 0 ? currentIdx : 0) + step + visibleIds.length) % visibleIds.length;
          state.setActiveTab(visibleIds[nextIdx]);
        }
      } else if (singleMod && /^[1-9]$/.test(e.key)) {
        const visibleIds = getFocusedPaneVisibleTabIds();
        const index = Number(e.key) - 1;
        if (index < visibleIds.length) {
          e.preventDefault();
          useAppStore.getState().setActiveTab(visibleIds[index]);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}
