import React, { useEffect } from 'react';
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
import AboutDialog from './components/shared/AboutDialog';
import SidebarResizeHandle from './components/shared/SidebarResizeHandle';
import OperationPanelResizeHandle from './components/shared/OperationPanelResizeHandle';
import ThemeProvider from './components/shared/ThemeProvider';
import { useAppInit, useSerialReceive, usePinStatesSubscriber, useToolOutput } from './hooks/useTauri';
import { useHotkeys } from './hooks/useHotkeys';
import { usePowerManagement } from './hooks/usePowerManagement';
import { useAppStore } from './stores/useAppStore';
import { useTerminalStore } from './stores/useTerminalStore';
import { saveSessionSnapshot } from './utils/sessionSnapshot';

// ==================== Error Boundary ====================
// Inline styles are intentional: this must render even if CSS fails to load.

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

const App: React.FC = () => {
  useAppInit();
  // Serial event listeners (onSerialData / onSerialStatus / onSerialPinStates /
  // onSerialReconnectHint) are set up once at app root.
  // Send actions live on useSerialSend in OperationPanel — see SRP split in useTauri.ts.
  useSerialReceive();
  usePinStatesSubscriber();
  useToolOutput();
  useHotkeys();
  usePowerManagement();
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
        <div className="app-root">
          <TitleBar />

          <div className="app-main">
            <div className="app-sidebar-col" style={{ width: sidebarWidth }}>
              <Sidebar />
            </div>
            <SidebarResizeHandle />

            <div className="app-content-col">
              <MainDisplay />
              <OperationPanelResizeHandle />
              <OperationPanel />
            </div>
          </div>

          <StatusBar />
          <ConfigModal />
          <FirstRunTour />
          <HotkeyHelpDialog />
          <AboutDialog />
          <ToastContainer />
        </div>
      </ThemeProvider>
    </AppErrorBoundary>
  );
};

export default App;
