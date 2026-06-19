import React from 'react';
import { Trash2, GripVertical } from 'lucide-react';
import type { HighlightRule } from '../../../types';

const HighlightRuleEditor: React.FC<{
  rule: HighlightRule;
  onChange: (patch: Partial<HighlightRule>) => void;
  onDelete: () => void;
}> = ({ rule, onChange, onDelete }) => (
  <div style={{ background: 'var(--bg-secondary)', borderRadius: 4, padding: 8, marginBottom: 6 }}>
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
      <GripVertical size={12} style={{ opacity: 0.4 }} />
      <input className="input" value={rule.name} onChange={e => onChange({ name: e.target.value })} placeholder="规则名称" style={{ width: 100 }} />
      <input className="input" value={rule.pattern} onChange={e => onChange({ pattern: e.target.value })} placeholder="匹配模式" style={{ flex: 1 }} />
      <label className="checkbox-wrapper" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
        <input type="checkbox" checked={rule.isRegex} onChange={e => onChange({ isRegex: e.target.checked })} />正则
      </label>
      <input type="color" value={rule.color || '#ff6b6b'} onChange={e => onChange({ color: e.target.value })} style={{ width: 28, height: 24, border: '1px solid var(--border-color)', borderRadius: 3, padding: 0 }} />
      <label className="checkbox-wrapper" style={{ fontSize: 11 }}>
        <input type="checkbox" checked={rule.bold || false} onChange={e => onChange({ bold: e.target.checked })} />B
      </label>
      <label className="checkbox-wrapper" style={{ fontSize: 11, fontStyle: 'italic' }}>
        <input type="checkbox" checked={rule.italic || false} onChange={e => onChange({ italic: e.target.checked })} />I
      </label>
      <button className="btn btn-icon btn-sm" onClick={onDelete} title="删除规则"><Trash2 size={12} /></button>
    </div>
    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
      预览: <span style={{
        color: rule.color || 'inherit',
        fontWeight: rule.bold ? 'bold' : 'normal',
        fontStyle: rule.italic ? 'italic' : 'normal',
      }}>{rule.pattern || '(空模式)'}</span>
    </div>
  </div>
);

export default HighlightRuleEditor;
