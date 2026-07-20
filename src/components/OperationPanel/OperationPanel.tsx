import React, { useEffect, useRef } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useOperationStore } from '../../stores/useOperationStore';
import { useRuleStore } from '../../stores/useRuleStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useSerialSend, useSerialConnection } from '../../hooks/useTauri';
import { serialService } from '../../services/tauri';
import { notifyError } from '../../stores/useToastStore';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import SendSection from './SendSection';
import RulesSection from './RulesSection';
import ParamsSection from './ParamsSection';
import ViewStrip from './ViewStrip';
import { useCyclicSend } from './hooks/useCyclicSend';

const OperationPanel: React.FC = () => {
  const { t } = useTranslation();
  const activeTabId = useAppStore(s => s.activeTabId);
  const collapsed = useAppStore(s => s.ui.isOperationPanelCollapsed);
  const baudRate = useOperationStore(s => s.baudRate);
  const dataBits = useOperationStore(s => s.dataBits);
  const parity = useOperationStore(s => s.parity);
  const stopBits = useOperationStore(s => s.stopBits);
  const handshake = useOperationStore(s => s.handshake);
  const dtr = useOperationStore(s => s.dtr);
  const rts = useOperationStore(s => s.rts);
  const scrollLocked = useOperationStore(s => s.scrollLocked);
  const showTimestamp = useOperationStore(s => s.showTimestamp);
  const displayFormat = useOperationStore(s => s.displayFormat);
  const encoding = useOperationStore(s => s.encoding);
  const isLoopSending = useOperationStore(s => s.isLoopSending);
  const loopInterval = useOperationStore(s => s.loopInterval);
  const sendCommandSets = useRuleStore(s => s.sendCommandSets);
  const activeSendCommandSetId = useRuleStore(s => s.activeSendCommandSetId);
  const setOpState = useOperationStore(s => s.setOpState);
  const setUIState = useAppStore(s => s.setUIState);
  const setTerminalConfig = useTerminalStore(s => s.setTerminalConfig);

  const { sendData, historyUp, historyDown, clearHistory } = useSerialSend();
  const { toggleConnection } = useSerialConnection();

  const activePort = useAppStore(s => s.ports.find(p => p.id === s.activeTabId));
  const isConnected = activePort?.status === 'connected';
  const isConnecting = activePort?.status === 'connecting';
  const isPortError = activePort?.status === 'error';
  const isPortActive = !!activeTabId;

  const activeCommands = sendCommandSets.find(s => s.id === activeSendCommandSetId)?.commands ?? [];

  // Cyclic send state machine (extracted to useCyclicSend hook)
  useCyclicSend({
    activeTabId,
    commands: activeCommands,
    isLooping: isLoopSending,
    isPortActive,
    isConnected,
    activeSendCommandSetId,
    loopInterval,
    sendData,
    setOpState,
  });

  const prevParamsRef = useRef(`${baudRate}-${dataBits}-${parity}-${stopBits}-${handshake}-${dtr}-${rts}`);

  // Sync serial params to backend when they change
  useEffect(() => {
    if (!activeTabId || !isConnected) return;
    const key = `${baudRate}-${dataBits}-${parity}-${stopBits}-${handshake}-${dtr}-${rts}`;
    if (key !== prevParamsRef.current) {
      prevParamsRef.current = key;
      serialService.setSerialParams(activeTabId, {
        baudRate,
        dataBits,
        parity,
        stopBits,
        handshake,
      }).catch(e => { console.debug('[OperationPanel] setSerialParams failed:', e); notifyError(e); });
      serialService.setFlowControl(activeTabId, dtr, rts).catch(e => { console.debug('[OperationPanel] setFlowControl failed:', e); notifyError(e); });
    }
  }, [activeTabId, isConnected, baudRate, dataBits, parity, stopBits, handshake, dtr, rts]);

  // Sync scroll lock to active terminal
  useEffect(() => {
    if (!activeTabId) return;
    setTerminalConfig(activeTabId, { scrollLocked });
  }, [scrollLocked, activeTabId, setTerminalConfig]);

  // Sync display format to active terminal
  useEffect(() => {
    if (!activeTabId) return;
    setTerminalConfig(activeTabId, { displayFormat });
  }, [displayFormat, activeTabId, setTerminalConfig]);

  // Sync encoding to active terminal
  useEffect(() => {
    if (!activeTabId) return;
    setTerminalConfig(activeTabId, { encoding });
  }, [encoding, activeTabId, setTerminalConfig]);

  // Sync timestamp toggle to active terminal
  useEffect(() => {
    if (!activeTabId) return;
    setTerminalConfig(activeTabId, { showTimestamp });
  }, [showTimestamp, activeTabId, setTerminalConfig]);

  const toggleCollapse = () => {
    setUIState({ isOperationPanelCollapsed: !collapsed });
  };

  return (
    <div className={`operation-panel${collapsed ? ' collapsed' : ''}`}>
      <div className="operation-panel-header" onClick={toggleCollapse}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {collapsed ? (
            <ChevronUp size={12} style={{ transition: 'transform 0.2s' }} />
          ) : (
            <ChevronDown size={12} style={{ transition: 'transform 0.2s' }} />
          )}
          <span className="operation-panel-title">{t('operationPanel.title')}</span>
          {isPortActive && (
            <span className="operation-panel-port">{activeTabId}</span>
          )}
        </div>
        {!collapsed && (
          <button
            className="btn btn-icon btn-sm"
            title={t('operationPanel.collapse')}
            onClick={e => { e.stopPropagation(); toggleCollapse(); }}
          >
            <ChevronDown size={14} />
          </button>
        )}
      </div>

      {!collapsed && (
        <>
          <ViewStrip isPortActive={isPortActive} activeTabId={activeTabId} />
          <div className="operation-panel-content">
            <SendSection
              activeTabId={activeTabId}
              isPortActive={isPortActive}
              isConnected={isConnected}
              isConnecting={isConnecting}
              isPortError={isPortError}
              sendData={sendData}
              toggleConnection={toggleConnection}
              historyUp={historyUp}
              historyDown={historyDown}
              clearHistory={clearHistory}
            />
            <RulesSection isPortActive={isPortActive} isConnected={isConnected} />
            <ParamsSection isConnected={isConnected} />
          </div>
        </>
      )}
    </div>
  );
};

export default OperationPanel;
