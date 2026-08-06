import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardPaste, Copy, Redo, Scissors, SquareDashed, Undo } from 'lucide-react';

/**
 * Custom text-edit context menu (issue #7-10).
 *
 * Replaces the webview's NATIVE right-click menu inside editable elements
 * (INPUT / TEXTAREA / contentEditable) — which previously survived the App
 * root's global `contextmenu` suppressor — with the app's own menu, so the
 * copy/paste/cut/select-all actions follow the app theme and language.
 *
 * `useTextEditContextMenu()`:
 *  - intercepts `contextmenu` on editable targets at document level
 *    (component-level handlers that stopPropagation — terminal rows, sidebar,
 *    tab bar — are unaffected; they keep their own menus)
 *  - snapshots the target's selection before the menu opens (right-click does
 *    not move focus, but clicking a menu item blurs the field and drops the
 *    selection — the snapshot lets the action restore focus + selection first)
 *  - executes the edit commands via `document.execCommand` (deprecated but
 *    fully functional in WebView2/Chromium; paste requires the click's user
 *    activation, which a menu click provides)
 *
 * Non-editable targets keep the existing behavior: `preventDefault` so no
 * native menu appears. The hook therefore fully replaces App.tsx's old global
 * contextmenu effect and must be mounted once per webview root (App + popout).
 */

type EditCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';

interface SelectionSnapshot {
  start: number;
  end: number;
}

interface TextEditMenuState {
  x: number;
  y: number;
  target: HTMLElement;
  /** Input/textarea caret selection. */
  snapshot: SelectionSnapshot | null;
  /** contentEditable document selection (null when nothing inside the target). */
  savedRange: Range | null;
}

function isEditableTarget(t: EventTarget | null): t is HTMLElement {
  const el = t as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
  return el.isContentEditable;
}

/** Snapshot the target's current selection so a later menu click can restore it. */
function captureSelection(target: HTMLElement): Pick<TextEditMenuState, 'snapshot' | 'savedRange'> {
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    const el = target as HTMLInputElement | HTMLTextAreaElement;
    return {
      snapshot: { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 },
      savedRange: null,
    };
  }
  const sel = window.getSelection();
  let savedRange: Range | null = null;
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    if (target.contains(range.commonAncestorContainer)) savedRange = range.cloneRange();
  }
  return { snapshot: null, savedRange };
}

/** Run an edit command on the (re-focused) target. */
function runEditCommand(target: HTMLElement, snapshot: SelectionSnapshot | null, savedRange: Range | null, cmd: EditCommand): void {
  // Restore focus — a mousedown on the menu blurred the field and dropped its
  // selection; without this, copy/cut operate on an empty document selection.
  target.focus({ preventScroll: true });

  if (cmd === 'selectAll') {
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      (target as HTMLInputElement | HTMLTextAreaElement).select();
    } else {
      const range = document.createRange();
      range.selectNodeContents(target);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    return;
  }

  if (snapshot && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
    (target as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(snapshot.start, snapshot.end);
  } else if (savedRange) {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(savedRange);
  }

  // user activation from the menu click makes 'paste' work in WebView2.
  document.execCommand(cmd);
}

interface TextEditContextMenuProps {
  x: number;
  y: number;
  target: HTMLElement;
  snapshot: SelectionSnapshot | null;
  savedRange: Range | null;
  onClose: () => void;
}

const TextEditContextMenu: React.FC<TextEditContextMenuProps> = ({ x, y, target, snapshot, savedRange, onClose }) => {
  const { t } = useTranslation();
  const [pos, setPos] = useState({ x, y });
  const menuRef = React.useRef<HTMLDivElement>(null);

  // Keep the menu on-screen (mirrors the shared ContextMenu positioning).
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nx = x;
    let ny = y;
    if (rect.width + x > vw - 8) nx = vw - rect.width - 8;
    if (rect.height + y > vh - 8) ny = vh - rect.height - 8;
    if (nx < 0) nx = 0;
    if (ny < 0) ny = 0;
    if (nx !== x || ny !== y) setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [onClose]);

  const hasSelection = snapshot ? snapshot.start !== snapshot.end : savedRange != null;

  const action = (cmd: EditCommand) => () => {
    runEditCommand(target, snapshot, savedRange, cmd);
    onClose();
  };
  // Cut/copy only make sense with an actual selection; undo/redo/paste/selectAll
  // are always offered (execCommand no-ops silently when unavailable).
  const itemClass = (disabled: boolean) => `context-menu-item${disabled ? ' disabled' : ''}`;

  return (
    <div ref={menuRef} className="context-menu animate-fade-in" style={{ left: pos.x, top: pos.y }}>
      <div className="context-menu-item" onClick={action('undo')}>
        <span className="context-menu-icon"><Undo size={14} /></span>
        <span>{t('contextMenu.undo')}</span>
      </div>
      <div className="context-menu-item" onClick={action('redo')}>
        <span className="context-menu-icon"><Redo size={14} /></span>
        <span>{t('contextMenu.redo')}</span>
      </div>
      <div className="context-menu-separator" />
      <div className={itemClass(!hasSelection)} onClick={hasSelection ? action('cut') : undefined}>
        <span className="context-menu-icon"><Scissors size={14} /></span>
        <span>{t('contextMenu.cut')}</span>
      </div>
      <div className={itemClass(!hasSelection)} onClick={hasSelection ? action('copy') : undefined}>
        <span className="context-menu-icon"><Copy size={14} /></span>
        <span>{t('contextMenu.copy')}</span>
      </div>
      <div className="context-menu-item" onClick={action('paste')}>
        <span className="context-menu-icon"><ClipboardPaste size={14} /></span>
        <span>{t('contextMenu.paste')}</span>
      </div>
      <div className="context-menu-separator" />
      <div className="context-menu-item" onClick={action('selectAll')}>
        <span className="context-menu-icon"><SquareDashed size={14} /></span>
        <span>{t('contextMenu.selectAll')}</span>
      </div>
    </div>
  );
};

/** Global hook: mounts the text-edit menu + suppresses native context menus. */
export function useTextEditContextMenu() {
  const [state, setState] = useState<TextEditMenuState | null>(null);
  const hide = useCallback(() => setState(null), []);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (isEditableTarget(e.target)) {
        e.preventDefault();
        const target = e.target as HTMLElement;
        const { snapshot, savedRange } = captureSelection(target);
        setState({ x: e.clientX, y: e.clientY, target, snapshot, savedRange });
      } else {
        // Non-editable targets: never show the webview's native menu either
        // (this hook replaces App.tsx's old global contextmenu suppressor and
        // also covers pop-out webviews, which never mounted that suppressor).
        e.preventDefault();
      }
    };
    document.addEventListener('contextmenu', onContextMenu);
    return () => document.removeEventListener('contextmenu', onContextMenu);
  }, []);

  const element = state ? (
    <TextEditContextMenu
      x={state.x}
      y={state.y}
      target={state.target}
      snapshot={state.snapshot}
      savedRange={state.savedRange}
      onClose={hide}
    />
  ) : null;

  return { element };
}

export default TextEditContextMenu;
