import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardPaste, Copy, Redo, Scissors, SquareDashed, Undo } from 'lucide-react';
import ContextMenu from './ContextMenu';
import type { ContextMenuEntry } from './ContextMenu';
import { writeClipboardText } from '../../utils/clipboard';
import { notifyError } from '../../stores/useToastStore';

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
 *  - copies via the shared clipboard writer; cut only deletes after a
 *    successful write and if the original value/selection is unchanged
 *  - keeps native execCommand for undo/redo/paste and deletion (undo history)
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
    || type === 'password';
}

function editableTarget(t: EventTarget | null): HTMLElement | null {
  if (!(t instanceof HTMLElement)) return null;
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return t;
  // A right click can land on a span inside an editing host. Restore focus and
  // ranges on that host, not on the non-focusable descendant. Respect explicit
  // contenteditable=false islands rather than escaping to an editable parent.
  const host = t.closest<HTMLElement>('[contenteditable]');
  return host && host.getAttribute('contenteditable') !== 'false' ? host : null;
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
async function runEditCommand(target: HTMLElement, snapshot: SelectionSnapshot | null, savedRange: Range | null, cmd: EditCommand): Promise<void> {
  if (!target.isConnected) return;
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

  if (cmd !== 'copy' && cmd !== 'cut') {
    // Keep native editing/undo semantics. Do not request additional clipboard
    // read permission for paste (popout windows intentionally lack it).
    document.execCommand(cmd);
    return;
  }

  const field = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
    ? target as HTMLInputElement | HTMLTextAreaElement : null;
  // Native password fields must not become readable via our clipboard helper.
  if (field?.type === 'password' || field?.disabled || (cmd === 'cut' && field?.readOnly)) return;
  const valueBefore = field?.value;
  const htmlBefore = target.innerHTML;
  const text = field && snapshot
    ? field.value.slice(snapshot.start, snapshot.end)
    : savedRange?.toString() ?? '';
  if (!text) return;
  const anchor = savedRange ? {
    start: savedRange.startContainer, startOffset: savedRange.startOffset,
    end: savedRange.endContainer, endOffset: savedRange.endOffset,
  } : null;

  await writeClipboardText(text);
  if (cmd !== 'cut' || !target.isConnected || document.activeElement !== target) return;

  // Clipboard IPC is asynchronous: never delete newer input or a selection the
  // user moved while the write was pending. A failed write never reaches here.
  if (field) {
    if (!snapshot || field.readOnly || field.disabled || field.value !== valueBefore
      || field.selectionStart !== snapshot.start || field.selectionEnd !== snapshot.end) return;
    if (document.execCommand?.('delete')) return;
    // Fallback only for deletion, never cut/copy: the text is already written.
    // setRangeText bypasses React's tracked value setter, so the input event
    // updates controlled inputs too, rather than leaving a stale model value.
    field.setRangeText('', snapshot.start, snapshot.end, 'start');
  } else {
    const current = window.getSelection();
    if (!anchor || !current || current.rangeCount === 0 || target.innerHTML !== htmlBefore) return;
    const range = current.getRangeAt(0);
    if (range.startContainer !== anchor.start || range.startOffset !== anchor.startOffset
      || range.endContainer !== anchor.end || range.endOffset !== anchor.endOffset) return;
    if (document.execCommand?.('delete')) return;
    range.deleteContents();
    range.collapse(true);
  }
  target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteByCut' }));
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

  const field = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
    ? target as HTMLInputElement | HTMLTextAreaElement : null;
  const hasSelection = snapshot ? snapshot.start !== snapshot.end : !!savedRange && !savedRange.collapsed;
  const canCopy = hasSelection && field?.type !== 'password' && !field?.disabled;
  const readOnly = !!field && (field.readOnly || field.disabled);

  const action = (cmd: EditCommand) => () => {
    void runEditCommand(target, snapshot, savedRange, cmd).catch(notifyError);
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
    item('cut', t('contextMenu.cut'), <Scissors size={14} />, !canCopy || readOnly),
    item('copy', t('contextMenu.copy'), <Copy size={14} />, !canCopy),
    item('paste', t('contextMenu.paste'), <ClipboardPaste size={14} />, readOnly),
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
      const target = editableTarget(e.target);
      if (target) {
        e.preventDefault();
        const { snapshot, savedRange } = captureSelection(target);
        setState({ x: e.clientX, y: e.clientY, target, snapshot, savedRange });
      } else {
        // Non-editable targets: never show the webview's native menu either
        // (this hook replaces App.tsx's old global contextmenu suppressor and
        // also covers pop-out webviews, which never mounted that suppressor).
        e.preventDefault();
      }
    };
    const onCopy = (e: ClipboardEvent) => {
      // Component-owned selections (TRX/xterm) keep their own copy handlers.
      if (e.defaultPrevented) return;
      const target = editableTarget(e.target);
      if (!target) return;
      const field = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
        ? target as HTMLInputElement | HTMLTextAreaElement : null;
      if (field?.type === 'password' || field?.disabled) return;
      const { snapshot, savedRange } = captureSelection(target);
      const text = field && snapshot
        ? field.value.slice(snapshot.start, snapshot.end) : savedRange?.toString() ?? '';
      if (!text) return;
      e.preventDefault();
      void writeClipboardText(text).catch(notifyError);
    };
    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('copy', onCopy);
    return () => {
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('copy', onCopy);
    };
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
