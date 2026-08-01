import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useRuleStore } from '../../../stores/useRuleStore';
import { storageService } from '../../../services/tauri';
import { notifyError, notifySuccess } from '../../../stores/useToastStore';
import { Plus, Check, Trash2, ChevronRight, Zap } from 'lucide-react';
import type { TriggerMatchType, TriggerActionType } from '../../../types';

/**
 * 条件触发配置页：管理触发规则（接收数据匹配模式时自动执行动作）。
 * 数据通过 SQLite 持久化（trigger_rules 表）。
 */
const TriggerSettings: React.FC = () => {
  const { t } = useTranslation();
  const triggerRules = useRuleStore((s) => s.triggerRules);
  const addTriggerRule = useRuleStore((s) => s.addTriggerRule);
  const updateTriggerRule = useRuleStore((s) => s.updateTriggerRule);
  const removeTriggerRule = useRuleStore((s) => s.removeTriggerRule);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    storageService.loadTriggerRules().then(rows => {
      if (rows.length > 0) {
        useRuleStore.getState().setTriggerRules(rows);
      }
    }).catch((e) => console.debug('[TriggerSettings] load failed:', e));
  }, []);

  const handleAdd = () => {
    const id = `trig-${Date.now()}`;
    addTriggerRule({
      id,
      name: t('trigger.addRule'),
      pattern: '',
      isRegex: false,
      matchType: 'contains',
      actionType: 'alert',
      actionContent: '',
      actionIsHex: false,
      isEnabled: true,
    });
    setExpandedId(id);
  };

  const handleDelete = async (id: string) => {
    removeTriggerRule(id);
    try { await storageService.deleteTriggerRule(id); } catch (e) { notifyError(e); }
  };

  const handleSave = async (id: string) => {
    const rule = useRuleStore.getState().triggerRules.find(r => r.id === id);
    if (!rule) return;
    try {
      await storageService.saveTriggerRule(rule);
      notifySuccess(t('toast.severity.success'));
    } catch (e) {
      notifyError(e);
    }
  };

  const matchTypeOptions: TriggerMatchType[] = ['contains', 'exact', 'regex', 'hex'];
  const actionTypeOptions: TriggerActionType[] = ['alert', 'respond', 'bookmark'];

  return (
    <div className="config-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 className="config-page-title" style={{ marginBottom: 0 }}>{t('config.triggerSettings')}</h3>
        <button className="btn btn-sm" onClick={handleAdd}><Plus size={14} /> {t('trigger.addRule')}</button>
      </div>

      {triggerRules.length === 0 && <div className="config-placeholder">{t('trigger.empty')}</div>}

      {triggerRules.map(rule => (
        <div key={rule.id} style={{ border: '1px solid var(--border-color)', borderRadius: 6, marginBottom: 10, overflow: 'hidden' }}>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--bg-secondary)', cursor: 'pointer' }}
            onClick={() => setExpandedId(expandedId === rule.id ? null : rule.id)}
          >
            <ChevronRight size={12} style={{ transform: expandedId === rule.id ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }} />
            <input
              className="input"
              value={rule.name}
              onChange={e => updateTriggerRule(rule.id, { name: e.target.value })}
              onClick={e => e.stopPropagation()}
              style={{ border: 'none', background: 'transparent', fontWeight: 600, flex: 1, minWidth: 0 }}
            />
            <label className="checkbox-wrapper" style={{ fontSize: 11, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={rule.isEnabled}
                onChange={e => updateTriggerRule(rule.id, { isEnabled: e.target.checked })}
              /> {t('highlightSettings.enableCheckbox')}
            </label>
            <button className="btn btn-icon btn-sm" title={t('ruleSetAccordion.saveToDb')} onClick={e => { e.stopPropagation(); handleSave(rule.id); }}>
              <Check size={14} />
            </button>
            <button className="btn btn-icon btn-sm" title={t('ruleSetAccordion.delete')} onClick={e => { e.stopPropagation(); handleDelete(rule.id); }}>
              <Trash2 size={14} />
            </button>
          </div>

          {expandedId === rule.id && (
            <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
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
        </div>
      ))}
    </div>
  );
};

export default TriggerSettings;