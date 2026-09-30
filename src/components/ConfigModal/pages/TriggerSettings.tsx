import React from 'react';
import { useTranslation } from 'react-i18next';
import { useRuleStore } from '../../../stores/useRuleStore';
import { useAppStore } from '../../../stores/useAppStore';
import { storageService } from '../../../services/tauri';
import type { TriggerMatchType, TriggerActionType, TriggerRule } from '../../../types';
import RuleSetAccordion from '../RuleSetAccordion';
import { useEntityPage } from '../hooks/useEntityPage';
import { Zap } from 'lucide-react';

/**
 * Trigger edits auto-persist this long after the last change, so closing the
 * dialog never loses the final keystroke. This is the debounced-auto variant of
 * the shared entity-page contract (`useEntityPage`) — the only page that needs
 * it, because its body is a free-form rule editor where a per-row ✓ would be
 * redundant with the immediate feedback users expect from a matcher.
 */
const SAVE_DEBOUNCE_MS = 300;

/**
 * 条件触发配置页：管理触发规则（接收数据匹配模式时自动执行动作）。
 * 数据持久化到 config.json（config 实体，经 storageService 读写）。
 */
const TriggerSettings: React.FC = () => {
  const { t } = useTranslation();
  const triggerRules = useRuleStore((s) => s.triggerRules);
  const ports = useAppStore((s) => s.ports);
  const updateTriggerRule = useRuleStore((s) => s.updateTriggerRule);

  const page = useEntityPage<TriggerRule>({
    items: triggerRules,
    label: 'TriggerSettings',
    autoSaveDebounceMs: SAVE_DEBOUNCE_MS,
    ops: {
      load: () => storageService.loadTriggerRules(),
      read: () => useRuleStore.getState().triggerRules,
      replace: (items) => useRuleStore.getState().setTriggerRules(items),
      add: (rule) => useRuleStore.getState().addTriggerRule(rule),
      drop: (id) => useRuleStore.getState().removeTriggerRule(id),
      persist: (rule) => storageService.saveTriggerRule(rule),
      remove: (id) => storageService.deleteTriggerRule(id),
    },
  });

  const handleAdd = () => {
    page.create({
      id: `trig-${Date.now()}`,
      name: t('trigger.addRule'),
      pattern: '',
      isRegex: false,
      matchType: 'contains',
      actionType: 'alert',
      actionContent: '',
      actionIsHex: false,
      isEnabled: true,
      portId: undefined,
    });
  };

  const matchTypeOptions: TriggerMatchType[] = ['contains', 'exact', 'regex', 'hex'];
  const actionTypeOptions: TriggerActionType[] = ['alert', 'respond'];

  return (
    <RuleSetAccordion<TriggerRule>
      title={t('config.triggerSettings')}
      addLabel={t('trigger.addRule')}
      emptyText={t('trigger.empty')}
      items={triggerRules}
      selectedId={page.expandedId}
      onSelect={page.toggleExpanded}
      onAdd={handleAdd}
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
