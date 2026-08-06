import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useRuleStore } from '../../../stores/useRuleStore';
import { useAppStore } from '../../../stores/useAppStore';
import { storageService } from '../../../services/tauri';
import { notifyError, notifySuccess } from '../../../stores/useToastStore';
import { Plus, Check, Trash2, ChevronRight, Zap } from 'lucide-react';
import type { TriggerMatchType, TriggerActionType, TriggerRule } from '../../../types';

/** Debounce window for auto-persisting rule edits (issue #5-3). */
const SAVE_DEBOUNCE_MS = 300;

/**
 * 条件触发配置页：管理触发规则（接收数据匹配模式时自动执行动作）。
 * 数据持久化到 config.json（config 实体，经 storageService 读写）。
 */
const TriggerSettings: React.FC = () => {
  const { t } = useTranslation();
  const triggerRules = useRuleStore((s) => s.triggerRules);
  const ports = useAppStore((s) => s.ports);
  const addTriggerRule = useRuleStore((s) => s.addTriggerRule);
  const updateTriggerRule = useRuleStore((s) => s.updateTriggerRule);
  const removeTriggerRule = useRuleStore((s) => s.removeTriggerRule);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Persistence state (issue #5-3): edits must survive a dialog reopen, so
  // every store change is debounce-saved to config.json. `hydratedRef` gates
  // the watcher until the mount load has replaced the store — the initial
  // load itself must never trigger a redundant save. `savedSnapshotRef` is
  // the last known-persisted state; only rules that differ are re-saved.
  const hydratedRef = useRef(false);
  const savedSnapshotRef = useRef<TriggerRule[]>([]);

  useEffect(() => {
    // Unconditional replace: after the user deletes ALL rules, a stale
    // non-empty result must not resurrect them on the next open.
    storageService.loadTriggerRules()
      .then(rows => {
        useRuleStore.getState().setTriggerRules(rows);
      })
      .catch((e) => console.warn('[TriggerSettings] load failed:', e))
      .finally(() => {
        // Hydrate regardless of load outcome: on failure the store keeps the
        // app-startup rules (same persisted source) and edits still save.
        savedSnapshotRef.current = useRuleStore.getState().triggerRules.map(r => ({ ...r }));
        hydratedRef.current = true;
      });
  }, []);

  // Debounced auto-save: any add/edit in the store persists 300ms after the
  // last change, so closing the dialog never loses the final keystroke.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const timer = setTimeout(() => {
      const rules = useRuleStore.getState().triggerRules;
      const prevMap = new Map(savedSnapshotRef.current.map(r => [r.id, r]));
      const changed = rules.filter((rule) => {
        const old = prevMap.get(rule.id);
        if (!old) return true; // newly added rule
        return JSON.stringify(old) !== JSON.stringify(rule);
      });
      if (changed.length === 0) return;
      // Snapshot advances only after every save succeeds — a failed save is
      // retried on the next edit (failure is surfaced via notifyError).
      Promise.all(
        changed.map(rule =>
          storageService.saveTriggerRule(rule).catch((e) => { notifyError(e); throw e; })
        )
      ).then(() => {
        savedSnapshotRef.current = rules.map(r => ({ ...r }));
      }).catch(() => { /* individual failures already toasted */ });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [triggerRules]);

  // Unmount flush: an edit made within the debounce window (then the dialog
  // closes, unmounting this page) would otherwise be lost — persist now.
  useEffect(() => {
    return () => {
      if (!hydratedRef.current) return;
      const rules = useRuleStore.getState().triggerRules;
      const prevMap = new Map(savedSnapshotRef.current.map(r => [r.id, r]));
      const changed = rules.filter((rule) => {
        const old = prevMap.get(rule.id);
        if (!old) return true;
        return JSON.stringify(old) !== JSON.stringify(rule);
      });
      if (changed.length === 0) return;
      for (const rule of changed) {
        storageService.saveTriggerRule(rule).catch(e => notifyError(e));
      }
    };
  }, []);

  const handleAdd = () => {
    const id = `trig-${Date.now()}`;
    const rule: TriggerRule = {
      id,
      name: t('trigger.addRule'),
      pattern: '',
      isRegex: false,
      matchType: 'contains',
      actionType: 'alert',
      actionContent: '',
      actionIsHex: false,
      isEnabled: true,
      portId: undefined,
    };
    addTriggerRule(rule);
    // Persist immediately (fire-and-forget; the UI path must not await the
    // backend): a fresh rule survives a dialog reopen even if the debounced
    // watcher never fires before the page unmounts.
    storageService.saveTriggerRule(rule).catch(e => notifyError(e));
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
  const actionTypeOptions: TriggerActionType[] = ['alert', 'respond'];

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
        </div>
      ))}
    </div>
  );
};

export default TriggerSettings;