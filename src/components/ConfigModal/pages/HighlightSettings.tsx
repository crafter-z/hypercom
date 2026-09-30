import React from 'react';
import { useTranslation } from 'react-i18next';
import { useRuleStore } from '../../../stores/useRuleStore';
import { storageService } from '../../../services/tauri';
import type { HighlightRuleSet } from '../../../types';
import RuleSetAccordion from '../RuleSetAccordion';
import HighlightRuleEditor from '../editors/HighlightRuleEditor';
import { useEntityPage } from '../hooks/useEntityPage';

const HighlightSettings: React.FC = () => {
  const { t } = useTranslation();
  const highlightRuleSets = useRuleStore((s) => s.highlightRuleSets);
  const updateHighlightRuleSet = useRuleStore((s) => s.updateHighlightRuleSet);

  const page = useEntityPage<HighlightRuleSet>({
    items: highlightRuleSets,
    label: 'HighlightSettings',
    ops: {
      load: () => storageService.loadHighlightSets(),
      read: () => useRuleStore.getState().highlightRuleSets,
      replace: (items) => useRuleStore.getState().setHighlightRuleSets(items),
      add: (set) => useRuleStore.getState().addHighlightRuleSet(set),
      drop: (id) => useRuleStore.getState().removeHighlightRuleSet(id),
      persist: (set) => storageService.saveHighlightSet(set),
      remove: (id) => storageService.deleteHighlightSet(id),
    },
  });

  const handleAddSet = () => {
    page.create({ id: `hl-${Date.now()}`, name: t('highlightSettings.addSet'), rules: [], isEnabled: true });
  };

  const handleAddRule = (setId: string) => {
    const set = useRuleStore.getState().highlightRuleSets.find(s => s.id === setId);
    if (!set) return;
    updateHighlightRuleSet(setId, {
      rules: [...set.rules, {
        id: `rule-${Date.now()}`,
        name: t('highlightSettings.defaultRuleName', { index: set.rules.length + 1 }),
        pattern: '',
        isRegex: false,
        color: '#ff6b6b',
        bold: false,
        italic: false,
      }],
    });
  };

  return (
    <RuleSetAccordion<HighlightRuleSet>
      title={t('highlightSettings.accordionTitle')}
      description={t('highlightSettings.accordionDescription')}
      addLabel={t('highlightSettings.accordionAddLabel')}
      emptyText={t('highlightSettings.accordionEmptyText')}
      items={highlightRuleSets}
      selectedId={page.expandedId}
      onSelect={page.toggleExpanded}
      onAdd={handleAddSet}
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
      countLabel={(set) => t('highlightSettings.countLabel', { count: set.rules.length })}
      addItemLabel={t('highlightSettings.addRuleButton')}
      onAddItem={handleAddRule}
      itemCount={(set) => set.rules.length}
      emptyItemText={t('highlightSettings.emptyRulesText')}
    />
  );
};

export default HighlightSettings;
