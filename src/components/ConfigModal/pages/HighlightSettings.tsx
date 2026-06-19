import React, { useState, useEffect } from 'react';
import { useRuleStore } from '../../../stores/useRuleStore';
import { storageService } from '../../../services/tauri';
import type { HighlightRuleSet } from '../../../types';
import RuleSetAccordion from '../RuleSetAccordion';
import HighlightRuleEditor from '../editors/HighlightRuleEditor';

const HighlightSettings: React.FC = () => {
  const highlightRuleSets = useRuleStore((s) => s.highlightRuleSets);
  const addHighlightRuleSet = useRuleStore((s) => s.addHighlightRuleSet);
  const updateHighlightRuleSet = useRuleStore((s) => s.updateHighlightRuleSet);
  const removeHighlightRuleSet = useRuleStore((s) => s.removeHighlightRuleSet);
  const [expandedSetId, setExpandedSetId] = useState<string | null>(null);

  useEffect(() => {
    storageService.loadHighlightSets().then(sets => {
      if (sets.length > 0) {
        useRuleStore.getState().setHighlightRuleSets(sets.map(s => ({
          id: s.id,
          name: s.name,
          isEnabled: s.is_enabled,
          rules: s.rules.map(r => ({
            id: r.id,
            name: r.name,
            pattern: r.pattern,
            isRegex: r.is_regex,
            color: r.color,
            bold: r.bold,
            italic: r.italic,
          })),
        })));
      }
    }).catch((e) => console.debug('[ConfigModal] loadHighlightSets failed:', e));
  }, []);

  const handleRemoveSet = async (setId: string) => {
    removeHighlightRuleSet(setId);
    try { await storageService.deleteHighlightSet(setId); } catch (e) { console.error('Failed to delete highlight set from DB:', e); }
  };

  const handleSaveSet = async (setId: string) => {
    const set = useRuleStore.getState().highlightRuleSets.find(s => s.id === setId);
    if (!set) return;
    try {
      await storageService.saveHighlightSet({
        id: set.id,
        name: set.name,
        is_enabled: set.isEnabled,
        rules: set.rules.map(r => ({
          id: r.id,
          name: r.name,
          pattern: r.pattern,
          is_regex: r.isRegex,
          color: r.color || '',
          bold: r.bold || false,
          italic: r.italic || false,
        })),
      });
    } catch (err) {
      console.error('Failed to save highlight set:', err);
    }
  };

  const handleAddSet = () => {
    const id = `hl-${Date.now()}`;
    addHighlightRuleSet({ id, name: '新建规则集', rules: [], isEnabled: true });
    setExpandedSetId(id);
  };

  const handleAddRule = (setId: string) => {
    const ruleId = `rule-${Date.now()}`;
    const sets = useRuleStore.getState().highlightRuleSets;
    const set = sets.find(s => s.id === setId);
    if (set) {
      updateHighlightRuleSet(setId, {
        rules: [...set.rules, {
          id: ruleId,
          name: `规则 ${set.rules.length + 1}`,
          pattern: '',
          isRegex: false,
          color: '#ff6b6b',
          bold: false,
          italic: false,
        }]
      });
    }
  };

  const handleSelect = (id: string) => setExpandedSetId(expandedSetId === id ? null : id);

  return (
    <RuleSetAccordion<HighlightRuleSet>
      title="语法高亮规则集"
      description="管理语法高亮规则集。每个规则集包含多条规则，支持正则表达式或关键词匹配，可设置颜色、加粗、斜体。启用多个规则集可同时生效。"
      addLabel="新建规则集"
      emptyText='暂无规则集，点击"新建规则集"创建'
      items={highlightRuleSets}
      selectedId={expandedSetId}
      onSelect={handleSelect}
      onAdd={handleAddSet}
      onDelete={handleRemoveSet}
      onSave={handleSaveSet}
      onRename={(id, name) => updateHighlightRuleSet(id, { name })}
      renderHeaderExtra={(set) => (
        <label className="checkbox-wrapper" style={{ fontSize: 11 }} onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={set.isEnabled}
            onChange={e => updateHighlightRuleSet(set.id, { isEnabled: e.target.checked })}
          /> 启用
        </label>
      )}
      renderEditor={(set) => set.rules.map((rule, idx) => (
        <HighlightRuleEditor
          key={rule.id}
          rule={rule}
          onChange={(patch) => {
            const newRules = set.rules.map((r, i) => i === idx ? { ...r, ...patch } : r);
            updateHighlightRuleSet(set.id, { rules: newRules });
          }}
          onDelete={() => {
            updateHighlightRuleSet(set.id, { rules: set.rules.filter((_, i) => i !== idx) });
          }}
        />
      ))}
      countLabel={(set) => `${set.rules.length} 条规则`}
      addItemLabel="添加规则"
      onAddItem={handleAddRule}
      itemCount={(set) => set.rules.length}
      emptyItemText="暂无规则，请添加"
    />
  );
};

export default HighlightSettings;
