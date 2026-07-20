import React from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Check, Trash2 } from 'lucide-react';

/**
 * Generic accordion component for rule-set / command-set CRUD UI.
 * Eliminates the duplicated expand/collapse/save/delete structure
 * that was previously copy-pasted between HighlightSettings and CommandSettings.
 */
interface RuleSetAccordionProps<TSet extends { id: string; name: string }> {
  title: string;
  description: string;
  addLabel: string;
  emptyText: string;
  items: TSet[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
  onSave: (id: string) => void;
  onRename: (id: string, name: string) => void;
  renderHeaderExtra: (set: TSet) => React.ReactNode;
  renderEditor: (set: TSet) => React.ReactNode;
  countLabel: (set: TSet) => string;
  addItemLabel: string;
  onAddItem: (setId: string) => void;
  itemCount: (set: TSet) => number;
  emptyItemText: string;
}

function RuleSetAccordion<TSet extends { id: string; name: string }>({
  title, description, addLabel, emptyText, items, selectedId, onSelect,
  onAdd, onDelete, onSave, onRename, renderHeaderExtra, renderEditor,
  countLabel, addItemLabel, onAddItem, itemCount, emptyItemText,
}: RuleSetAccordionProps<TSet>) {
  const { t } = useTranslation();
  return (
    <div className="config-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 className="config-page-title" style={{ marginBottom: 0 }}>{title}</h3>
        <button className="btn btn-sm" onClick={onAdd}><Plus size={14} /> {addLabel}</button>
      </div>
      <p className="config-page-desc">{description}</p>

      {items.length === 0 && <div className="config-placeholder">{emptyText}</div>}

      {items.map(set => (
        <div key={set.id} style={{ border: '1px solid var(--border-color)', borderRadius: 6, marginBottom: 10, overflow: 'hidden' }}>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--bg-secondary)', cursor: 'pointer' }}
            onClick={() => onSelect(set.id)}
          >
            <span>{selectedId === set.id ? '▼' : '▶'}</span>
            <input
              className="input"
              value={set.name}
              onChange={e => onRename(set.id, e.target.value)}
              onClick={e => e.stopPropagation()}
              style={{ border: 'none', background: 'transparent', fontWeight: 600, flex: 1, minWidth: 0 }}
            />
            {renderHeaderExtra(set)}
            <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{countLabel(set)}</span>
            <button className="btn btn-icon btn-sm" title={t('ruleSetAccordion.saveToDb')} onClick={e => { e.stopPropagation(); onSave(set.id); }}>
              <Check size={14} />
            </button>
            <button className="btn btn-icon btn-sm" title={t('ruleSetAccordion.delete')} onClick={e => { e.stopPropagation(); onDelete(set.id); }}>
              <Trash2 size={14} />
            </button>
          </div>

          {selectedId === set.id && (
            <div style={{ padding: 10 }}>
              <button className="btn btn-sm" onClick={() => onAddItem(set.id)} style={{ marginBottom: 8 }}>
                <Plus size={12} /> {addItemLabel}
              </button>
              {itemCount(set) === 0 && <div className="config-placeholder" style={{ fontSize: 12 }}>{emptyItemText}</div>}
              {renderEditor(set)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default RuleSetAccordion;
