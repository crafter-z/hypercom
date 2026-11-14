import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardPaste, Copy, Redo, Scissors, SquareDashed, Undo } from 'lucide-react';
import ContextMenu from './ContextMenu';
import type { ContextMenuEntry } from './ContextMenu';

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
 * The menu itself is the shared `ContextMenu`, so roles, roving focus and
 * keyboard navigation (Arrow/Home/End/Enter/Space/Escape) are identical to
 * every other app menu. Focus returns to the edited field on close.
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

/** Inputs whose value supports caret/selection APIs. Other types (`number`,
 *  `date`, `range`, `color`…) throw InvalidStateError from setSelectionRange. */
function supportsTextSelection(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  if (el.tagName === 'TEXTAREA') return true;
  const type = (el as HTMLInputElement).type?.toLowerCase() || 'text';
  return type === 'text' || type === 'search' || type === 'url' || type === 'tel'
    || type === 'password' || type === 'email';
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
      snapshot: supportsTextSelection(el)
        ? { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 }
        : null,
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
      const el = target as HTMLInputElement | HTMLTextAreaElement;
      if (supportsTextSelection(el)) el.select();
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
    const el = target as HTMLInputElement | HTMLTextAreaElement;
    if (supportsTextSelection(el)) el.setSelectionRange(snapshot.start, snapshot.end);
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

  const hasSelection = snapshot ? snapshot.start !== snapshot.end : savedRange != null;

  const action = (cmd: EditCommand) => () => {
    runEditCommand(target, snapshot, savedRange, cmd);
  };
  const item = (
    cmd: EditCommand,
    label: string,
    icon: React.ReactNode,
    disabled = false,
  ): ContextMenuEntry => ({
    label,
    icon,
    disabled,
    onClick: action(cmd),
  });

  // Cut/copy only make sense with an actual selection; undo/redo/paste/selectAll
  // are always offered (execCommand no-ops silently when unavailable).
  const items: ContextMenuEntry[] = [
    item('undo', t('contextMenu.undo'), <Undo size={14} />),
    item('redo', t('contextMenu.redo'), <Redo size={14} />),
    { type: 'separator' },
    item('cut', t('contextMenu.cut'), <Scissors size={14} />, !hasSelection),
    item('copy', t('contextMenu.copy'), <Copy size={14} />, !hasSelection),
    item('paste', t('contextMenu.paste'), <ClipboardPaste size={14} />),
    { type: 'separator' },
    item('selectAll', t('contextMenu.selectAll'), <SquareDashed size={14} />),
  ];

  return (
    <ContextMenu
      x={x}
      y={y}
      items={items}
      onClose={onClose}
      trigger={target}
    />
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
