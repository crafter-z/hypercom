import React, { useEffect, useState } from 'react';
import i18n from './i18n';
import TitleBar from './components/TitleBar/TitleBar';
import Sidebar from './components/Sidebar/Sidebar';
import MainDisplay from './components/MainDisplay/MainDisplay';
import OperationPanel from './components/OperationPanel/OperationPanel';
import StatusBar from './components/StatusBar/StatusBar';
import ConfigModal from './components/ConfigModal/ConfigModal';
import FirstRunTour from './components/Tour/FirstRunTour';
import ToastContainer from './components/shared/Toast/ToastContainer';
import HotkeyHelpDialog from './components/shared/HotkeyHelpDialog';
import { useAppInit, useSerialReceive, usePinStatesSubscriber } from './hooks/useTauri';
import { useHotkeys } from './hooks/useHotkeys';
import { useAppStore } from './stores/useAppStore';
import { useTerminalStore } from './stores/useTerminalStore';
import { systemService, configService } from './services/tauri';
import { notifyError } from './stores/useToastStore';

// ==================== Error Boundary ====================

interface ErrorBoundaryState { hasError: boolean; error: Error | null; }
class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[AppErrorBoundary] Render crash:', error, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ width: '100vw', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1e1e1e', color: '#ccc', fontFamily: 'Consolas, monospace', fontSize: 14, flexDirection: 'column', gap: 12 }}>
          <div style={{ color: '#f48771', fontSize: 18, fontWeight: 'bold' }}>{i18n.t('app.errorBoundary.title')}</div>
          <div style={{ maxWidth: 600, background: '#2d2d30', padding: 16, borderRadius: 6, overflow: 'auto', maxHeight: '50vh' }}>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {this.state.error?.message}
            </pre>
          </div>
          <button
            className="btn btn-primary"
            style={{ marginTop: 8 }}
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            {i18n.t('app.errorBoundary.retry')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const SidebarResizeHandle: React.FC = () => {
  const setUIState = useAppStore((s) => s.setUIState);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.max(200, Math.min(400, e.clientX));
      setUIState({ sidebarWidth: newWidth });
    };
    const handleMouseUp = () => setDragging(false);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging, setUIState]);

  return (
    <div
      className={`sidebar-resize-handle${dragging ? ' dragging' : ''}`}
      onMouseDown={(e) => { e.preventDefault(); setDragging(true); }}
    />
  );
};

const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { theme, terminalFontSize, terminalFont, uiFont, uiFontSize, backgroundImage, preventScreenOff, preventSleep } = useAppStore((s) => s.config);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const applySystemTheme = () => {
        root.setAttribute('data-theme', mediaQuery.matches ? 'dark' : 'light');
      };
      applySystemTheme();
      mediaQuery.addEventListener('change', applySystemTheme);
      return () => mediaQuery.removeEventListener('change', applySystemTheme);
    } else {
      root.setAttribute('data-theme', theme);
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty('--font-size-terminal', `${terminalFontSize}px`);
    document.documentElement.style.setProperty('--font-terminal', terminalFont);
    document.documentElement.style.setProperty('--font-size-ui', `${uiFontSize}px`);
    document.documentElement.style.setProperty('--font-ui', uiFont);
  }, [terminalFontSize, terminalFont, uiFontSize, uiFont]);

  useEffect(() => {
    if (backgroundImage) {
      document.documentElement.style.setProperty('--bg-image', `url("${backgroundImage}")`);
    } else {
      document.documentElement.style.removeProperty('--bg-image');
    }
  }, [backgroundImage]);

  useEffect(() => {
    systemService.preventScreenOff(preventScreenOff).catch((e) => {
      console.debug('[App] preventScreenOff failed:', e);
      notifyError(e);
    });
  }, [preventScreenOff]);

  useEffect(() => {
    systemService.preventSleep(preventSleep).catch((e) => {
      console.debug('[App] preventSleep failed:', e);
      notifyError(e);
    });
  }, [preventSleep]);

  return <>{children}</>;
};

// ==================== Session snapshot persistence (F.3) ====================

