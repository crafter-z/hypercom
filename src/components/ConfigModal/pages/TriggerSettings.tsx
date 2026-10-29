import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../stores/useAppStore';
import type { TriggerMatchType, TriggerActionType, TriggerRule } from '../../../types';
import RuleSetAccordion from '../RuleSetAccordion';
import { useEntityPage } from '../hooks/useEntityPage';
import { Zap } from 'lucide-react';

const TriggerSettings: React.FC = () => {
  const { t } = useTranslation();
  const ports = useAppStore((s) => s.ports);
  const page = useEntityPage<TriggerRule>({ kind: 'triggerRules' });
  const updateTriggerRule = page.update;

  const handleAdd = (beforeId?: string) => {
    page.create({
      id: crypto.randomUUID(),
      name: t('trigger.addRule'),
      pattern: '',
      isRegex: false,
      matchType: 'contains',
      actionType: 'alert',
      actionContent: '',
      actionIsHex: false,
      isEnabled: true,
      portId: undefined,
    }, beforeId);
  };

  const matchTypeOptions: TriggerMatchType[] = ['contains', 'exact', 'regex', 'hex'];
  const actionTypeOptions: TriggerActionType[] = ['alert', 'respond'];

  return (
    <RuleSetAccordion<TriggerRule>
      title={t('config.triggerSettings')}
      addLabel={t('trigger.addRule')}
      emptyText={t('trigger.empty')}
      items={page.items}
      selectedId={page.expandedId}
      onSelect={page.toggleExpanded}
      onAdd={() => handleAdd()}
      onInsert={handleAdd}
      onReorder={page.reorder}
      onDiscard={page.discard}
      dirty={page.dirty}
      isDirty={page.isDirty}
      saving={page.saving}
      error={page.error}
      onDelete={page.remove}
      onSave={page.save}
      onRename={(id, name) => updateTriggerRule(id, { name })}
      renderHeaderExtra={(rule) => (
        <label className="checkbox-wrapper" style={{ fontSize: 11, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={rule.isEnabled}
            onChange={e => updateTriggerRule(rule.id, { isEnabled: e.target.checked })}
          /> {t('highlightSettings.enableCheckbox')}
        </label>
      )}
      renderEditor={(rule) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="config-row">
            <label>{t('trigger.pattern')}</label>
            <input
              className="input"
              value={rule.pattern}
              onChange={e => updateTriggerRule(rule.id, { pattern: e.target.value })}
              style={{ flex: 1, fontFamily: 'var(--font-terminal)' }}
            />
          </div>
          <div className="config-row">
            <label>{t('trigger.matchType')}</label>
            <select
              className="input"
              value={rule.matchType}
              onChange={e => updateTriggerRule(rule.id, { matchType: e.target.value as TriggerMatchType })}
              style={{ flex: 1 }}
            >
              {matchTypeOptions.map(opt => (
                <option key={opt} value={opt}>{t(`trigger.matchType.${opt}`)}</option>
              ))}
            </select>
          </div>
          <div className="config-row">
            <label>{t('trigger.portId')}</label>
            <select
              className="input"
              value={rule.portId ?? ''}
              onChange={e => updateTriggerRule(rule.id, { portId: e.target.value || undefined })}
              style={{ flex: 1 }}
            >
              <option value="">{t('trigger.portId.all')}</option>
              {ports.map(p => (
                <option key={p.id} value={p.id}>{p.alias || p.name}</option>
              ))}
            </select>
          </div>
          <div className="config-row">
            <label>{t('trigger.actionType')}</label>
            <select
              className="input"
              value={rule.actionType}
              onChange={e => updateTriggerRule(rule.id, { actionType: e.target.value as TriggerActionType })}
              style={{ flex: 1 }}
            >
              {actionTypeOptions.map(opt => (
                <option key={opt} value={opt}>{t(`trigger.actionType.${opt}`)}</option>
              ))}
            </select>
          </div>
          <div className="config-row">
            <label>{t('trigger.actionContent')}</label>
            <input
              className="input"
              value={rule.actionContent}
              onChange={e => updateTriggerRule(rule.id, { actionContent: e.target.value })}
              style={{ flex: 1, fontFamily: 'var(--font-terminal)' }}
            />
          </div>
          {rule.actionType === 'respond' && (
            <div className="config-row">
              <label />
              <label className="checkbox-wrapper" style={{ fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={rule.actionIsHex}
                  onChange={e => updateTriggerRule(rule.id, { actionIsHex: e.target.checked })}
                /> {t('trigger.actionIsHex')}
              </label>
            </div>
          )}
          {rule.pattern && (
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              <Zap size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              {t('trigger.matchType')}: {t(`trigger.matchType.${rule.matchType}`)} → {t(`trigger.actionType.${rule.actionType}`)}
            </div>
          )}
        </div>
      )}
    />
  );
};

export default TriggerSettings;
