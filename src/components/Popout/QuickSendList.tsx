import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { flushSync } from 'react-dom';
import { ArrowDownToLine, ArrowUpToLine, Pencil, Plus, Save, Search, Send, Trash2, Undo2 } from 'lucide-react';
import { LINE_ENDING_VALUES, lineEndingLabelKey } from '../../utils/sendUtils';
import { orderedCommands, renumberCommands } from '../../utils/commandOrder';
import {
  COMMAND_BAUD_RATE,
  createCommandStep,
  foldDelayIntoRoundGap,
  getCommandStepKind,
  isSendCommand,
  isExecutableCommand,
  runsMultipleRounds,
} from '../../utils/commandSteps';
import { AfterDelayField } from '../shared/AfterDelayField';
import SortableEditorList from '../shared/SortableEditorList';
import { NumericInput } from '../shared/NumericInput';
import type { LineEnding, SendCommand, SendCommandSet } from '../../types';

/**
 * 命令集步骤是「发送命令」与「流程动作」（改本机波特率）共用的一条列表。
 * 发送和改波特率都可点击单步执行，由主窗按步骤类型分派；未知步骤不可执行。
 * 改参绝不能把空 content 当成发送命令，也不会因此启动整组流程。
 *
 * 等待不是独立步骤：它是每一步的「之后等待」（位置属性），因此 send 与
 * setParams 都显示这个字段（见 `AfterDelayField`）。
 */
function commandStepSummary(command: SendCommand): string {
  switch (getCommandStepKind(command)) {
    case 'setParams': return `${command.baudRate ?? 0} baud`;
    default: return command.content;
  }
}

/** 非发送步骤的徽标文案 key；`null` 表示这是普通发送命令（显示 STR/HEX）。 */
function commandStepBadgeKey(command: SendCommand): string | null {
  switch (getCommandStepKind(command)) {
    case 'setParams': return 'sendCmdEditor.kind.setParams';
    case 'unknown': return 'sendCmdEditor.kind.unknown';
    default: return null;
  }
}

/**
 * 「之后等待」字段在 `components/shared/AfterDelayField.tsx`——与设置页共用
 * 同一份实现（标签、单位、轮末说明、并入轮间间隔都只有一处）。
 */

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
  conflict?: boolean;
  onReplaceSets: (sets: SendCommandSet[]) => void;
  onSave: () => Promise<boolean>;
  onDiscard: () => Promise<boolean>;
  onOverwriteHost?: () => Promise<boolean>;
  onReloadHost?: () => Promise<boolean>;
}

