import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { Settings, HelpCircle, Keyboard, Minus, Square, X, Minimize2, Pin, PinOff, Info } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';

const TitleBar: React.FC = () => {
  const toggleConfigModal = useAppStore((state) => state.toggleConfigModal);
  const setConfig = useAppStore((state) => state.setConfig);
  const setUIState = useAppStore((state) => state.setUIState);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const { t } = useTranslation();

  // F.5: derive active port info with primitive selectors (no unnecessary re-renders)
  const activeTabId = useAppStore((s) => s.activeTabId);
  const activePortStatus = useAppStore((s) => {
    if (!s.activeTabId) return 'none';
    return s.ports.find((p) => p.id === s.activeTabId)?.status ?? 'none';
  });
  const activePortBaudRate = useAppStore((s) => {
    if (!s.activeTabId) return null;
    return s.ports.find((p) => p.id === s.activeTabId)?.baudRate ?? null;
  });

  const titleText = useMemo(() => {
    if (activeTabId && activePortStatus === 'connected' && activePortBaudRate != null) {
      return `${activeTabId} (${activePortBaudRate}) — HyperCom`;
    }
    return 'HyperCom';
  }, [activeTabId, activePortStatus, activePortBaudRate]);

  // F.5: sync OS-level window title
  useEffect(() => {
    getCurrentWindow().setTitle(titleText).catch((e) => console.debug('[TitleBar] setTitle failed:', e));
  }, [titleText]);

  // hasSeenTour 置 false 后 FirstRunTour 自动重新挂载（无需额外状态）
  const handleShowTour = () => {
    setConfig({ hasSeenTour: false });
  };

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const setup = async () => {
      try {
        setIsMaximized(await appWindow.isMaximized());
        unlisten = await appWindow.onResized(async () => {
          setIsMaximized(await appWindow.isMaximized());
        });
        // Unmount raced ahead of registration — tear down the listener now.
        if (cancelled) {
          unlisten();
          unlisten = undefined;
        }
      } catch (e) {
        console.debug('[TitleBar] Window state setup failed:', e);
      }
    };
    setup();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleMinimize = () => {
    getCurrentWindow().minimize();
  };

  const handleMaximize = () => {
    getCurrentWindow().toggleMaximize();
  };

  const handleClose = () => {
    getCurrentWindow().close();
  };

  const handleTogglePin = () => {
    const next = !isPinned;
    getCurrentWindow()
      .setAlwaysOnTop(next)
      .then(() => setIsPinned(next))
      .catch((e) => console.debug('[TitleBar] setAlwaysOnTop failed:', e));
  };

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left" data-tauri-drag-region>
        <svg width="18" height="18" viewBox="0 0 96 96" fill="none">
          <path d="M25 18 V78 M71 18 V78 M25 48 H36 V38 H48 V58 H60 V48 H71"
                stroke="currentColor" strokeWidth="10" strokeLinecap="round" strokeLinejoin="miter"/>
        </svg>
        <span className="titlebar-title" data-tauri-drag-region>{titleText}</span>
        <span className="titlebar-version" data-tauri-drag-region>{t('titleBar.version')}</span>
      </div>

      <div className="titlebar-right">
        <button
          className="btn btn-icon btn-sm titlebar-help"
          title={isPinned ? t('titleBar.unpinOnTop') : t('titleBar.pinOnTop')}
          onClick={handleTogglePin}
        >
          {isPinned ? <PinOff size={15} /> : <Pin size={15} />}
        </button>
        <button
          className="btn btn-icon btn-sm titlebar-help"
          title={t('hotkeys.title')}
          onClick={() => setUIState({ isHotkeyHelpOpen: true })}
        >
          <Keyboard size={15} />
        </button>
        <button className="btn btn-icon btn-sm titlebar-help" title={t('titleBar.help')} onClick={handleShowTour}>
          <HelpCircle size={15} />
        </button>
        <button className="btn btn-icon btn-sm titlebar-help" title={t('titleBar.about')} onClick={() => setUIState({ isAboutOpen: true })}>
          <Info size={15} />
        </button>
        <button className="btn btn-icon btn-sm" title={t('titleBar.settings')} onClick={() => toggleConfigModal(true)}>
          <Settings size={15} />
        </button>
        <div className="titlebar-separator" />
        <button className="titlebar-control" title={t('titleBar.minimize')} onClick={handleMinimize}>
          <Minus size={15} />
        </button>
        <button className="titlebar-control" title={isMaximized ? t('titleBar.restore') : t('titleBar.maximize')} onClick={handleMaximize}>
          {isMaximized ? <Minimize2 size={13} /> : <Square size={13} />}
        </button>
        <button className="titlebar-control titlebar-close" title={t('titleBar.close')} onClick={handleClose}>
          <X size={15} />
        </button>
      </div>
    </div>
  );
};

export default TitleBar;
