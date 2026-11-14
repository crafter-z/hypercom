import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../stores/useAppStore';
import type { TriggerMatchType, TriggerActionType, TriggerRule } from '../../../types';
import RuleSetAccordion from '../RuleSetAccordion';
import { useEntityPage } from '../hooks/useEntityPage';
import { Zap } from 'lucide-react';
import '../../../styles/rule-preview.css';

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
      renderHeaderExtra={(rule) => {
        const pattern = rule.pattern.trim() || t('trigger.summaryEmptyPattern');
        const summary = t('trigger.summaryMatchAction', {
          match: `${t(`trigger.matchType.${rule.matchType}`)}: ${pattern}`,
          action: t(`trigger.actionType.${rule.actionType}`),
        });
        return (
          <>
            <span className="rule-header-extra" title={summary} onClick={e => e.stopPropagation()}>{summary}</span>
            <label className="checkbox-wrapper rule-header-enable" onClick={e => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={rule.isEnabled}
                onChange={e => updateTriggerRule(rule.id, { isEnabled: e.target.checked })}
              /> {t('highlightSettings.enableCheckbox')}
            </label>
          </>
        );
      }}
      renderEditor={(rule) => (
        <div className="rule-settings-editor">
          <div className="rule-settings-row">
            <label className="rule-settings-label" htmlFor={`trigger-pattern-${rule.id}`}>{t('trigger.pattern')}</label>
            <input
              id={`trigger-pattern-${rule.id}`}
              className="input rule-settings-field rule-settings-terminal"
              value={rule.pattern}
              onChange={e => updateTriggerRule(rule.id, { pattern: e.target.value })}
            />
          </div>
          <div className="rule-settings-row">
            <label className="rule-settings-label" htmlFor={`trigger-match-${rule.id}`}>{t('trigger.matchType')}</label>
            <select
              id={`trigger-match-${rule.id}`}
              className="input rule-settings-field"
              value={rule.matchType}
              onChange={e => updateTriggerRule(rule.id, { matchType: e.target.value as TriggerMatchType })}
            >
              {matchTypeOptions.map(opt => (
                <option key={opt} value={opt}>{t(`trigger.matchType.${opt}`)}</option>
              ))}
            </select>
          </div>
          <div className="rule-settings-row">
            <label className="rule-settings-label" htmlFor={`trigger-port-${rule.id}`}>{t('trigger.portId')}</label>
            <select
              id={`trigger-port-${rule.id}`}
              className="input rule-settings-field"
              value={rule.portId ?? ''}
              onChange={e => updateTriggerRule(rule.id, { portId: e.target.value || undefined })}
            >
              <option value="">{t('trigger.portId.all')}</option>
              {ports.map(p => (
                <option key={p.id} value={p.id}>{p.alias || p.name}</option>
              ))}
            </select>
          </div>
          <div className="rule-settings-row">
            <label className="rule-settings-label" htmlFor={`trigger-action-${rule.id}`}>{t('trigger.actionType')}</label>
            <select
              id={`trigger-action-${rule.id}`}
              className="input rule-settings-field"
              value={rule.actionType}
              onChange={e => updateTriggerRule(rule.id, { actionType: e.target.value as TriggerActionType })}
            >
              {actionTypeOptions.map(opt => (
                <option key={opt} value={opt}>{t(`trigger.actionType.${opt}`)}</option>
              ))}
            </select>
          </div>
          <div className="rule-settings-row">
            <label className="rule-settings-label" htmlFor={`trigger-content-${rule.id}`}>{t('trigger.actionContent')}</label>
            <input
              id={`trigger-content-${rule.id}`}
              className="input rule-settings-field rule-settings-terminal"
              value={rule.actionContent}
              onChange={e => updateTriggerRule(rule.id, { actionContent: e.target.value })}
            />
          </div>
          {rule.actionType === 'respond' && (
            <div className="rule-settings-row">
              <span className="rule-settings-label" aria-hidden="true" />
              <label className="checkbox-wrapper rule-settings-checkbox">
                <input
                  type="checkbox"
                  checked={rule.actionIsHex}
                  onChange={e => updateTriggerRule(rule.id, { actionIsHex: e.target.checked })}
                /> {t('trigger.actionIsHex')}
              </label>
            </div>
          )}
          {rule.pattern && (
            <div className="rule-settings-note">
              <Zap size={11} aria-hidden="true" />
              <span>{t('trigger.summaryMatchAction', {
                match: `${t(`trigger.matchType.${rule.matchType}`)}: ${rule.pattern}`,
                action: t(`trigger.actionType.${rule.actionType}`),
              })}</span>
            </div>
          )}
        </div>
      )}
    />
  );
};

export default TriggerSettings;
