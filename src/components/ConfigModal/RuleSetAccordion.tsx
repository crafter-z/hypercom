import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownToLine, ArrowUpToLine, Check, ChevronRight, Plus, Trash2, Undo2 } from 'lucide-react';
import SortableEditorList from '../shared/SortableEditorList';

export interface RuleSetAccordionProps<TSet extends { id: string; name: string }> {
  title: string;
  description?: string;
  addLabel: string;
  emptyText: string;
  items: TSet[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onInsert: (beforeId: string) => void;
  onReorder: (ids: string[]) => void;
  onDelete: (id: string) => void;
  onSave: (id?: string) => Promise<boolean>;
  onDiscard: (id?: string) => void;
  onRename: (id: string, name: string) => void;
  dirty: boolean;
  isDirty: (id: string) => boolean;
  saving: boolean;
  error: string | null;
  renderHeaderExtra?: (set: TSet) => React.ReactNode;
  renderEditor: (set: TSet) => React.ReactNode;
  countLabel?: (set: TSet) => string;
  addItemLabel?: string;
  onAddItem?: (setId: string) => void;
  itemCount?: (set: TSet) => number;
  emptyItemText?: string;
}

function RuleSetAccordion<TSet extends { id: string; name: string }>({
  title, description, addLabel, emptyText, items, selectedId, onSelect,
  onAdd, onInsert, onReorder, onDelete, onSave, onDiscard, onRename, renderHeaderExtra, renderEditor,
  dirty, isDirty, saving, error, countLabel, addItemLabel, onAddItem, itemCount, emptyItemText,
}: RuleSetAccordionProps<TSet>) {
  const { t } = useTranslation();
  const [focusId, setFocusId] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef(false);
  const knownIds = useRef(new Set(items.map(item => item.id)));
  useEffect(() => {
    if (pendingFocus.current) {
      const added = items.find(item => !knownIds.current.has(item.id));
      if (added) { setFocusId(added.id); pendingFocus.current = false; }
    }
    knownIds.current = new Set(items.map(item => item.id));
  }, [items]);
  useEffect(() => {
    if (!focusId) return;
    const input = root.current?.querySelector<HTMLInputElement>(`[data-editor-name="${focusId}"]`);
    input?.focus();
    input?.select();
    input?.scrollIntoView({ block: 'nearest' });
  }, [focusId]);
  const add = (beforeId?: string) => {
    pendingFocus.current = true;
    if (beforeId) onInsert(beforeId); else onAdd();
  };
  return <div className="config-page" ref={root}>
    <div className="editor-page-heading">
      <h3 className="config-page-title">{title}</h3>
      <button type="button" className="btn btn-sm" disabled={saving} onClick={() => add()}><Plus size={14} /> {addLabel}</button>
    </div>
    {description && <p className="config-page-desc">{description}</p>}
    <div className="editor-status" aria-live="polite">
      <span>{t(saving ? 'editor.saving' : dirty ? 'editor.unsaved' : 'editor.saved')}</span>
      <button type="button" className="btn btn-sm" disabled={!dirty || saving} onClick={() => { void onSave(); }}><Check size={14} /> {t('editor.save')}</button>
      <button type="button" className="btn btn-sm" disabled={!dirty || saving} onClick={() => onDiscard()}><Undo2 size={14} /> {t('editor.discard')}</button>
    </div>
    {error && <div className="editor-error" role="alert">{t(error)}</div>}
    {items.length === 0 && <div className="config-placeholder">{emptyText}</div>}
    <SortableEditorList items={items} onReorder={onReorder} disabled={saving} renderItem={(set, index, handle) => (
      <div className="editor-accordion">
        <div className="editor-accordion-header">
          {handle}
          <button type="button" className="btn btn-icon btn-sm" aria-label={set.name} aria-expanded={selectedId === set.id} onClick={() => onSelect(set.id)}>
            <ChevronRight size={12} style={{ transform: selectedId === set.id ? 'rotate(90deg)' : undefined }} />
          </button>
          <input className="input editor-entity-name" data-editor-name={set.id} aria-label={t('editor.name')} value={set.name} onChange={event => onRename(set.id, event.target.value)} />
          {renderHeaderExtra?.(set)}
          {countLabel && <span className="editor-count">{countLabel(set)}</span>}
          {isDirty(set.id) && <span className="editor-dirty-dot" title={t('editor.unsaved')} aria-label={t('editor.unsaved')} />}
          <button type="button" className="btn btn-icon btn-sm" title={t('editor.insertAbove')} aria-label={t('editor.insertAbove')} disabled={saving} onClick={() => add(set.id)}><ArrowUpToLine size={14} /></button>
          <button type="button" className="btn btn-icon btn-sm" title={t('editor.insertBelow')} aria-label={t('editor.insertBelow')} disabled={saving} onClick={() => add(items[index + 1]?.id)}><ArrowDownToLine size={14} /></button>
          <button type="button" className="btn btn-icon btn-sm" title={t('editor.save')} aria-label={t('editor.save')} disabled={!isDirty(set.id) || saving} onClick={() => { void onSave(set.id); }}><Check size={14} /></button>
          <button type="button" className="btn btn-icon btn-sm" title={t('editor.discard')} aria-label={t('editor.discard')} disabled={!isDirty(set.id) || saving} onClick={() => onDiscard(set.id)}><Undo2 size={14} /></button>
          <button type="button" className="btn btn-icon btn-sm" title={t('ruleSetAccordion.delete')} aria-label={t('ruleSetAccordion.delete')} disabled={saving} onClick={() => onDelete(set.id)}><Trash2 size={14} /></button>
        </div>
        {selectedId === set.id && <div className="editor-accordion-body">
          {onAddItem && itemCount && itemCount(set) === 0 && <div className="config-placeholder">{emptyItemText}</div>}
          {renderEditor(set)}
          {onAddItem && <button type="button" className="btn btn-sm" disabled={saving} onClick={() => onAddItem(set.id)}><Plus size={12} /> {addItemLabel}</button>}
        </div>}
      </div>
    )} />
  </div>;
}

export default RuleSetAccordion;
