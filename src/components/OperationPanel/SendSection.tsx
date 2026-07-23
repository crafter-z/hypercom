import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useOperationStore } from '../../stores/useOperationStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useAppStore } from '../../stores/useAppStore';
import { useRuleStore } from '../../stores/useRuleStore';
import { Send, Cable, Eraser, CornerDownLeft, TextCursorInput, Trash2, Plus, Edit3, FileUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';
import type { LineEnding, SendCommand } from '../../types';
import type { SendHistoryItem, FileProgressPayload } from '../../services/tauri';
import { serialService, eventService } from '../../services/tauri';
import { notifyError, notifySuccess } from '../../stores/useToastStore';
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
  const sendOnEnter = useAppStore(s => s.config.sendOnEnter);
  const encoding = useOperationStore(s => s.encoding);
  const setOpState = useOperationStore(s => s.setOpState);
  const clearTerminal = useTerminalStore(s => s.clearTerminal);
  const sendCommandSets = useRuleStore(s => s.sendCommandSets);
  const activeSendCommandSetId = useRuleStore(s => s.activeSendCommandSetId);
  const setConfigActiveTab = useAppStore(s => s.setConfigActiveTab);
  const toggleConfigModal = useAppStore(s => s.toggleConfigModal);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [fileProgress, setFileProgress] = useState<{ sent: number; total: number } | null>(null);

  // 文件发送进度事件订阅（异步注册竞态保护：参考 TitleBar onResized 模式）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    eventService
      .onFileProgress((p: FileProgressPayload) => {
        if (p.done) {
          setFileProgress(null);
        } else {
          setFileProgress({ sent: p.sent_bytes, total: p.total_bytes });
        }
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch((e) => console.debug('[SendSection] onFileProgress failed:', e));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const byteCount = useMemo(
    () => computeByteCount(sendInput, sendIsHex, encoding, sendAppendLineEnding),
    [sendInput, sendIsHex, encoding, sendAppendLineEnding]
  );

  const hexSuffix = useMemo(
    () => formatLineEndingHex(sendAppendLineEnding),
    [sendAppendLineEnding]
  );

  // Quick-send is driven by the ACTIVE send-command set — the same sets the
  // loop-send system uses. No static slot cap; one pill per command.
  const activeCommands = useMemo(() => {
    const set = sendCommandSets.find(s => s.id === activeSendCommandSetId);
    if (!set) return [];
    return [...set.commands].sort((a, b) => a.order - b.order);
  }, [sendCommandSets, activeSendCommandSetId]);

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

  // Send one command from the active set ONCE — each command carries its own
  // type (string/hex) and line ending, independent of the compose-row options.
  const handleQuickCommand = async (cmd: SendCommand) => {
    if (!isPortActive || !activeTabId || !cmd.content) return;
    await sendData(activeTabId, cmd.content, cmd.type === 'hex', cmd.appendLineEnding);
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

  const handleSendFile = async () => {
    if (!activeTabId) return;
    const path = await open({ multiple: false });
    if (!path || typeof path !== 'string') return;
    try {
      setFileProgress({ sent: 0, total: 0 });
      await serialService.sendFile({ portId: activeTabId, path, chunkSize: 1024, delayMs: 10 });
      notifySuccess('sendSection.file.sent');
    } catch (e) {
      setFileProgress(null);
      notifyError(e);
    }
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

  const openConfigToTab = (tab: string) => {
    setConfigActiveTab(tab);
    toggleConfigModal(true);
  };

  const toggleSendOnEnter = () => {
    const next = !sendOnEnter;
    useAppStore.getState().setConfig({ sendOnEnter: next });
  };

  return (
    <div className="op-section op-section-send">
      <div className="panel-card-title eyebrow">{t('sendSection.cardTitle')}</div>

      <div className="op-quick-send-row">
        {activeCommands.length > 0 ? (
          <>
            {activeCommands.map(cmd => (
              <button
                key={cmd.id}
                className="btn btn-sm op-quick-cmd"
                disabled={!isPortActive}
                title={cmd.name && cmd.name !== cmd.content ? `${cmd.name} — ${cmd.content}` : cmd.content}
                onClick={() => handleQuickCommand(cmd)}
              >
                {cmd.type === 'hex' && <span className="op-quick-cmd-hex">HEX</span>}
                <span className="op-quick-cmd-text">{cmd.content}</span>
              </button>
            ))}
            <button
              className="icon-btn"
              title={t('rulesSection.editCommands')}
              onClick={() => openConfigToTab('commands')}
            >
              <Edit3 size={12} />
            </button>
          </>
        ) : (
          <div className="op-quick-send-empty">
            <span>{t('sendSection.quickCommands.emptyHint')}</span>
            <button
              className="btn btn-sm op-quick-cmd-configure"
              onClick={() => openConfigToTab('commands')}
            >
              <Plus size={12} /> {t('sendSection.quickCommands.configure')}
            </button>
          </div>
        )}
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
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
              // Ctrl/Cmd+Enter ALWAYS sends, regardless of sendOnEnter
              e.preventDefault();
              handleSend();
            } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
        <div className="chip op-send-byte-chip" title={byteCount.tooltip}>
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
            <label className="checkbox-wrapper op-checkbox-compact">
              <input
                type="checkbox"
                checked={sendIsHex}
                onChange={e => setOpState({ sendIsHex: e.target.checked })}
              />
              HEX
            </label>
            <select
              className="select op-line-ending-select"
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
          className={`btn op-btn-grow${showAccent ? ' op-connect-accent' : ''}`}
          onClick={handleToggleConnection}
          disabled={connectButtonDisabled}
        >
          <Cable size={13} /> {connectButtonLabel}
        </button>
        <button
          className="btn"
          title={t('sendSection.file.button')}
          onClick={handleSendFile}
          disabled={!isConnected || fileProgress !== null}
        >
          <FileUp size={13} /> {t('sendSection.file.button')}
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

      {fileProgress && (
        <div className="op-file-progress">
          <div className="op-file-progress-track">
            <div
              className="op-file-progress-fill"
              style={{
                width: `${fileProgress.total > 0 ? Math.round((fileProgress.sent / fileProgress.total) * 100) : 0}%`,
              }}
            />
          </div>
          <span className="op-file-progress-label">
            {fileProgress.sent} / {fileProgress.total} B
          </span>
        </div>
      )}
    </div>
  );
};

export default SendSection;
