import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownToLine, ArrowUpToLine, Trash2 } from 'lucide-react';
import type { HighlightRule } from '../../../types';
import '../../../styles/highlight-editor.css';

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
    <div className="highlight-rule-editor">
      <div className="highlight-rule-editor__line highlight-rule-editor__line--main">
        {handle}
        {onInsert && <button type="button" className="btn btn-icon btn-sm" title={t('editor.insertAbove')} aria-label={t('editor.insertAbove')} onClick={onInsert}><ArrowUpToLine size={12} /></button>}
        {onInsertBelow && <button type="button" className="btn btn-icon btn-sm" title={t('editor.insertBelow')} aria-label={t('editor.insertBelow')} onClick={onInsertBelow}><ArrowDownToLine size={12} /></button>}
        <input className="input highlight-rule-editor__name" value={rule.name} onChange={e => onChange({ name: e.target.value })} placeholder={t('highlightRuleEditor.namePlaceholder')} />
        <input ref={patternRef} className="input highlight-rule-editor__pattern" value={rule.pattern} onChange={e => onChange({ pattern: e.target.value })} placeholder={t('highlightRuleEditor.patternPlaceholder')} />
        <label className="checkbox-wrapper highlight-rule-editor__regex">
          <input type="checkbox" checked={rule.isRegex} onChange={e => onChange({ isRegex: e.target.checked })} />{t('highlightRuleEditor.regexLabel')}
        </label>
      </div>
      <div className="highlight-rule-editor__line highlight-rule-editor__line--style">
        <input className="highlight-rule-editor__color" type="color" value={rule.color || '#ff6b6b'} onChange={e => onChange({ color: e.target.value })} />
        <label className="checkbox-wrapper highlight-rule-editor__toggle">
          <input type="checkbox" checked={rule.bold || false} onChange={e => onChange({ bold: e.target.checked })} />{t('highlightRuleEditor.boldLabel')}
        </label>
        <label className="checkbox-wrapper highlight-rule-editor__toggle">
          <input type="checkbox" checked={rule.italic || false} onChange={e => onChange({ italic: e.target.checked })} />{t('highlightRuleEditor.italicLabel')}
        </label>
        <button type="button" className="btn btn-icon btn-sm highlight-rule-editor__delete" onClick={onDelete} title={t('highlightRuleEditor.deleteRule')} aria-label={t('highlightRuleEditor.deleteRule')}><Trash2 size={12} /></button>
        <div className="highlight-rule-editor__preview">
          {t('highlightRuleEditor.previewLabel')} <span className="highlight-rule-editor__preview-value" style={{
            color: rule.color || 'inherit',
            fontWeight: rule.bold ? 'bold' : 'normal',
            fontStyle: rule.italic ? 'italic' : 'normal',
          }}>{rule.pattern || t('highlightRuleEditor.emptyPattern')}</span>
        </div>
      </div>
    </div>
  );
};

export default HighlightRuleEditor;
