import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pin, PinOff, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { popoutService } from '../../services/tauri';
import { popoutLabel } from './popoutLabel';
import { useTextEditContextMenu } from '../shared/TextEditContextMenu';
import QuickSendPanel from './QuickSendPanel';
import TerminalPopout from './TerminalPopout';

interface PopoutShellProps {
  kind: string;
  targetId: string | null;
}

/** 内容区：按 kind 分发到真实面板（快捷发送 / 终端）。 */
const PopoutContent: React.FC<{ kind: string; targetId: string | null }> = ({ kind, targetId }) => {
  const { t } = useTranslation();
  switch (kind) {
    case 'quick-send':
      return <QuickSendPanel />;
    case 'terminal':
      // 终端弹出以 portId 为目标；缺失时降级为占位（URL 异常兜底）。
      if (!targetId) {
        return <div className="popout-placeholder">{t('terminalPopout.noTarget')}</div>;
      }
      return <TerminalPopout portId={targetId} />;
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
  // issue #7-10：弹出窗是独立 webview，同样需要自定义右键菜单替换原生菜单。
  const { element: textEditMenuElement } = useTextEditContextMenu();

  const label = popoutLabel(kind, targetId);
  // Terminal pop-out titles include the port id (e.g. "终端 — COM3") so users
  // can identify the window at a glance when multiple terminals are popped out.
  // Quick-send stays as-is (singleton, no target).
  const title =
    kind === 'quick-send'
      ? t('popout.quickSendTitle')
      : kind === 'terminal'
        ? `${t('popout.terminalTitle')} — ${targetId ?? ''}`
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
        <PopoutContent kind={kind} targetId={targetId} />
      </div>
      {textEditMenuElement}
    </div>
  );
};

export default PopoutShell;
