import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import SortableEditorList from '../../shared/SortableEditorList';
import type { HighlightRuleSet } from '../../../types';
import RuleSetAccordion from '../RuleSetAccordion';
import HighlightRuleEditor from '../editors/HighlightRuleEditor';
import { useEntityPage } from '../hooks/useEntityPage';

const HighlightSettings: React.FC = () => {
  const { t } = useTranslation();
  const page = useEntityPage<HighlightRuleSet>({ kind: 'highlightRuleSets' });
  const updateHighlightRuleSet = page.update;
  const [lastAddedRuleId, setLastAddedRuleId] = useState<string | null>(null);

  const handleAddSet = (beforeId?: string) => {
    page.create({ id: crypto.randomUUID(), name: t('highlightSettings.addSet'), rules: [], isEnabled: true }, beforeId);
  };

  const handleAddRule = (setId: string, beforeId?: string) => {
    const set = page.items.find(s => s.id === setId);
    if (!set) return;
    const id = crypto.randomUUID();
    const rules = [...set.rules];
    const index = beforeId ? rules.findIndex(rule => rule.id === beforeId) : rules.length;
    rules.splice(index < 0 ? rules.length : index, 0, {
      id, name: t('highlightSettings.defaultRuleName', { index: rules.length + 1 }),
      pattern: '', isRegex: false, color: '#ff6b6b', bold: false, italic: false,
    });
    setLastAddedRuleId(id);
    page.update(setId, { rules });
  };

  return (
    <RuleSetAccordion<HighlightRuleSet>
      title={t('highlightSettings.accordionTitle')}
      description={t('highlightSettings.accordionDescription')}
      addLabel={t('highlightSettings.accordionAddLabel')}
      emptyText={t('highlightSettings.accordionEmptyText')}
      items={page.items}
      selectedId={page.expandedId}
      onSelect={page.toggleExpanded}
      onAdd={() => handleAddSet()}
      onInsert={handleAddSet}
      onReorder={page.reorder}
      onDiscard={page.discard}
      dirty={page.dirty}
      isDirty={page.isDirty}
      saving={page.saving}
      error={page.error}
      onDelete={page.remove}
      onSave={page.save}
      onRename={(id, name) => updateHighlightRuleSet(id, { name })}
      renderHeaderExtra={(set) => (
        <label className="checkbox-wrapper" style={{ fontSize: 11 }} onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={set.isEnabled}
            onChange={e => updateHighlightRuleSet(set.id, { isEnabled: e.target.checked })}
          /> {t('highlightSettings.enableCheckbox')}
        </label>
      )}
      renderEditor={(set) => <SortableEditorList items={set.rules} disabled={page.saving}
        onReorder={ids => page.update(set.id, { rules: ids.map(id => set.rules.find(rule => rule.id === id)!) })}
        renderItem={(rule, index, handle) => <HighlightRuleEditor
          rule={rule} handle={handle} autoFocus={rule.id === lastAddedRuleId}
          onInsert={() => handleAddRule(set.id, rule.id)}
          onInsertBelow={() => handleAddRule(set.id, set.rules[index + 1]?.id)}
          onChange={patch => page.update(set.id, { rules: set.rules.map(item => item.id === rule.id ? { ...item, ...patch } : item) })}
          onDelete={() => page.update(set.id, { rules: set.rules.filter(item => item.id !== rule.id) })}
        />} />}
      countLabel={(set) => t('highlightSettings.countLabel', { count: set.rules.length })}
      addItemLabel={t('highlightSettings.addRuleButton')}
      onAddItem={handleAddRule}
      itemCount={(set) => set.rules.length}
      emptyItemText={t('highlightSettings.emptyRulesText')}
    />
  );
};

export default HighlightSettings;
