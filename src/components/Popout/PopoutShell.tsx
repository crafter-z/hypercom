import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pin, PinOff, X } from 'lucide-react';
import { configService, popoutEventService, popoutService } from '../../services/tauri';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore } from '../../stores/useAppStore';
import { useSystemStore } from '../../stores/useSystemStore';
import { applyUiScale } from '../../utils/uiScale';
import { useTextEditContextMenu } from '../shared/TextEditContextMenu';
import { EditorLeaveDialog, useEditorWindowClose } from '../shared/EditorLeaveDialog';
import QuickSendPanel from './QuickSendPanel';
import TerminalPopout from './TerminalPopout';
import HelpCenter from '../Help/HelpCenter';

interface PopoutShellProps {
  kind: string;
  targetId: string | null;
  articleId?: string | null;
  anchor?: string | null;
}

/** Content routing is intentionally explicit: help has no serial/editor surface. */
const PopoutContent: React.FC<{ kind: string; targetId: string | null; articleId?: string | null; anchor?: string | null }> = ({ kind, targetId, articleId, anchor }) => {
  const { t } = useTranslation();
  switch (kind) {
    case 'quick-send':
      return <QuickSendPanel />;
    case 'terminal':
      if (!targetId) return <div className="popout-placeholder">{t('terminalPopout.noTarget')}</div>;
      return <TerminalPopout portId={targetId} />;
    case 'help':
      return <HelpCenter initialArticleId={articleId ?? 'home'} initialAnchor={anchor} />;
    default:
      return <div className="popout-placeholder">{kind}</div>;
  }
};

interface PopoutFrameProps extends PopoutShellProps {
  textEditMenuElement?: React.ReactNode;
  editorLeaveDialog?: boolean;
}

/** Shared native frame. It deliberately contains no editor or clipboard hooks. */
const PopoutFrame: React.FC<PopoutFrameProps> = ({ kind, targetId, articleId, anchor, textEditMenuElement, editorLeaveDialog = false }) => {
  const { t } = useTranslation();
  const [pinned, setPinned] = useState(true); // native windows are created on top
  const configReady = useSystemStore((s) => s.ui.configReady);
  const liveScale = useRef<number | null>(null);
  const appliedScale = useRef(false);

  useEffect(() => {
    if (kind === 'help') {
      // The Help capability is intentionally read-only and has no config IPC;
      // theme/language arrive through the main-window settings relay below.
      useSystemStore.getState().setUIState({ configReady: true });
      return undefined;
    }
    let cancelled = false;
    void configService.getConfig().then((config) => {
      if (cancelled) return;
      useAppStore.getState().setConfig(config);
      useSystemStore.getState().setUIState({ configReady: true });
    }).catch((error) => {
      console.warn('[PopoutShell] Failed to load config, using defaults:', error);
      if (!cancelled) useSystemStore.getState().setUIState({ configReady: true });
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (configReady && !appliedScale.current) {
      appliedScale.current = true;
      void applyUiScale(liveScale.current ?? useAppStore.getState().config.uiScalePercent);
    }
  }, [configReady]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void popoutEventService.onUiScaleChanged(({ percent }) => {
      if (!cancelled) {
        liveScale.current = percent;
        void applyUiScale(percent);
      }
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    }).catch((error) => console.debug('[PopoutShell] Failed to listen for UI scale:', error));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const title = kind === 'quick-send'
    ? t('popout.quickSendTitle')
    : kind === 'terminal'
      ? `${t('popout.terminalTitle')} — ${targetId ?? ''}`
      : kind === 'help'
        ? t('popout.helpTitle')
        : kind;

  const handleTogglePin = () => {
    const next = !pinned;
    popoutService.setAlwaysOnTop(kind, targetId, next)
      .then(() => setPinned(next))
      .catch((e) => console.debug('[PopoutShell] set_popout_always_on_top failed:', e));
  };
  const handleClose = () => {
    void getCurrentWindow().close().catch((e) => console.debug('[PopoutShell] close failed:', e));
  };

  return (
    <div className={`popout-shell${kind === 'help' ? ' popout-shell-help' : ''}`}>
      <div className="popout-titlebar">
        <div className="popout-titlebar-drag" data-tauri-drag-region>
          <span className="popout-title" data-tauri-drag-region>{title}</span>
        </div>
        <div className="popout-titlebar-actions" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" className={`icon-btn${pinned ? ' active' : ''}`} title={t('popout.alwaysOnTop')} aria-label={t('popout.alwaysOnTop')} aria-pressed={pinned} onClick={handleTogglePin}>
            {pinned ? <Pin size={14} /> : <PinOff size={14} />}
          </button>
          <button type="button" className="icon-btn popout-close" title={t('popout.close')} aria-label={t('popout.close')} onClick={handleClose}>
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="popout-content">
        <PopoutContent kind={kind} targetId={targetId} articleId={articleId} anchor={anchor} />
      </div>
      {textEditMenuElement}
      {editorLeaveDialog && <EditorLeaveDialog />}
    </div>
  );
};

/** Standard command/terminal popouts retain edit leave approval and clipboard menu. */
const EditablePopoutShell: React.FC<PopoutShellProps> = (props) => {
  useEditorWindowClose();
  const { element: textEditMenuElement } = useTextEditContextMenu();
  return <PopoutFrame {...props} textEditMenuElement={textEditMenuElement} editorLeaveDialog />;
};

/** Help is read-only and deliberately receives neither editor nor clipboard hooks. */
const HelpPopoutShell: React.FC<PopoutShellProps> = (props) => <PopoutFrame {...props} />;

const PopoutShell: React.FC<PopoutShellProps> = (props) => (
  props.kind === 'help' ? <HelpPopoutShell {...props} /> : <EditablePopoutShell {...props} />
);

export default PopoutShell;
