import React from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useOperationStore } from '../../stores/useOperationStore';
import { useRuleStore } from '../../stores/useRuleStore';
import { Settings, Edit3, Play, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface RulesSectionProps {
  isPortActive: boolean;
  isConnected: boolean;
}

const RulesSection: React.FC<RulesSectionProps> = ({ isPortActive, isConnected }) => {
  const { t } = useTranslation();
  const isLoopSending = useOperationStore(s => s.isLoopSending);
  const loopRepeatCount = useOperationStore(s => s.loopRepeatCount);
  const sendCommandSets = useRuleStore(s => s.sendCommandSets);
  const activeSendCommandSetId = useRuleStore(s => s.activeSendCommandSetId);
  const highlightRuleSets = useRuleStore(s => s.highlightRuleSets);
  const activeHighlightSetId = useRuleStore(s => s.activeHighlightSetId);
  const setOpState = useOperationStore(s => s.setOpState);
  const setActiveSendCommandSetId = useRuleStore(s => s.setActiveSendCommandSetId);
  const setActiveHighlightSetId = useRuleStore(s => s.setActiveHighlightSetId);
  const setConfigActiveTab = useAppStore(s => s.setConfigActiveTab);
  const toggleConfigModal = useAppStore(s => s.toggleConfigModal);

  const openConfigToTab = (tab: string) => {
    setConfigActiveTab(tab);
    toggleConfigModal(true);
  };

  const handleToggleLoop = () => {
    if (isLoopSending) {
      setOpState({ isLoopSending: false });
    } else {
      if (!sendCommandSets.find(s => s.id === activeSendCommandSetId)) {
        // Auto-select first available set
        if (sendCommandSets.length > 0) {
          setActiveSendCommandSetId(sendCommandSets[0].id);
        }
      }
      setOpState({ isLoopSending: true });
    }
  };

  return (
    <div className="op-section op-section-rules">
      <div className="panel-card-title eyebrow">{t('rulesSection.cardTitle')}</div>

      <div className="op-rule-row">
        <span className="op-label">{t('rulesSection.highlightLabel')}</span>
        <select
          className="select op-rule-select"
          value={activeHighlightSetId || ''}
          onChange={e => setActiveHighlightSetId(e.target.value || null)}
        >
          <option value="">{t('rulesSection.highlightDefault')}</option>
          {highlightRuleSets.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <button className="btn btn-icon btn-sm" title={t('rulesSection.editHighlight')} onClick={() => openConfigToTab('highlight')}>
          <Settings size={12} />
        </button>
      </div>

      <div className="op-rule-row">
        <span className="op-label">{t('rulesSection.commandSetLabel')}</span>
        <select
          className="select op-rule-select"
          value={activeSendCommandSetId || ''}
          onChange={e => setActiveSendCommandSetId(e.target.value || null)}
        >
          <option value="">{t('rulesSection.commandSetNone')}</option>
          {sendCommandSets.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <button className="btn btn-icon btn-sm" title={t('rulesSection.editCommands')} onClick={() => openConfigToTab('commands')}>
          <Edit3 size={12} />
        </button>
      </div>

      <div className="op-loop-row">
        {!isLoopSending ? (
          <button
            className="btn op-btn-grow"
            disabled={!isPortActive || !activeSendCommandSetId || !isConnected}
            onClick={handleToggleLoop}
          >
            <Play size={13} /> {t('rulesSection.startLoop')}
          </button>
        ) : (
          <button
            className="btn btn-danger op-btn-grow"
            onClick={handleToggleLoop}
          >
            <Square size={13} /> {t('rulesSection.stopLoop')}
          </button>
        )}
        <div className="op-delay-input">
          <span className="op-label">{t('rulesSection.repeatLabel')}</span>
          <input
            className="input op-number-input"
            type="number"
            value={loopRepeatCount}
            onChange={e => setOpState({ loopRepeatCount: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
            min={0}
            step={1}
            title={t('rulesSection.repeatTooltip')}
          />
          <span className="op-unit-label">{t('rulesSection.repeatUnit')}</span>
        </div>
      </div>
    </div>
  );
};

export default RulesSection;