/** Every field edits the session draft; only explicit, acknowledged Save persists. */
const QuickSendList: React.FC<QuickSendListProps> = ({
  active, sets, selectedSet, onSelectSet, flashingId, onSend, onOpenSetEditor,
  ready, dirty, dirtyIds, pending, saving, error, canSend, conflict, onReplaceSets, onSave, onDiscard,
  onOverwriteHost, onReloadHost,
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
      } else if (event.key === 'Enter' && !sendDisabled && filtered[cursor] && isExecutableCommand(filtered[cursor])) {
        event.preventDefault(); onSend(filtered[cursor]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, filtered, cursor, onSend, sendDisabled]);

  const saveDraft = async () => {
    // Commit a focused numeric buffer before the hook freezes edits for save.
    // Save stays available even while the published draft is clean: the only
    // change may still live inside that input's blur-committed text buffer.
    flushSync(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    if (await onSave()) setEditingIds({});
  };

  const updateSet = (patch: Partial<SendCommandSet>) => {
    if (selectedSet && editable) onReplaceSets(sets.map(set => set.id === selectedSet.id ? { ...set, ...patch } : set));
  };
  const updateCommand = (id: string, patch: Partial<SendCommand>) => {
    updateSet({ commands: renumberCommands(commands.map(command => command.id === id ? { ...command, ...patch } : command)) });
  };
  /**
   * 列表里每一步的「之后等待」字段（与设置页共用 `AfterDelayField`）。
   * 判轮末用**未过滤**的 `commands`：搜索只是隐藏了几行，不能把位置判断改掉。
   */
  const renderDelayField = (command: SendCommand) => (
    <AfterDelayField
      delay={command.delay ?? 0}
      onCommit={delay => updateCommand(command.id, { delay })}
      isRoundFinal={commands.length > 0 && commands[commands.length - 1].id === command.id}
      loops={selectedSet ? runsMultipleRounds(selectedSet) : false}
      onFoldIntoRoundGap={() => {
        if (!selectedSet) return;
        updateSet(foldDelayIntoRoundGap(selectedSet, command.id));
      }}
    />
  );
  const insertCommand = (beforeId?: string) => {
    const index = beforeId ? commands.findIndex(item => item.id === beforeId) : commands.length;
    // 与设置页共用同一个工厂：两处新建发送命令的默认值（间隔 100ms、行尾 \r\n）
    // 必须一致，否则「同一个命令」在两个编辑器里诞生出不同的时序。
    const command = createCommandStep('send', crypto.randomUUID(), t('commandSettings.defaultCommandName', { index: commands.length + 1 }));
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
        <button type="button" className="btn btn-sm" disabled={!ready || saving} onClick={() => { void saveDraft(); }}><Save size={12} />{t('editor.save')}</button>
        <button type="button" className="btn btn-sm" disabled={!ready || saving || !dirty && !pending} onClick={() => { void onDiscard().then(discarded => { if (discarded) setEditingIds({}); }); }}><Undo2 size={12} />{t('editor.discard')}</button>
      </div>
      {error && <div className="quicksend-draft-error" role="alert">
        <span>{error.startsWith('editor.') ? t(error) : error}</span>
        {conflict && onOverwriteHost && onReloadHost && <span className="quicksend-conflict-actions">
          <button type="button" className="btn btn-sm" disabled={saving || pending}
            onClick={() => { void onOverwriteHost(); }}>{t('editor.overwriteHostDraft')}</button>
          <button type="button" className="btn btn-sm" disabled={saving || pending}
            onClick={() => { void onReloadHost(); }}>{t('editor.reloadHostDraft')}</button>
        </span>}
      </div>}
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
            className={`quicksend-row${index === cursor ? ' is-cursor' : ''}${flashingId === command.id ? ' is-flash' : ''}${sendDisabled || !isExecutableCommand(command) ? ' is-send-disabled' : ''}`}
            role="group" aria-label={command.name}
            onMouseEnter={() => setCursor(index)} onClick={() => setCursor(index)}
            onDoubleClick={() => { if (!sendDisabled && isExecutableCommand(command)) onSend(command); }}
            title={commandStepSummary(command)}>
            <div className="quicksend-row-head">
              {handle}<span className="quicksend-name">{command.name || commandStepSummary(command)}</span>
              {commandStepBadgeKey(command)
                ? <span className="quicksend-badge">{t(commandStepBadgeKey(command)!)}</span>
                : <span className={`quicksend-badge quicksend-badge-${command.type}`}>{command.type === 'hex' ? 'HEX' : 'STR'}</span>}
              {isSendCommand(command) && <span className="quicksend-le">{t(lineEndingLabelKey(command.appendLineEnding, 'sendSection'))}</span>}
              <button type="button" className="icon-btn quicksend-edit-btn" aria-expanded={!!editingIds[command.id]} title={t('quickSend.editHint')} aria-label={t('quickSend.editCommand')}
                onClick={event => { event.stopPropagation(); setEditingIds(current => ({ ...current, [command.id]: !current[command.id] })); }}><Pencil size={12} /></button>
            </div>
            {editingIds[command.id] ? <fieldset className="quicksend-edit-form" disabled={!editable} onClick={event => event.stopPropagation()}>
              <label>{t('quickSend.namePlaceholder')}<input className="input quicksend-edit-input" value={command.name} onChange={event => updateCommand(command.id, { name: event.target.value })} /></label>
              {isSendCommand(command) ? <>
                <label>{t('quickSend.contentPlaceholder')}<textarea autoFocus className="input quicksend-edit-input" value={command.content} onChange={event => updateCommand(command.id, { content: event.target.value })} /></label>
                <div className="quicksend-edit-row">
                  <span>{t('editor.order')}: {commands.findIndex(item => item.id === command.id) + 1}</span>
                  {renderDelayField(command)}
                  <select className="select quicksend-edit-select" aria-label={t('quickSend.format')} value={command.type} onChange={event => updateCommand(command.id, { type: event.target.value as SendCommand['type'] })}>
                    <option value="string">STR</option><option value="hex">HEX</option>
                  </select>
                  <select className="select quicksend-edit-select" aria-label={t('quickSend.lineEnding')} value={command.appendLineEnding} onChange={event => updateCommand(command.id, { appendLineEnding: event.target.value as LineEnding })}>
                    {LINE_ENDING_VALUES.map(value => <option key={value} value={value}>{t(lineEndingLabelKey(value, 'sendSection'))}</option>)}
                  </select>
                </div>
              </> : <div className="quicksend-edit-row">
                <span>{t('editor.order')}: {commands.findIndex(item => item.id === command.id) + 1}</span>
                {getCommandStepKind(command) === 'setParams' && <>
                  <label>{t('sendCmdEditor.baudRate')}<NumericInput className="input quicksend-param-number"
                    min={COMMAND_BAUD_RATE[0]} max={COMMAND_BAUD_RATE[1]} value={command.baudRate ?? 115200}
                    onCommit={baudRate => updateCommand(command.id, { baudRate })} /></label>
                  {renderDelayField(command)}
                </>}
                {getCommandStepKind(command) === 'unknown' && <span role="alert">{t('editor.unknownCommandStep')}</span>}
              </div>}
            </fieldset> : <span className="quicksend-content">{commandStepSummary(command)}</span>}
            <div className="quicksend-command-actions" onClick={event => event.stopPropagation()}>
              <button type="button" className="icon-btn quicksend-send-btn" disabled={sendDisabled || !isExecutableCommand(command)} title={t('sendSection.sendButton')} aria-label={t('sendSection.sendButton')} onClick={() => onSend(command)}><Send size={12} /></button>
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
