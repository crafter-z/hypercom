import React, { useEffect, useState } from 'react';
import TitleBar from './components/TitleBar/TitleBar';
import Sidebar from './components/Sidebar/Sidebar';
import MainDisplay from './components/MainDisplay/MainDisplay';
import OperationPanel from './components/OperationPanel/OperationPanel';
import StatusBar from './components/StatusBar/StatusBar';
import ConfigModal from './components/ConfigModal/ConfigModal';
import { useAppInit } from './hooks/useTauri';
import { useAppStore } from './stores/useAppStore';

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
          <div style={{ color: '#f48771', fontSize: 18, fontWeight: 'bold' }}>渲染错误</div>
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
            重试
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
  const { theme, terminalFontSize, terminalFont, uiFont, uiFontSize } = useAppStore((s) => s.config);

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

  return <>{children}</>;
};

const App: React.FC = () => {
  useAppInit();
  const sidebarWidth = useAppStore((s) => s.ui.sidebarWidth);

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
    const store = useAppStore.getState();
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
            background: 'var(--bg-primary)',
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
        </div>
      </ThemeProvider>
    </AppErrorBoundary>
  );
};

export default App;