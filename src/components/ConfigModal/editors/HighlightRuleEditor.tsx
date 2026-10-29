import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownToLine, ArrowUpToLine, Trash2 } from 'lucide-react';
import type { HighlightRule } from '../../../types';

const HighlightRuleEditor: React.FC<{
  rule: HighlightRule;
  onChange: (patch: Partial<HighlightRule>) => void;
  onDelete: () => void;
  handle?: React.ReactNode;
  onInsert?: () => void;
  onInsertBelow?: () => void;
  autoFocus?: boolean;
}> = ({ rule, onChange, onDelete, handle, onInsert, onInsertBelow, autoFocus }) => {
  const { t } = useTranslation();
  const patternRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) {
      patternRef.current?.focus();
      patternRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [autoFocus]);
  return (
    <div style={{ background: 'var(--bg-secondary)', borderRadius: 4, padding: 8, marginBottom: 6 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 6 }}>
        {handle}
        {onInsert && <button type="button" className="btn btn-icon btn-sm" title={t('editor.insertAbove')} aria-label={t('editor.insertAbove')} onClick={onInsert}><ArrowUpToLine size={12} /></button>}
        {onInsertBelow && <button type="button" className="btn btn-icon btn-sm" title={t('editor.insertBelow')} aria-label={t('editor.insertBelow')} onClick={onInsertBelow}><ArrowDownToLine size={12} /></button>}
        <input className="input" value={rule.name} onChange={e => onChange({ name: e.target.value })} placeholder={t('highlightRuleEditor.namePlaceholder')} style={{ width: 100 }} />
        <input ref={patternRef} className="input" value={rule.pattern} onChange={e => onChange({ pattern: e.target.value })} placeholder={t('highlightRuleEditor.patternPlaceholder')} style={{ flex: 1 }} />
        <label className="checkbox-wrapper" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={rule.isRegex} onChange={e => onChange({ isRegex: e.target.checked })} />{t('highlightRuleEditor.regexLabel')}
        </label>
        <input type="color" value={rule.color || '#ff6b6b'} onChange={e => onChange({ color: e.target.value })} style={{ width: 28, height: 24, border: '1px solid var(--border-color)', borderRadius: 3, padding: 0 }} />
        <label className="checkbox-wrapper" style={{ fontSize: 11 }}>
          <input type="checkbox" checked={rule.bold || false} onChange={e => onChange({ bold: e.target.checked })} />{t('highlightRuleEditor.boldLabel')}
        </label>
        <label className="checkbox-wrapper" style={{ fontSize: 11, fontStyle: 'italic' }}>
          <input type="checkbox" checked={rule.italic || false} onChange={e => onChange({ italic: e.target.checked })} />{t('highlightRuleEditor.italicLabel')}
        </label>
        <button className="btn btn-icon btn-sm" onClick={onDelete} title={t('highlightRuleEditor.deleteRule')}><Trash2 size={12} /></button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
        {t('highlightRuleEditor.previewLabel')} <span style={{
          color: rule.color || 'inherit',
          fontWeight: rule.bold ? 'bold' : 'normal',
          fontStyle: rule.italic ? 'italic' : 'normal',
        }}>{rule.pattern || t('highlightRuleEditor.emptyPattern')}</span>
      </div>
    </div>
  );
};

export default HighlightRuleEditor;
