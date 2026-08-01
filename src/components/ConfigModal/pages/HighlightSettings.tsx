import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useRuleStore } from '../../../stores/useRuleStore';
import { storageService } from '../../../services/tauri';
import { notifyError } from '../../../stores/useToastStore';
import type { HighlightRuleSet } from '../../../types';
import RuleSetAccordion from '../RuleSetAccordion';
import HighlightRuleEditor from '../editors/HighlightRuleEditor';

const HighlightSettings: React.FC = () => {
  const { t } = useTranslation();
  const highlightRuleSets = useRuleStore((s) => s.highlightRuleSets);
  const addHighlightRuleSet = useRuleStore((s) => s.addHighlightRuleSet);
  const updateHighlightRuleSet = useRuleStore((s) => s.updateHighlightRuleSet);
  const removeHighlightRuleSet = useRuleStore((s) => s.removeHighlightRuleSet);
  const [expandedSetId, setExpandedSetId] = useState<string | null>(null);

  useEffect(() => {
    storageService.loadHighlightSets().then(sets => {
      if (sets.length > 0) {
        useRuleStore.getState().setHighlightRuleSets(sets);
      }
    }).catch((e) => console.debug('[ConfigModal] loadHighlightSets failed:', e));
  }, []);

  const handleRemoveSet = async (setId: string) => {
    removeHighlightRuleSet(setId);
    try { await storageService.deleteHighlightSet(setId); } catch (e) { console.error('Failed to delete highlight set from DB:', e); notifyError(e); }
  };

  const handleSaveSet = async (setId: string) => {
    const set = useRuleStore.getState().highlightRuleSets.find(s => s.id === setId);
    if (!set) return;
    try {
      await storageService.saveHighlightSet(set);
    } catch (err) {
      console.error('Failed to save highlight set:', err);
      notifyError(err);
    }
  };

  const handleAddSet = () => {
    const id = `hl-${Date.now()}`;
    addHighlightRuleSet({ id, name: t('highlightSettings.addSet'), rules: [], isEnabled: true });
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
          name: t('highlightSettings.defaultRuleName', { index: set.rules.length + 1 }),
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
      title={t('highlightSettings.accordionTitle')}
      description={t('highlightSettings.accordionDescription')}
      addLabel={t('highlightSettings.accordionAddLabel')}
      emptyText={t('highlightSettings.accordionEmptyText')}
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
