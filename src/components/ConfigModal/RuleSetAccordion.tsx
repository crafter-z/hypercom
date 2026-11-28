import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownToLine, ArrowUpToLine, Check, ChevronRight, Copy, Plus, Search, Trash2, Undo2, X } from 'lucide-react';
import SortableEditorList from '../shared/SortableEditorList';
import ConfirmDialog from '../shared/ConfirmDialog';

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
  onDuplicate?: (set: TSet) => void;
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
  isNonEmpty?: (set: TSet) => boolean;
  matchesFilter?: (set: TSet, query: string) => boolean;
  emptyItemText?: string;
}

function RuleSetAccordion<TSet extends { id: string; name: string }>({
  title, description, addLabel, emptyText, items, selectedId, onSelect,
  onAdd, onInsert, onDuplicate, onReorder, onDelete, onSave, onDiscard, onRename, renderHeaderExtra, renderEditor,
  dirty, isDirty, saving, error, countLabel, addItemLabel, onAddItem, itemCount, isNonEmpty, matchesFilter, emptyItemText,
}: RuleSetAccordionProps<TSet>) {
  const { t } = useTranslation();
  const [focusId, setFocusId] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState('');
  const [pendingDelete, setPendingDelete] = useState<TSet | null>(null);
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

  const normalizedQuery = filterQuery.trim().toLocaleLowerCase();
  const isFiltered = normalizedQuery.length > 0;
  const visibleItems = useMemo(() => {
    if (!isFiltered) return items;
    return items.filter(item =>
      matchesFilter ? matchesFilter(item, normalizedQuery) : item.name.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [isFiltered, items, matchesFilter, normalizedQuery]);

  const add = (beforeId?: string) => {
    setFilterQuery('');
    pendingFocus.current = true;
    if (beforeId) onInsert(beforeId); else onAdd();
  };
  const duplicate = (set: TSet) => {
    if (!onDuplicate) return;
    setFilterQuery('');
    pendingFocus.current = true;
    onDuplicate(set);
  };
  const requestDelete = (set: TSet) => {
    const nonEmpty = itemCount ? itemCount(set) > 0 : (isNonEmpty ? isNonEmpty(set) : false);
    if (nonEmpty) {
      setPendingDelete(set);
      return;
    }
    onDelete(set.id);
  };
  // Keep the status/actions region out of the clean DOM entirely. Besides
  // avoiding a persistent "Saved" message, this keeps Tab navigation focused
  // on controls that can actually do something. A reorder marks the page dirty
  // (even when no individual row is dirty), so page actions still appear.
  const showPageStatus = dirty || saving;
  return <div className="config-page" ref={root}>
    <div className="editor-page-heading">
      <h3 className="config-page-title config-visually-hidden">{title}</h3>
      {description && (
        <details className="config-page-help">
          <summary>{t('configModal.showDetails')}</summary>
          <p className="config-page-desc">{description}</p>
        </details>
      )}
      <button type="button" className="btn btn-sm" disabled={saving} onClick={() => add()}><Plus size={14} /> {addLabel}</button>
    </div>
    {items.length > 1 && (
      <div className="editor-search-row">
        <div className="editor-search-field">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            className="input editor-search-input"
            value={filterQuery}
            onChange={(event) => setFilterQuery(event.target.value)}
            placeholder={t('ruleSetAccordion.searchPlaceholder')}
            aria-label={t('ruleSetAccordion.searchPlaceholder')}
            disabled={saving}
          />
          {filterQuery && (
            <button
              type="button"
              className="btn btn-icon btn-sm"
              onClick={() => setFilterQuery('')}
              title={t('sidebar.search.clear')}
              aria-label={t('sidebar.search.clear')}
            >
              <X size={12} />
            </button>
          )}
        </div>
        {isFiltered && <span className="editor-search-hint">{t('editor.clearSearchToSort')}</span>}
      </div>
    )}
    {showPageStatus && <div className="editor-status" aria-live="polite">
      <span>{t(saving ? 'editor.saving' : 'editor.unsaved')}</span>
      {dirty && <>
        <button type="button" className="btn btn-sm" disabled={saving} onClick={() => { void onSave(); }} aria-label={t('configModal.pageSave')}><Check size={14} /> {t('configModal.pageSave')}</button>
        <button type="button" className="btn btn-sm" disabled={saving} onClick={() => onDiscard()} aria-label={t('configModal.pageDiscard')}><Undo2 size={14} /> {t('configModal.pageDiscard')}</button>
      </>}
    </div>}
    {error && <div className="editor-error" role="alert">{t(error)}</div>}
    {items.length === 0 && <div className="config-placeholder">{emptyText}</div>}
    {items.length > 0 && visibleItems.length === 0 && (
      <div className="config-placeholder editor-search-empty">
        <p>{t('ruleSetAccordion.noMatches')}</p>
        <button type="button" className="btn btn-sm" onClick={() => setFilterQuery('')}>{t('trigger.clearFilters')}</button>
      </div>
    )}
    <SortableEditorList items={visibleItems} onReorder={(ids) => { if (!isFiltered) onReorder(ids); }} disabled={saving || isFiltered} renderItem={(set, _index, handle) => {
      const fullIndex = items.findIndex(item => item.id === set.id);
      return (
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
            {onDuplicate && <button type="button" className="btn btn-icon btn-sm" title={t('ruleSetAccordion.duplicate')} aria-label={t('ruleSetAccordion.duplicate')} disabled={saving} onClick={() => duplicate(set)}><Copy size={14} /></button>}
            <button type="button" className="btn btn-icon btn-sm" title={t('editor.insertAbove')} aria-label={t('editor.insertAbove')} disabled={saving} onClick={() => add(set.id)}><ArrowUpToLine size={14} /></button>
            <button type="button" className="btn btn-icon btn-sm" title={t('editor.insertBelow')} aria-label={t('editor.insertBelow')} disabled={saving} onClick={() => add(items[fullIndex + 1]?.id)}><ArrowDownToLine size={14} /></button>
            {isDirty(set.id) && <>
              <button type="button" className="btn btn-icon btn-sm" title={t('configModal.rowSave')} aria-label={t('configModal.rowSave')} disabled={saving} onClick={() => { void onSave(set.id); }}><Check size={14} /></button>
              <button type="button" className="btn btn-icon btn-sm" title={t('configModal.rowDiscard')} aria-label={t('configModal.rowDiscard')} disabled={saving} onClick={() => onDiscard(set.id)}><Undo2 size={14} /></button>
            </>}
            <button type="button" className="btn btn-icon btn-sm" title={t('ruleSetAccordion.delete')} aria-label={t('ruleSetAccordion.delete')} disabled={saving} onClick={() => requestDelete(set)}><Trash2 size={14} /></button>
          </div>
          {selectedId === set.id && <div className="editor-accordion-body">
            {onAddItem && itemCount && itemCount(set) === 0 && <div className="config-placeholder">{emptyItemText}</div>}
            {renderEditor(set)}
            {onAddItem && <button type="button" className="btn btn-sm" disabled={saving} onClick={() => onAddItem(set.id)}><Plus size={12} /> {addItemLabel}</button>}
          </div>}
        </div>
      );
    }} />
    <ConfirmDialog
      open={pendingDelete !== null}
      title={t('ruleSetAccordion.deleteConfirmTitle')}
      message={pendingDelete ? t('ruleSetAccordion.deleteConfirmMessage', { name: pendingDelete.name }) : ''}
      confirmLabel={t('ruleSetAccordion.delete')}
      cancelLabel={t('confirmDialog.cancel')}
      danger
      onConfirm={() => {
        if (pendingDelete) onDelete(pendingDelete.id);
        setPendingDelete(null);
      }}
      onCancel={() => setPendingDelete(null)}
    />
  </div>;
}

export default RuleSetAccordion;
