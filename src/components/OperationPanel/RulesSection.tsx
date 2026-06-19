import React from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useOperationStore } from '../../stores/useOperationStore';
import { useRuleStore } from '../../stores/useRuleStore';
import { Settings, Edit3, Play, Square } from 'lucide-react';

export interface RulesSectionProps {
  isPortActive: boolean;
  isConnected: boolean;
}

const RulesSection: React.FC<RulesSectionProps> = ({ isPortActive, isConnected }) => {
  const isLoopSending = useOperationStore(s => s.isLoopSending);
  const loopInterval = useOperationStore(s => s.loopInterval);
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
      <div className="panel-card-title">循环发送 & 规则</div>

      <div className="op-rule-row">
        <span className="op-label">高亮规则:</span>
        <select
          className="select op-rule-select"
          value={activeHighlightSetId || ''}
          onChange={e => setActiveHighlightSetId(e.target.value || null)}
        >
          <option value="">默认</option>
          {highlightRuleSets.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <button className="btn btn-icon btn-sm" title="编辑高亮规则" onClick={() => openConfigToTab('highlight')}>
          <Settings size={12} />
        </button>
      </div>

      <div className="op-rule-row">
        <span className="op-label">命令集:</span>
        <select
          className="select op-rule-select"
          value={activeSendCommandSetId || ''}
          onChange={e => setActiveSendCommandSetId(e.target.value || null)}
        >
          <option value="">无</option>
          {sendCommandSets.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <button className="btn btn-icon btn-sm" title="编辑发送命令" onClick={() => openConfigToTab('commands')}>
          <Edit3 size={12} />
        </button>
      </div>

      <div className="op-loop-row">
        {!isLoopSending ? (
          <button
            className="btn btn-primary"
            style={{ flex: 1 }}
            disabled={!isPortActive || !activeSendCommandSetId || !isConnected}
            onClick={handleToggleLoop}
          >
            <Play size={13} /> 开始循环
          </button>
        ) : (
          <button
            className="btn btn-danger"
            style={{ flex: 1 }}
            onClick={handleToggleLoop}
          >
            <Square size={13} /> 停止发送
          </button>
        )}
        <div className="op-delay-input">
          <span className="op-label">间隔:</span>
          <input
            className="input"
            type="number"
            style={{ width: 56, fontSize: 11, textAlign: 'center' }}
            value={loopInterval}
            onChange={e => setOpState({ loopInterval: Number(e.target.value) || 500 })}
            min={10}
            step={10}
          />
          <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>ms</span>
        </div>
      </div>
    </div>
  );
};

export default RulesSection;
