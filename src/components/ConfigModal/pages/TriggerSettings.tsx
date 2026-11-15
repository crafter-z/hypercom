import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownToLine, ArrowUpToLine, Bell, Check, Copy, Plus, Search, Send, Trash2, Undo2, X } from 'lucide-react';
import { useAppStore } from '../../../stores/useAppStore';
import type { TriggerMatchType, TriggerActionType, TriggerRule } from '../../../types';
import SortableEditorList from '../../shared/SortableEditorList';
import { SegmentedControl } from '../../shared/SegmentedControl';
import TriggerTestPanel from '../TriggerTestPanel';
import { useEntityPage } from '../hooks/useEntityPage';
import '../../../styles/trigger-settings.css';

type StatusFilter = 'all' | 'enabled' | 'disabled';
type ActionFilter = 'all' | TriggerActionType;

const MATCH_TYPES: readonly TriggerMatchType[] = ['contains', 'exact', 'regex', 'hex'];
const ACTION_TYPES: readonly TriggerActionType[] = ['alert', 'respond'];

const TriggerSettings: React.FC = () => {
  const { t } = useTranslation();
  const ports = useAppStore((s) => s.ports);
  const page = useEntityPage<TriggerRule>({ kind: 'triggerRules' });
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [actionFilter, setActionFilter] = useState<ActionFilter>('all');
  const detailsId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const pendingNameFocus = useRef<string | null>(null);
  const ruleButtons = useRef(new Map<string, HTMLButtonElement>());
  const search = query.trim().toLocaleLowerCase();
  const filtered = search.length > 0 || statusFilter !== 'all' || actionFilter !== 'all';
  const portName = (portId: TriggerRule['portId']) => {
    if (!portId) return t('trigger.portId.all');
    const port = ports.find(item => item.id === portId);
    return port?.alias || port?.name || portId;
  };
  const visibleRules = page.items.filter(rule => {
    if (statusFilter !== 'all' && rule.isEnabled !== (statusFilter === 'enabled')) return false;
    if (actionFilter !== 'all' && rule.actionType !== actionFilter) return false;
    if (!search) return true;
    return [rule.name, rule.pattern, rule.actionContent, rule.portId ?? '', portName(rule.portId)]
      .some(value => value.toLocaleLowerCase().includes(search));
  });
  // Filtering only narrows the browser. Keep the selected draft in the editor
  // even when typing makes it stop matching, rather than switching the focused
  // input to a different rule mid-edit. The underlying order is never rewritten.
  const selectedRule = page.items.find(rule => rule.id === page.expandedId) ?? visibleRules[0] ?? null;

  useEffect(() => {
    if (!selectedRule) return;
    if (page.expandedId !== selectedRule.id) page.toggleExpanded(selectedRule.id);
    if (pendingNameFocus.current !== selectedRule.id) return;
    pendingNameFocus.current = null;
    nameInput.current?.focus();
    nameInput.current?.select();
  }, [selectedRule?.id, page.expandedId, page.toggleExpanded]);

  const clearFilters = () => {
    setQuery('');
    setStatusFilter('all');
    setActionFilter('all');
  };
  const selectRule = (id: string) => {
    // Unlike an accordion, selecting the current row does not close its editor.
    if (page.expandedId !== id) page.toggleExpanded(id);
  };
  const createRule = (rule: TriggerRule, beforeId?: string) => {
    clearFilters();
    pendingNameFocus.current = rule.id;
    page.create(rule, beforeId);
  };
  const handleAdd = (beforeId?: string) => {
    createRule({
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
  const handleDuplicate = (rule: TriggerRule) => {
    const index = page.items.findIndex(item => item.id === rule.id);
    createRule({
      ...rule,
      id: crypto.randomUUID(),
      name: t('trigger.duplicateName', { name: rule.name }),
    }, page.items[index + 1]?.id);
  };
  const handleDelete = (rule: TriggerRule) => {
    const index = page.items.findIndex(item => item.id === rule.id);
    const next = page.items[index + 1] ?? page.items[index - 1];
    page.remove(rule.id);
    if (next && page.expandedId !== next.id) page.toggleExpanded(next.id);
  };
  const handleListKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowDown': nextIndex = Math.min(index + 1, visibleRules.length - 1); break;
      case 'ArrowUp': nextIndex = Math.max(index - 1, 0); break;
      case 'Home': nextIndex = 0; break;
      case 'End': nextIndex = visibleRules.length - 1; break;
      default: return;
    }
    event.preventDefault();
    const next = visibleRules[nextIndex];
    if (!next) return;
    selectRule(next.id);
    ruleButtons.current.get(next.id)?.focus();
  };
  const missingPort = selectedRule?.portId && !ports.some(port => port.id === selectedRule.portId);

  // TODO(i18n): the trigger workbench's new literal keys are coordinated with
  // the shared zh-CN/en-US resource update; do not add page-local translations.
  return (
    <div className="config-page trigger-settings" aria-busy={page.saving}>
      <h3 className="config-visually-hidden">{t('config.triggerSettings')}</h3>
      <div className="trigger-settings-toolbar">
        {page.dirty || page.saving ? (
          <div className="trigger-page-status" aria-live="polite">
            <span>{t(page.saving ? 'editor.saving' : 'editor.unsaved')}</span>
            {page.dirty && <>
              <button type="button" className="btn btn-sm" data-testid="trigger-save" aria-label={t('configModal.pageSave')} disabled={page.saving} onClick={() => { void page.save(); }}>
                <Check size={13} /> {t('configModal.pageSave')}
              </button>
              <button type="button" className="btn btn-sm" disabled={page.saving} onClick={() => page.discard()}>
                <Undo2 size={13} /> {t('configModal.pageDiscard')}
              </button>
            </>}
          </div>
        ) : <span className="trigger-save-hint">{t('trigger.saveHint')}</span>}
        <button type="button" className="btn btn-sm trigger-add-rule" disabled={page.saving} onClick={() => handleAdd()}>
          <Plus size={13} /> {t('trigger.addRule')}
        </button>
      </div>
      {page.error && <div className="editor-error trigger-settings-error" role="alert">{t(page.error)}</div>}
      <div className="trigger-settings-workspace">
        <section className="trigger-rule-browser" aria-label={t('trigger.ruleList')}>
          <div className="trigger-browser-heading">
            <h4>{t('trigger.ruleList')}</h4>
            <span aria-live="polite">{t('trigger.listCount', { visible: visibleRules.length, total: page.items.length })}</span>
          </div>
          <div className="trigger-browser-filters">
            <div className="trigger-search-field">
              <Search size={13} aria-hidden="true" />
              <input className="input" type="search" data-testid="trigger-search" value={query} placeholder={t('trigger.searchPlaceholder')}
                aria-label={t('trigger.searchPlaceholder')} onChange={event => setQuery(event.target.value)} />
              {query && <button type="button" className="btn btn-icon btn-sm" onClick={() => setQuery('')}
                title={t('sidebar.search.clear')} aria-label={t('sidebar.search.clear')}><X size={12} /></button>}
            </div>
            <div className="trigger-filter-selects">
              <select className="input" data-testid="trigger-filter" aria-label={t('trigger.filterStatus')} value={statusFilter}
                onChange={event => setStatusFilter(event.target.value as StatusFilter)}>
                <option value="all">{t('trigger.filterAll')}</option>
                <option value="enabled">{t('trigger.filterEnabled')}</option>
                <option value="disabled">{t('trigger.filterDisabled')}</option>
              </select>
              <select className="input" aria-label={t('trigger.filterAction')} value={actionFilter}
                onChange={event => setActionFilter(event.target.value as ActionFilter)}>
                <option value="all">{t('trigger.filterAllActions')}</option>
                {ACTION_TYPES.map(action => <option key={action} value={action}>{t(`trigger.actionType.${action}`)}</option>)}
              </select>
            </div>
          </div>
          {filtered && <div className="trigger-filter-notice">
            <span>{t('trigger.sortFilteredHint')}</span>
            <button type="button" className="btn btn-icon btn-sm" onClick={clearFilters}
              aria-label={t('trigger.clearFilters')} title={t('trigger.clearFilters')}><X size={12} /></button>
          </div>}
          <div className="trigger-rule-list" role="list">
            <SortableEditorList items={visibleRules} disabled={page.saving || filtered}
              onReorder={ids => { if (!filtered) page.reorder(ids); }}
              renderItem={(rule, index, handle) => (
                <div role="listitem" className={`trigger-rule-row${selectedRule?.id === rule.id ? ' is-selected' : ''}${rule.isEnabled ? '' : ' is-disabled'}`}>
                  <div className="trigger-rule-handle">{handle}</div>
                  <button type="button" className="trigger-rule-select" aria-pressed={selectedRule?.id === rule.id}
                    aria-controls={detailsId}
                    ref={button => { if (button) ruleButtons.current.set(rule.id, button); else ruleButtons.current.delete(rule.id); }}
                    onClick={() => selectRule(rule.id)} onKeyDown={event => handleListKeyDown(event, index)}
                    title={t('trigger.summaryMatchAction', {
                      match: `${t(`trigger.matchType.${rule.matchType}`)}: ${rule.pattern}`,
                      action: `${t(`trigger.actionType.${rule.actionType}`)} · ${portName(rule.portId)} · ${rule.actionContent}`,
                    })}>
                    <span className="trigger-rule-name">{rule.name || t('editor.name')}
                      {page.isDirty(rule.id) && <span className="editor-dirty-dot" title={t('editor.unsaved')} aria-label={t('editor.unsaved')} />}
                    </span>
                    <span className="trigger-rule-pattern">{rule.pattern.trim() || t('trigger.summaryEmptyPattern')}</span>
                    <span className="trigger-rule-meta">
                      {rule.actionType === 'respond' ? <Send size={10} aria-hidden="true" /> : <Bell size={10} aria-hidden="true" />}
                      <span>{t(`trigger.actionType.${rule.actionType}`)}</span>
                      <span className="trigger-rule-port">{portName(rule.portId)}</span>
                    </span>
                  </button>
                  <input type="checkbox" className="trigger-rule-enable" checked={rule.isEnabled} disabled={page.saving}
                    aria-label={`${t('highlightSettings.enableCheckbox')}: ${rule.name}`}
                    onChange={event => page.update(rule.id, { isEnabled: event.target.checked })} />
                </div>
              )}
            />
            {visibleRules.length === 0 && <div className="trigger-empty-state">
              <Search size={20} aria-hidden="true" />
              <p>{t(page.items.length === 0 ? 'trigger.empty' : 'trigger.noMatches')}</p>
              {filtered && <button type="button" className="btn btn-sm" onClick={clearFilters}>{t('trigger.clearFilters')}</button>}
            </div>}
          </div>
        </section>
        <section className="trigger-rule-details" id={detailsId} aria-label={t('trigger.details')}>
          {selectedRule ? <>
            <div className="trigger-details-heading">
              <h4>{t('trigger.details')}</h4>
              <div className="trigger-detail-actions">
                <button type="button" className="btn btn-icon btn-sm" disabled={page.saving}
                  data-testid={`trigger-duplicate-${selectedRule.id}`} title={t('trigger.duplicate')} aria-label={t('trigger.duplicate')} onClick={() => handleDuplicate(selectedRule)}><Copy size={13} /></button>
                <button type="button" className="btn btn-icon btn-sm" disabled={page.saving}
                  title={t('editor.insertAbove')} aria-label={t('editor.insertAbove')} onClick={() => handleAdd(selectedRule.id)}><ArrowUpToLine size={13} /></button>
                <button type="button" className="btn btn-icon btn-sm" disabled={page.saving}
                  title={t('editor.insertBelow')} aria-label={t('editor.insertBelow')}
                  onClick={() => handleAdd(page.items[page.items.findIndex(rule => rule.id === selectedRule.id) + 1]?.id)}><ArrowDownToLine size={13} /></button>
                <button type="button" className="btn btn-icon btn-sm trigger-delete-rule" disabled={page.saving}
                  title={t('ruleSetAccordion.delete')} aria-label={t('ruleSetAccordion.delete')} onClick={() => handleDelete(selectedRule)}><Trash2 size={13} /></button>
              </div>
            </div>
            <div className="trigger-detail-scroll">
              <fieldset className="trigger-detail-fields" disabled={page.saving}>
                <legend className="config-visually-hidden">{t('trigger.details')}</legend>
                <div className="trigger-detail-name">
                  <label htmlFor={`trigger-name-${selectedRule.id}`}>{t('editor.name')}</label>
                  <input id={`trigger-name-${selectedRule.id}`} ref={nameInput} className="input" value={selectedRule.name}
                    onChange={event => page.update(selectedRule.id, { name: event.target.value })} />
                  <label className="checkbox-wrapper trigger-detail-enable"><input type="checkbox" checked={selectedRule.isEnabled}
                    onChange={event => page.update(selectedRule.id, { isEnabled: event.target.checked })} />{t('highlightSettings.enableCheckbox')}</label>
                </div>
                <div className="trigger-detail-field">
                  <div className="trigger-pattern-heading">
                    <label htmlFor={`trigger-pattern-${selectedRule.id}`}>{t('trigger.pattern')}</label>
                    <label className="config-visually-hidden" htmlFor={`trigger-match-${selectedRule.id}`}>{t('trigger.matchType')}</label>
                    <select id={`trigger-match-${selectedRule.id}`} className="input" value={selectedRule.matchType}
                      onChange={event => {
                        const matchType = event.target.value as TriggerMatchType;
                        // matchType remains authoritative; retain the legacy wire mirror.
                        page.update(selectedRule.id, { matchType, isRegex: matchType === 'regex' });
                      }}>
                      {MATCH_TYPES.map(type => <option key={type} value={type}>{t(`trigger.matchType.${type}`)}</option>)}
                    </select>
                  </div>
                  <input id={`trigger-pattern-${selectedRule.id}`} className="input trigger-monospace" value={selectedRule.pattern}
                    onChange={event => page.update(selectedRule.id, { pattern: event.target.value })} />
                </div>
                <div className="trigger-detail-pair">
                  <div className="trigger-detail-field">
                    <label htmlFor={`trigger-port-${selectedRule.id}`}>{t('trigger.portId')}</label>
                    <select id={`trigger-port-${selectedRule.id}`} className="input" value={selectedRule.portId ?? ''}
                      onChange={event => page.update(selectedRule.id, { portId: event.target.value || undefined })}>
                      <option value="">{t('trigger.portId.all')}</option>
                      {missingPort && <option value={selectedRule.portId ?? ''}>{t('trigger.missingPort', { port: selectedRule.portId })}</option>}
                      {ports.map(port => <option key={port.id} value={port.id}>{port.alias || port.name}</option>)}
                    </select>
                  </div>
                  <div className="trigger-detail-field">
                    <span>{t('trigger.actionType')}</span>
                    <SegmentedControl value={selectedRule.actionType} aria-label={t('trigger.actionType')} disabled={page.saving}
                      options={ACTION_TYPES.map(action => ({ value: action, label: t(`trigger.actionType.${action}`) }))}
                      onChange={actionType => page.update(selectedRule.id, { actionType })} />
                  </div>
                </div>
                <div className="trigger-detail-field">
                  <div className="trigger-content-heading">
                    <label htmlFor={`trigger-content-${selectedRule.id}`}>{t(selectedRule.actionType === 'respond' ? 'trigger.respondContent' : 'trigger.alertContent')}</label>
                    {selectedRule.actionType === 'respond' && <label className="checkbox-wrapper trigger-hex-option">
                      <input type="checkbox" checked={selectedRule.actionIsHex}
                        onChange={event => page.update(selectedRule.id, { actionIsHex: event.target.checked })} />{t('trigger.actionIsHex')}
                    </label>}
                  </div>
                  <textarea id={`trigger-content-${selectedRule.id}`} className="input trigger-monospace" rows={4} value={selectedRule.actionContent}
                    onChange={event => page.update(selectedRule.id, { actionContent: event.target.value })} />
                </div>
              </fieldset>
               <TriggerTestPanel rules={page.items} selectedRule={selectedRule} ports={ports} />
            </div>
            {page.isDirty(selectedRule.id) && <div className="trigger-row-status">
              <span className="editor-dirty-dot" aria-hidden="true" />
              <span>{t('editor.unsaved')}</span>
              <button type="button" className="btn btn-sm" disabled={page.saving} onClick={() => { void page.save(selectedRule.id); }}>
                <Check size={13} />{t('configModal.rowSave')}
              </button>
              <button type="button" className="btn btn-sm" disabled={page.saving} onClick={() => page.discard(selectedRule.id)}>
                <Undo2 size={13} />{t('configModal.rowDiscard')}
              </button>
            </div>}
          </> : <div className="trigger-empty-state">
            <Bell size={24} aria-hidden="true" />
            <p>{t(page.items.length === 0 ? 'trigger.empty' : 'trigger.noMatches')}</p>
            {!page.items.length && <button type="button" className="btn btn-sm" disabled={page.saving} onClick={() => handleAdd()}>
              <Plus size={13} />{t('trigger.addRule')}
            </button>}
          </div>}
        </section>
      </div>
    </div>
  );
};

export default TriggerSettings;