/**
 * Build the session snapshot JSON from the current app state.
 * Returns null when session restore is disabled.
 */
function buildSessionSnapshot(state: ReturnType<typeof useAppStore.getState>): string | null {
  if (!state.config.restoreSession) return null;
  return JSON.stringify({
    paneTree: state.paneTree,
    tabs: state.tabs.map((t) => ({ id: t.id, title: t.title, splitPaneId: t.splitPaneId, isPinned: t.isPinned })),
    portConfigs: Object.fromEntries(
      state.tabs.map((t) => {
        const port = state.ports.find((p) => p.id === t.id);
        return [t.id, {
          baudRate: port?.baudRate ?? 115200,
          dataBits: port?.dataBits ?? 8,
          parity: port?.parity ?? 'None',
          stopBits: port?.stopBits ?? 'One',
          handshake: port?.handshake ?? 'None',
        }];
      })
    ),
  });
}

/**
 * Best-effort, fire-and-forget persistence of the session snapshot.
 * Failures are only logged — this must never throw (used from beforeunload).
 */
function saveSessionSnapshot(): void {
  try {
    const state = useAppStore.getState();
    const snapshot = buildSessionSnapshot(state);
    if (snapshot === null) return;
    const config = { ...state.config, sessionSnapshot: snapshot };
    configService.setConfig(config).catch((e) => {
      console.debug('[App] Failed to save session snapshot:', e);
    });
  } catch (e) {
    console.debug('[App] Failed to build session snapshot:', e);
  }
}

const App: React.FC = () => {
  useAppInit();
  // Serial event listeners (onSerialData / onSerialStatus / onSerialPinStates /
  // onSerialReconnectHint) are set up once at app root.
  // Send actions live on useSerialSend in OperationPanel — see SRP split in useTauri.ts.
  useSerialReceive();
  usePinStatesSubscriber();
  useHotkeys();
  const sidebarWidth = useAppStore((s) => s.ui.sidebarWidth);

  // F.3: persist the session snapshot incrementally whenever tabs/paneTree
  // change (debounced). The WebView may terminate before an async invoke
  // resolves during shutdown, so the debounced save is the primary
  // persistence path — beforeunload below is only a best-effort final flush.
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useAppStore.subscribe((state, prevState) => {
      if (state.tabs === prevState.tabs && state.paneTree === prevState.paneTree) return;
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        timeoutId = null;
        saveSessionSnapshot();
      }, 1000);
    });
    return () => {
      unsubscribe();
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, []);

  // F.3: best-effort flush on window close (failures caught — the WebView
  // may not wait for the invoke to resolve).
  useEffect(() => {
    const handleBeforeUnload = () => {
      saveSessionSnapshot();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }
      e.preventDefault();
    };
    document.addEventListener('contextmenu', handler);
    return () => document.removeEventListener('contextmenu', handler);
  }, []);

  // Enforce terminal memory limit from config (rough: 500 lines/MB)
  const memoryLimitMb = useAppStore((s) => s.config.memoryLimitMb);
  useEffect(() => {
    const maxLines = memoryLimitMb * 500;
    const store = useTerminalStore.getState();
    Object.keys(store.terminals).forEach(portId => {
      store.setTerminalConfig(portId, { maxLines });
    });
  }, [memoryLimitMb]);

  return (
    <AppErrorBoundary>
      <ThemeProvider>
        <div
          style={{
            width: '100vw',
            height: '100vh',
            minWidth: 900,
            minHeight: 600,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            backgroundColor: 'var(--bg-primary)',
          }}
        >
          <TitleBar />

          <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minWidth: 0 }}>
            <div style={{ width: sidebarWidth, flexShrink: 0, overflow: 'hidden' }}>
              <Sidebar />
            </div>
            <SidebarResizeHandle />

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 300 }}>
              <MainDisplay />
              <OperationPanel />
            </div>
          </div>

          <StatusBar />
          <ConfigModal />
          <FirstRunTour />
          <HotkeyHelpDialog />
          <ToastContainer />
        </div>
      </ThemeProvider>
    </AppErrorBoundary>
  );
};

export default App;
