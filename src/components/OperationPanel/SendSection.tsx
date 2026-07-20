import React, { useMemo, useRef } from 'react';
import { useOperationStore } from '../../stores/useOperationStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useAppStore } from '../../stores/useAppStore';
import { Send, Cable, Eraser, CornerDownLeft, TextCursorInput, Trash2, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LineEnding } from '../../types';
import type { SendHistoryItem } from '../../services/tauri';
import { computeByteCount, formatLineEndingHex } from '../../utils/sendUtils';

export interface SendSectionProps {
  activeTabId: string | null;
  isPortActive: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  isPortError: boolean;
  sendData: (portId: string, data: string, isHex: boolean, lineEnding: string) => Promise<number>;
  toggleConnection: (portId: string) => Promise<void>;
  historyUp: () => SendHistoryItem | null;
  historyDown: () => SendHistoryItem | null;
  clearHistory: (portId: string) => Promise<void>;
}

const SendSection: React.FC<SendSectionProps> = ({
  activeTabId,
  isPortActive,
  isConnected,
  isConnecting,
  isPortError,
  sendData,
  toggleConnection,
  historyUp,
  historyDown,
  clearHistory,
}) => {
  const { t } = useTranslation();
  const sendInput = useOperationStore(s => s.sendInput);
  const sendIsHex = useOperationStore(s => s.sendIsHex);
  const sendAppendLineEnding = useOperationStore(s => s.sendAppendLineEnding);
  const sendOnEnter = useOperationStore(s => s.sendOnEnter);
  const quickSendSlots = useOperationStore(s => s.quickSendSlots);
  const encoding = useOperationStore(s => s.encoding);
  const setOpState = useOperationStore(s => s.setOpState);
  const clearTerminal = useTerminalStore(s => s.clearTerminal);
  const setUIState = useAppStore(s => s.setUIState);
  const setConfigActiveTab = useAppStore(s => s.setConfigActiveTab);
  const toggleConfigModal = useAppStore(s => s.toggleConfigModal);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const byteCount = useMemo(
    () => computeByteCount(sendInput, sendIsHex, encoding, sendAppendLineEnding),
    [sendInput, sendIsHex, encoding, sendAppendLineEnding]
  );

  const hexSuffix = useMemo(
    () => formatLineEndingHex(sendAppendLineEnding),
    [sendAppendLineEnding]
  );

  const connectButtonLabel = isConnected
    ? t('sendSection.connectBtn.disconnect')
    : isConnecting
    ? t('sendSection.connectBtn.connecting')
    : isPortError
    ? t('sendSection.connectBtn.retry')
    : t('sendSection.connectBtn.open');
  const connectButtonDisabled = !isPortActive || isConnecting;
  const showAccent = isPortActive && !isConnected && !isConnecting;

  const handleSend = async () => {
    if (!isPortActive || !sendInput.trim()) return;
    await sendData(activeTabId!, sendInput, sendIsHex, sendAppendLineEnding);
    setOpState({ sendInput: '' });
  };

  const handleQuickSend = async (content: string) => {
    if (!isPortActive || !content) return;
    await sendData(activeTabId!, content, sendIsHex, sendAppendLineEnding);
  };

  const handleToggleConnection = async () => {
    if (!activeTabId) return;
    await toggleConnection(activeTabId);
  };

  const handleClear = () => {
    if (!activeTabId) return;
    clearTerminal(activeTabId);
  };

  const handleClearHistory = async () => {
    if (!activeTabId) return;
    await clearHistory(activeTabId);
  };

  const insertNewlineAtCursor = () => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart ?? sendInput.length;
    const end = el.selectionEnd ?? sendInput.length;
    const next = sendInput.slice(0, start) + '\n' + sendInput.slice(end);
    setOpState({ sendInput: next });
    window.setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + 1, start + 1);
    }, 0);
  };

  const applyHistoryItem = (item: SendHistoryItem | null) => {
    if (item) {
      setOpState({
        sendInput: item.content,
        sendIsHex: item.format === 'hex',
        sendAppendLineEnding: item.line_ending as LineEnding,
      });
    } else {
      setOpState({ sendInput: '' });
    }
  };

  const openQuickSendSettings = () => {
    setConfigActiveTab('general');
    toggleConfigModal(true);
    setUIState({ isConfigOpen: true, configActiveTab: 'general' });
  };

  const toggleSendOnEnter = () => {
    const next = !sendOnEnter;
    setOpState({ sendOnEnter: next });
    useAppStore.getState().setConfig({ sendOnEnter: next });
  };

  return (
    <div className="op-section op-section-send">
      <div className="panel-card-title">{t('sendSection.cardTitle')}</div>

      <div className="op-quick-send-row">
        {quickSendSlots.map((slot, idx) =>
          slot ? (
            <button
              key={idx}
              className="btn btn-sm op-quick-send-slot"
              disabled={!isPortActive}
              title={`${t('settings.quickSend.slotN', { n: idx + 1 })}: ${slot}`}
              onClick={() => handleQuickSend(slot)}
            >
              {slot}
            </button>
          ) : null
        )}
        <button
          className="btn btn-sm op-quick-send-edit"
          title={t('op.quickSend.editButton')}
          onClick={openQuickSendSettings}
        >
          <Plus size={12} />
        </button>
      </div>

      <div className="op-send-row">
        <textarea
          ref={textareaRef}
          className="input op-send-input"
          placeholder={isPortActive ? t('sendSection.input.placeholder.active') : t('sendSection.input.placeholder.noPort')}
          disabled={!isPortActive}
          value={sendInput}
          onChange={e => setOpState({ sendInput: e.target.value })}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (sendOnEnter) {
                handleSend();
              } else {
                insertNewlineAtCursor();
              }
            } else if (e.key === 'Enter' && e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              insertNewlineAtCursor();
            } else if (e.key === 'ArrowUp' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              applyHistoryItem(historyUp());
            } else if (e.key === 'ArrowDown' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              applyHistoryItem(historyDown());
            }
          }}
        />
        <div className="op-send-byte-chip" title={byteCount.tooltip}>
          {byteCount.count} {t('op.send.bytesLabel')}
        </div>
        <div className="op-send-actions">
          <button
            className="btn btn-primary op-send-btn"
            disabled={!isPortActive}
            onClick={handleSend}
          >
            <Send size={14} />
            {t('sendSection.sendButton')}
          </button>
          <div className="op-send-tool-row">
            <button
              className={`btn btn-icon btn-sm${sendOnEnter ? ' active' : ''}`}
              title={sendOnEnter ? t('op.send.enterBehavior.tooltipSend') : t('op.send.enterBehavior.tooltipNewline')}
              onClick={toggleSendOnEnter}
            >
              {sendOnEnter ? <CornerDownLeft size={13} /> : <TextCursorInput size={13} />}
            </button>
            <button
              className="btn btn-icon btn-sm"
              title={t('op.send.clearHistory')}
              onClick={handleClearHistory}
              disabled={!isPortActive}
            >
              <Trash2 size={13} />
            </button>
          </div>
          <div className="op-send-options">
            <label className="checkbox-wrapper" style={{ fontSize: 10 }}>
              <input
                type="checkbox"
                checked={sendIsHex}
                onChange={e => setOpState({ sendIsHex: e.target.checked })}
              />
              HEX
            </label>
            <select
              className="select"
              style={{ fontSize: 10, padding: '1px 14px 1px 3px', width: 56 }}
              value={sendAppendLineEnding}
              onChange={e => setOpState({ sendAppendLineEnding: e.target.value as LineEnding })}
            >
              <option value="\\r\\n">{t('sendSection.lineEnding.crlf')}</option>
              <option value="\\r">{t('sendSection.lineEnding.cr')}</option>
              <option value="\\n">{t('sendSection.lineEnding.lf')}</option>
              <option value="None">{t('sendSection.lineEnding.none')}</option>
            </select>
          </div>
        </div>
      </div>

      {sendIsHex && (
        <div className="op-send-hex-suffix">
          {t('op.send.hexSuffixLabel')}{' '}
          {hexSuffix ?? t('sendSection.lineEnding.none')}
        </div>
      )}

      <div className="op-btn-row">
        <button
          className={`btn${showAccent ? ' op-connect-accent' : ''}`}
          style={{ flex: 1 }}
          onClick={handleToggleConnection}
          disabled={connectButtonDisabled}
        >
          <Cable size={13} /> {connectButtonLabel}
        </button>
        <button
          className="btn"
          title={t('sendSection.clearButton')}
          onClick={handleClear}
          disabled={!isPortActive}
        >
          <Eraser size={13} /> {t('sendSection.clearButton')}
        </button>
      </div>
    </div>
  );
};

export default SendSection;
