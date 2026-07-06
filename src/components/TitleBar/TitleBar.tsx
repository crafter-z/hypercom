import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { Settings, Minus, Square, X, Minimize2 } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';

const TitleBar: React.FC = () => {
  const toggleConfigModal = useAppStore((state) => state.toggleConfigModal);
  const [isMaximized, setIsMaximized] = useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      setIsMaximized(await appWindow.isMaximized());
      unlisten = await appWindow.onResized(async () => {
        setIsMaximized(await appWindow.isMaximized());
      });
    };
    setup();
    return () => {
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

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left" data-tauri-drag-region>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-link)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
        <span className="titlebar-title" data-tauri-drag-region>{t('titleBar.appName')}</span>
        <span className="titlebar-version" data-tauri-drag-region>{t('titleBar.version')}</span>
      </div>

      <div className="titlebar-right">
        <button className="btn btn-icon btn-sm" title={t('titleBar.settings')} onClick={() => toggleConfigModal(true)}>
          <Settings size={15} />
        </button>
        <div className="titlebar-separator" />
        <button className="btn btn-icon btn-sm titlebar-control" title={t('titleBar.minimize')} onClick={handleMinimize}>
          <Minus size={15} />
        </button>
        <button className="btn btn-icon btn-sm titlebar-control" title={isMaximized ? t('titleBar.restore') : t('titleBar.maximize')} onClick={handleMaximize}>
          {isMaximized ? <Minimize2 size={13} /> : <Square size={13} />}
        </button>
        <button className="btn btn-icon btn-sm titlebar-control titlebar-close" title={t('titleBar.close')} onClick={handleClose}>
          <X size={15} />
        </button>
      </div>
    </div>
  );
};

export default TitleBar;