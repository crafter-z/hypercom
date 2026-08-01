import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pin, PinOff, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { popoutService } from '../../services/tauri';
import { popoutLabel } from './popoutLabel';
import QuickSendPanel from './QuickSendPanel';

interface PopoutShellProps {
  kind: string;
  targetId: string | null;
}

/** 内容区：按 kind 分发。Phase 1 仅占位，Phase 2/3 在此接入真实面板。 */
const PopoutContent: React.FC<{ kind: string }> = ({ kind }) => {
  const { t } = useTranslation();
  switch (kind) {
    case 'quick-send':
      return <QuickSendPanel />;
    case 'terminal':
      // Phase 3: return <TerminalPopout />;
      return <div className="popout-placeholder">{t('popout.terminalPlaceholder')}</div>;
    default:
      return <div className="popout-placeholder">{kind}</div>;
  }
};

/**
 * 弹出窗外壳：自绘窄标题栏（拖拽区 + 置顶切换 + 关闭）+ 内容区。
 * 宿主无关——真实面板（QuickSendPanel / TerminalPopout）将来可复用于应用内浮层。
 */
const PopoutShell: React.FC<PopoutShellProps> = ({ kind, targetId }) => {
  const { t } = useTranslation();
  const [pinned, setPinned] = useState(true); // 建窗默认 always_on_top(true)

  const label = popoutLabel(kind, targetId);
  const title =
    kind === 'quick-send'
      ? t('popout.quickSendTitle')
      : kind === 'terminal'
        ? t('popout.terminalTitle')
        : kind;

  const handleTogglePin = () => {
    if (label == null) return;
    const next = !pinned;
    popoutService
      .setAlwaysOnTop(label, next)
      .then(() => setPinned(next))
      .catch((e) => console.debug('[PopoutShell] set_popout_always_on_top failed:', e));
  };

  const handleClose = () => {
    getCurrentWindow().close();
  };

  return (
    <div className="popout-shell">
      <div className="popout-titlebar" data-tauri-drag-region>
        <span className="popout-title" data-tauri-drag-region>
          {title}
        </span>
        <div className="popout-titlebar-actions">
          <button
            className={`icon-btn${pinned ? ' active' : ''}`}
            title={t('popout.alwaysOnTop')}
            onClick={handleTogglePin}
          >
            {pinned ? <Pin size={14} /> : <PinOff size={14} />}
          </button>
          <button className="icon-btn popout-close" title={t('popout.close')} onClick={handleClose}>
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="popout-content">
        <PopoutContent kind={kind} />
      </div>
    </div>
  );
};

export default PopoutShell;
