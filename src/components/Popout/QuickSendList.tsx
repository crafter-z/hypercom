import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownToLine, ArrowUpToLine, Pencil, Plus, Save, Search, Trash2, Undo2 } from 'lucide-react';
import { LINE_ENDING_VALUES, lineEndingLabelKey } from '../../utils/sendUtils';
import { orderedCommands, renumberCommands } from '../../utils/commandOrder';
import SortableEditorList from '../shared/SortableEditorList';
import { NumericInput } from '../shared/NumericInput';
import type { LineEnding, SendCommand, SendCommandSet } from '../../types';

interface QuickSendListProps {
  sets: SendCommandSet[];
  active: boolean;
  selectedSet: SendCommandSet | null;
  onSelectSet: (setId: string) => void;
  flashingId: string | null;
  onSend: (cmd: SendCommand) => void;
  onOpenSetEditor: () => void;
  ready: boolean;
  dirty: boolean;
  dirtyIds: ReadonlySet<string>;
  pending: boolean;
  saving: boolean;
  error: string | null;
  canSend: boolean;
  onReplaceSets: (sets: SendCommandSet[]) => void;
  onSave: () => Promise<boolean>;
  onDiscard: () => Promise<boolean>;
}

/** Every field edits the session draft; only explicit, acknowledged Save persists. */
const QuickSendList: React.FC<QuickSendListProps> = ({
  active, sets, selectedSet, onSelectSet, flashingId, onSend, onOpenSetEditor,
  ready, dirty, dirtyIds, pending, saving, error, canSend, onReplaceSets, onSave, onDiscard,
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [editingIds, setEditingIds] = useState<Record<string, boolean>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const commands = useMemo(() => orderedCommands(selectedSet?.commands ?? []), [selectedSet]);
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return search ? commands.filter(command => command.name.toLowerCase().includes(search) || command.content.toLowerCase().includes(search)) : commands;
  }, [commands, query]);
  const editable = ready && !saving;
  const sendDisabled = !active || !canSend || !ready || saving || pending || commands.some(command => editingIds[command.id]) || !!selectedSet && dirtyIds.has(selectedSet.id);

  useEffect(() => { setCursor(value => Math.max(0, Math.min(value, filtered.length - 1))); }, [filtered.length]);
  useEffect(() => {
    listRef.current?.querySelector('.quicksend-row.is-cursor')?.scrollIntoView?.({ block: 'nearest' });
  }, [cursor, filtered.length]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!active) return;
      if (event.defaultPrevented) return;
      const target = event.target instanceof HTMLElement ? event.target : document.activeElement;
      const inSearch = target === searchRef.current;
      // In particular, never let a sortable handle's Enter/Space/arrows send.
      if (!inSearch && target instanceof HTMLElement && target.closest('input, textarea, select, button, summary, a, [contenteditable="true"]')) return;
      if (event.key === '/' && !inSearch) {
        event.preventDefault(); searchRef.current?.focus(); return;
      }
      if (inSearch && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (inSearch) searchRef.current?.blur();
        setCursor(value => Math.max(0, Math.min(value + (event.key === 'ArrowDown' ? 1 : -1), filtered.length - 1)));
      } else if (event.key === 'Enter' && !sendDisabled && filtered[cursor]) {
        event.preventDefault(); onSend(filtered[cursor]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, filtered, cursor, onSend, sendDisabled]);

  const updateSet = (patch: Partial<SendCommandSet>) => {
    if (selectedSet && editable) onReplaceSets(sets.map(set => set.id === selectedSet.id ? { ...set, ...patch } : set));
  };
  const updateCommand = (id: string, patch: Partial<SendCommand>) => {
    updateSet({ commands: renumberCommands(commands.map(command => command.id === id ? { ...command, ...patch } : command)) });
  };
  const insertCommand = (beforeId?: string) => {
    const command: SendCommand = {
      id: crypto.randomUUID(), name: t('commandSettings.defaultCommandName', { index: commands.length + 1 }),
      content: '', type: 'string', appendLineEnding: 'None', delay: 0, order: commands.length,
    };
    const index = beforeId ? commands.findIndex(item => item.id === beforeId) : commands.length;
    const next = [...commands];
    next.splice(index < 0 ? next.length : index, 0, command);
    updateSet({ commands: renumberCommands(next) });
    setEditingIds(current => ({ ...current, [command.id]: true }));
  };
  const insertSet = (beforeId?: string) => {
    const set: SendCommandSet = { id: crypto.randomUUID(), name: t('commandSettings.addSet'), commands: [], isLoop: false, loopDelay: 0, repeatCount: 0 };
    const next = [...sets];
    const index = beforeId ? sets.findIndex(item => item.id === beforeId) : next.length;
    next.splice(index < 0 ? next.length : index, 0, set);
    onReplaceSets(next);
    onSelectSet(set.id);
  };

  return <>
    <div className="quicksend-toolbar">
      <div className="quicksend-search-wrap">
        <Search size={12} className="quicksend-search-icon" />
        <input ref={searchRef} className="input quicksend-search" placeholder={t('quickSend.searchPlaceholder')}
          value={query} onChange={event => { setQuery(event.target.value); setCursor(0); }}
          onKeyDown={event => { if (event.key === 'Escape') setQuery(''); }} />
      </div>
      <div className="quicksend-set-row">
        <select className="select quicksend-set-select" value={selectedSet?.id ?? ''} disabled={!sets.length}
          title={t('quickSend.setLabel')} onChange={event => { onSelectSet(event.target.value); setCursor(0); }}>
          {sets.map(set => <option key={set.id} value={set.id}>{set.name}{dirtyIds.has(set.id) ? ' *' : ''}</option>)}
        </select>
        <button type="button" className="icon-btn" title={t('quickSend.editSet')} onClick={onOpenSetEditor}><Pencil size={13} /></button>
        <button type="button" className="icon-btn" title={t('commandSettings.addSet')} aria-label={t('commandSettings.addSet')}
          disabled={!editable} onClick={() => insertSet()}><Plus size={13} /></button>
      </div>
      <div className="quicksend-draft-actions">
        <span role="status">{t(!ready || saving || pending ? 'editor.saving' : dirty ? 'editor.unsaved' : 'editor.saved')}</span>
        <button type="button" className="btn btn-sm" disabled={!ready || saving || !dirty && !pending} onClick={() => { void onSave().then(saved => { if (saved) setEditingIds({}); }); }}><Save size={12} />{t('editor.save')}</button>
        <button type="button" className="btn btn-sm" disabled={!ready || saving || !dirty && !pending} onClick={() => { void onDiscard().then(discarded => { if (discarded) setEditingIds({}); }); }}><Undo2 size={12} />{t('editor.discard')}</button>
      </div>
      {error && <div className="quicksend-draft-error" role="alert">{error.startsWith('editor.') ? t(error) : error}</div>}
      {query.trim() && <div className="quicksend-sort-notice">{t('editor.clearSearchToSort')}</div>}
    </div>
    <div className="quicksend-list" ref={listRef}>
      <details className="quicksend-set-manager">
        <summary>{t('quickSend.editSet')}</summary>
        <SortableEditorList items={sets} disabled={!editable || !!query.trim()} onReorder={ids => onReplaceSets(ids.map(id => sets.find(set => set.id === id)!))}
          renderItem={(set, index, handle) => <div className="quicksend-set-manager-row">
            {handle}<button type="button" className="quicksend-set-name" onClick={() => onSelectSet(set.id)}>{set.name}</button>
            <button type="button" className="icon-btn" disabled={!editable} title={t('editor.insertAbove')} aria-label={t('editor.insertAbove')} onClick={() => insertSet(set.id)}><ArrowUpToLine size={12} /></button>
            <button type="button" className="icon-btn" disabled={!editable} title={t('editor.insertBelow')} aria-label={t('editor.insertBelow')} onClick={() => insertSet(sets[index + 1]?.id)}><ArrowDownToLine size={12} /></button>
            <button type="button" className="icon-btn" disabled={!editable} title={t('ruleSetAccordion.delete')} aria-label={t('ruleSetAccordion.delete')} onClick={() => onReplaceSets(sets.filter(item => item.id !== set.id))}><Trash2 size={12} /></button>
          </div>} />
      </details>
      {selectedSet && <fieldset className="quicksend-set-fields" disabled={!editable}>
        <label>{t('editor.name')}<input className="input" value={selectedSet.name} onChange={event => updateSet({ name: event.target.value })} /></label>
        <label className="quicksend-loop-label"><input type="checkbox" checked={selectedSet.isLoop} onChange={event => updateSet({ isLoop: event.target.checked })} />{t('commandSettings.loopCheckbox')}</label>
        <label>{t('commandSettings.loopDelayTooltip')}<NumericInput className="input" min={0} max={3_600_000} value={selectedSet.loopDelay} onCommit={loopDelay => updateSet({ loopDelay })} /></label>
        <label title={t('commandSettings.repeatTooltip')}>{t('commandSettings.repeatLabel')}<NumericInput className="input" min={0} max={1_000_000} value={selectedSet.repeatCount} onCommit={repeatCount => updateSet({ repeatCount })} /></label>
      </fieldset>}
      {!sets.length ? <div className="quicksend-empty">{t('quickSend.noSets')}</div> : !filtered.length ? <div className="quicksend-empty">{t('quickSend.empty')}</div> :
        <SortableEditorList items={filtered} disabled={!editable || !!query.trim()}
          onReorder={ids => updateSet({ commands: renumberCommands(ids.map(id => commands.find(command => command.id === id)!)) })}
          renderItem={(command, index, handle) => <div
            className={`quicksend-row${index === cursor ? ' is-cursor' : ''}${flashingId === command.id ? ' is-flash' : ''}${sendDisabled ? ' is-send-disabled' : ''}`}
            role="group" aria-label={command.name}
            onMouseEnter={() => setCursor(index)} onClick={() => { if (!sendDisabled) onSend(command); }} title={command.content}>
            <div className="quicksend-row-head">
              {handle}<span className="quicksend-name">{command.name || command.content}</span>
              <span className={`quicksend-badge quicksend-badge-${command.type}`}>{command.type === 'hex' ? 'HEX' : 'STR'}</span>
              <span className="quicksend-le">{t(lineEndingLabelKey(command.appendLineEnding, 'sendSection'))}</span>
              <button type="button" className="icon-btn quicksend-edit-btn" aria-expanded={!!editingIds[command.id]} title={t('quickSend.editHint')} aria-label={t('quickSend.editCommand')}
                onClick={event => { event.stopPropagation(); setEditingIds(current => ({ ...current, [command.id]: !current[command.id] })); }}><Pencil size={12} /></button>
            </div>
            {editingIds[command.id] ? <fieldset className="quicksend-edit-form" disabled={!editable} onClick={event => event.stopPropagation()}>
              <label>{t('quickSend.namePlaceholder')}<input className="input quicksend-edit-input" value={command.name} onChange={event => updateCommand(command.id, { name: event.target.value })} /></label>
              <label>{t('quickSend.contentPlaceholder')}<textarea autoFocus className="input quicksend-edit-input" value={command.content} onChange={event => updateCommand(command.id, { content: event.target.value })} /></label>
              <div className="quicksend-edit-row">
                <span>{t('editor.order')}: {commands.findIndex(item => item.id === command.id) + 1}</span>
                <label>{t('sendCmdEditor.delayPlaceholder')}<NumericInput className="input quicksend-param-number" min={0} max={3_600_000} value={command.delay}
                  onCommit={delay => updateCommand(command.id, { delay })} /></label>
                <select className="select quicksend-edit-select" aria-label={t('quickSend.format')} value={command.type} onChange={event => updateCommand(command.id, { type: event.target.value as SendCommand['type'] })}>
                  <option value="string">STR</option><option value="hex">HEX</option>
                </select>
                <select className="select quicksend-edit-select" aria-label={t('quickSend.lineEnding')} value={command.appendLineEnding} onChange={event => updateCommand(command.id, { appendLineEnding: event.target.value as LineEnding })}>
                  {LINE_ENDING_VALUES.map(value => <option key={value} value={value}>{t(lineEndingLabelKey(value, 'sendSection'))}</option>)}
                </select>
              </div>
            </fieldset> : <span className="quicksend-content">{command.content}</span>}
            <div className="quicksend-command-actions" onClick={event => event.stopPropagation()}>
              <button type="button" className="icon-btn" disabled={!editable} title={t('editor.insertAbove')} aria-label={t('editor.insertAbove')} onClick={() => insertCommand(command.id)}><ArrowUpToLine size={12} /></button>
              <button type="button" className="icon-btn" disabled={!editable} title={t('editor.insertBelow')} aria-label={t('editor.insertBelow')} onClick={() => insertCommand(commands[commands.findIndex(item => item.id === command.id) + 1]?.id)}><ArrowDownToLine size={12} /></button>
              <button type="button" className="icon-btn" disabled={!editable} title={t('sendCmdEditor.delete')} aria-label={t('sendCmdEditor.delete')} onClick={() => updateSet({ commands: renumberCommands(commands.filter(item => item.id !== command.id)) })}><Trash2 size={12} /></button>
            </div>
          </div>} />}
      {selectedSet && <button type="button" className="btn btn-sm quicksend-add-command" disabled={!editable} onClick={() => insertCommand()}><Plus size={12} />{t('commandSettings.addCommandButton')}</button>}
    </div>
  </>;
};

export default QuickSendList;
