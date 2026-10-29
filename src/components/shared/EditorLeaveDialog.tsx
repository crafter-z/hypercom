import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { systemService } from '../../services/tauri';
import { getEditorLeaveDialogState, registerEditorParticipant, requestEditorLeave, respondEditorLeave, subscribeEditorLeave } from '../../utils/editorLeave';
import { listDirtyEntityKinds, saveEntityDraft, discardEntityDraft } from '../../utils/entityEditor';
import type { EntityKey } from '../../utils/entityEditor';
import { usePluginViewOverlay } from './usePluginViewOverlay';

let nativeCloseInFlight: Promise<void> | null = null;

function enqueueNativeClose(close: () => Promise<void>): void {
  if (nativeCloseInFlight) return;
  const run = (async () => {
    if (await requestEditorLeave()) await close();
  })().catch(error => console.debug('[EditorLeave] close approval failed:', error));
  nativeCloseInFlight = run.finally(() => { nativeCloseInFlight = null; });
}

/** Install the native close guard once for the current WebView. */
export function useEditorWindowClose(): void {
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const setup = async () => {
      try {
        if (appWindow.label === 'main') {
          unlisten = await listen<boolean>('editor:close-requested', event => {
            if (disposed) return;
            enqueueNativeClose(() => systemService.completeEditorClose(event.payload));
          });
        } else {
          unlisten = await appWindow.onCloseRequested(event => {
            event.preventDefault();
            enqueueNativeClose(() => appWindow.destroy());
          });
        }
        if (disposed) unlisten?.();
      } catch (error) {
        console.debug('[EditorLeave] native close listener setup failed:', error);
      }
    };
    void setup();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

const ENTITY_LABELS: Record<EntityKey, string> = {
  sendCommandSets: 'configModal.nav.commands',
  highlightRuleSets: 'configModal.nav.highlight',
  protocolTemplates: 'configModal.nav.protocol',
  triggerRules: 'config.triggerSettings',
  portToolConfigs: 'configModal.nav.tools',
};

function useEntityLeaveParticipant(): void {
  const { t } = useTranslation();
  useEffect(() => {
    if (getCurrentWindow().label !== 'main') return undefined;
    return registerEditorParticipant('entity-editor', {
      isDirty: () => listDirtyEntityKinds().length > 0,
      save: async () => {
        for (const kind of listDirtyEntityKinds()) {
          if (!(await saveEntityDraft(kind))) return false;
        }
        return true;
      },
      discard: () => {
        for (const kind of listDirtyEntityKinds()) discardEntityDraft(kind);
      },
      label: () => listDirtyEntityKinds().map(kind => t(ENTITY_LABELS[kind])).join(', '),
    });
  }, [t]);
}

/** Mount exactly once per WebView, normally directly under App/PopoutShell. */
export const EditorLeaveDialog: React.FC = () => {
  useEntityLeaveParticipant();
  const state = useSyncExternalStore(subscribeEditorLeave, getEditorLeaveDialogState, getEditorLeaveDialogState);
  const { t } = useTranslation();
  const [working, setWorking] = useState(false);
  const requestRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayReady = usePluginViewOverlay(state.open);
  useEffect(() => {
    if (!state.open || !overlayReady) return;
    const previousFocus = document.activeElement;
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true }); };
  }, [state.open, overlayReady]);
  useEffect(() => {
    if (!state.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!working) void respondEditorLeave('continue');
      } else if (event.key === 'Tab') {
        const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        if (!buttons?.length) { event.preventDefault(); return; }
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [state.open, working]);
  if (!state.open || !overlayReady) return null;

  const respond = async (action: 'save' | 'discard' | 'continue') => {
    if (working) return;
    setWorking(true);
    const request = ++requestRef.current;
    await respondEditorLeave(action);
    if (request === requestRef.current) setWorking(false);
  };
  return (
    <div className="modal-overlay editor-leave-overlay" role="presentation">
      <div ref={dialogRef} className="modal-dialog-compact editor-leave-dialog" role="dialog" aria-modal="true" aria-labelledby="editor-leave-title">
        <h2 id="editor-leave-title">{t('editor.leaveTitle')}</h2>
        <p>{t('editor.leaveMessage')}</p>
        {state.labels.length > 0 && <ul>{state.labels.map((label, index) => <li key={`${label}-${index}`}>{t(label)}</li>)}</ul>}
        {state.error && <p role="alert">{t(state.error)}</p>}
        <div className="modal-content-footer">
          <button className="btn" disabled={working} onClick={() => void respond('continue')}>{t('editor.continueEditing')}</button>
          <button className="btn" disabled={working} onClick={() => void respond('discard')}>{t('editor.discardAndClose')}</button>
          <button className="btn btn-primary" disabled={working} onClick={() => void respond('save')}>{t('editor.saveAndClose')}</button>
        </div>
      </div>
    </div>
  );
};

