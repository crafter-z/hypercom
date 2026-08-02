import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useOperationStore } from '../../stores/useOperationStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useAppStore } from '../../stores/useAppStore';
import { useRuleStore } from '../../stores/useRuleStore';
import { Send, Plus, Edit3, FileUp, Play, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';
import type { LineEnding, SendCommand, SendHistoryEntry } from '../../types';
import type { FileProgressPayload } from '../../services/tauri';
import { serialService, eventService, popoutService } from '../../services/tauri';
import { notifyError, notifySuccess } from '../../stores/useToastStore';
import {
  computeByteCount,
  formatLineEndingHex,
  textToHexPreview,
  hexToTextPreview,
  sanitizeHexInput,
} from '../../utils/sendUtils';

export interface SendSectionProps {
  activeTabId: string | null;
  isPortActive: boolean;
  isConnected: boolean;
  sendData: (portId: string, data: string, isHex: boolean, lineEnding: string) => Promise<number>;
  historyUp: () => SendHistoryEntry | null;
  historyDown: () => SendHistoryEntry | null;
}

const SendSection: React.FC<SendSectionProps> = ({
  activeTabId,
  isPortActive,
  isConnected,
  sendData,
  historyUp,
  historyDown,
}) => {
  const { t } = useTranslation();
  const sendInput = useOperationStore(s => s.sendInput);
  const sendIsHex = useOperationStore(s => s.sendIsHex);
  const sendAppendLineEnding = useOperationStore(s => s.sendAppendLineEnding);
  const sendOnEnter = useAppStore(s => s.config.sendOnEnter);
  const quickSendInlineCount = useAppStore(s => s.config.quickSendInlineCount);
  const encoding = useTerminalStore(s => (activeTabId ? s.terminals[activeTabId]?.encoding : undefined));
  const setOpState = useOperationStore(s => s.setOpState);
  const isLoopSending = useOperationStore(s => s.isLoopSending);
  const sendCommandSets = useRuleStore(s => s.sendCommandSets);
  const activeSendCommandSetId = useRuleStore(s => s.activeSendCommandSetId);
  const setActiveSendCommandSetId = useRuleStore(s => s.setActiveSendCommandSetId);
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
          // 仅「真正发完」才提示成功；取消(sent<total)与空文件(total==0)静默清除进度条，
          // 否则取消时误报「已发送」、空文件残留 0/0 进度条（done 事件由后端保证必发）。
          if (p.total_bytes > 0 && p.sent_bytes >= p.total_bytes) {
            notifySuccess('sendSection.file.sent');
          }
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
    () => computeByteCount(sendInput, sendIsHex, encoding ?? 'ASCII', sendAppendLineEnding),
    [sendInput, sendIsHex, encoding, sendAppendLineEnding]
  );

  const hexSuffix = useMemo(
    () => formatLineEndingHex(sendAppendLineEnding),
    [sendAppendLineEnding]
  );

  // Quick-send is driven by the ACTIVE send-command set — the same sets the
  // loop-send system uses. The inline strip shows the first N commands
  // (N = config.quickSendInlineCount; 0 hides the strip entirely — pure
  // pop-out mode); the rest overflow into the quick-send pop-out window.
  const activeCommands = useMemo(() => {
    const set = sendCommandSets.find(s => s.id === activeSendCommandSetId);
    if (!set) return [];
    return [...set.commands].sort((a, b) => a.order - b.order);
  }, [sendCommandSets, activeSendCommandSetId]);
  const inlineCommands = useMemo(
    () => activeCommands.slice(0, quickSendInlineCount),
    [activeCommands, quickSendInlineCount]
  );
  const hiddenCount = activeCommands.length - inlineCommands.length;

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

  // 循环发送开关：启动前若未选中命令集则自动选首个可用集（与快捷发送共用同一激活集）。
  const handleToggleLoop = () => {
    if (isLoopSending) {
      setOpState({ isLoopSending: false });
    } else {
      if (!sendCommandSets.find(s => s.id === activeSendCommandSetId) && sendCommandSets.length > 0) {
        setActiveSendCommandSetId(sendCommandSets[0].id);
      }
      setOpState({ isLoopSending: true });
    }
  };

  const handleSendFile = async () => {
    if (!activeTabId) return;
    const path = await open({ multiple: false });
    if (!path || typeof path !== 'string') return;
    try {
      setFileProgress({ sent: 0, total: 0 });
      await serialService.sendFile({ portId: activeTabId, path, chunkSize: 1024, delayMs: 10 });
      // 成功提示由 serial:file_progress 的 done 事件统一触发（见 onFileProgress），
      // 此处不再 toast——否则取消或出错时也会误报「已发送」。
    } catch (e) {
      setFileProgress(null);
      notifyError(e);
    }
  };

  // 取消正在进行的文件发送：置位后端 per-port 取消标志，读循环在下一块前退出，
  // 随后后端必发 done 事件清除进度条（取消不弹成功提示）。
  const handleCancelFile = () => {
    if (!activeTabId) return;
    serialService
      .cancelFileSend(activeTabId)
      .catch((e) => console.debug('[SendSection] cancelFileSend failed:', e));
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

  const applyHistoryItem = (item: SendHistoryEntry | null) => {
    if (item) {
      setOpState({
        sendInput: item.content,
        sendIsHex: item.format === 'hex',
        sendAppendLineEnding: item.lineEnding,
      });
    } else {
      setOpState({ sendInput: '' });
    }
  };

  const openConfigToTab = (tab: string) => {
    setConfigActiveTab(tab);
    toggleConfigModal(true);
  };

  // Toggling HEX mode converts the current compose buffer in place so the user
  // never loses what they typed — text→hex bytes when enabling, hex→text when
  // disabling (both UTF-8, non-fatal so partial input survives the switch).
  const handleToggleHex = (next: boolean) => {
    if (next === sendIsHex) return;
    if (next) {
      setOpState({ sendIsHex: true, sendInput: textToHexPreview(sendInput) });
    } else {
      setOpState({ sendIsHex: false, sendInput: hexToTextPreview(sendInput) });
    }
  };

  return (
    <div className="op-section op-section-send">
      {/* 标题行：左侧分区名，右侧紧凑命令集控制（选择 + 循环开关 + 编辑）。
          循环开关为图标按钮，运行时呼吸脉动；重复轮数已并入命令集设置。 */}
      <div className="op-send-header">
        <div className="panel-card-title eyebrow">{t('sendSection.cardTitle')}</div>
        <div className="op-send-header-controls">
          <select
            className="select op-cmdset-select"
            value={activeSendCommandSetId || ''}
            onChange={e => setActiveSendCommandSetId(e.target.value || null)}
            title={t('rulesSection.commandSetLabel')}
          >
            <option value="">{t('rulesSection.commandSetNone')}</option>
            {sendCommandSets.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <button
            className={`btn btn-icon btn-sm op-loop-toggle${isLoopSending ? ' is-running' : ''}`}
            disabled={!isLoopSending && (!isPortActive || !activeSendCommandSetId || !isConnected)}
            onClick={handleToggleLoop}
            title={isLoopSending ? t('rulesSection.stopLoop') : t('rulesSection.startLoop')}
          >
            {isLoopSending ? <Square size={13} /> : <Play size={13} />}
          </button>
          <button
            className="btn btn-icon btn-sm"
            title={t('rulesSection.editCommands')}
            onClick={() => openConfigToTab('commands')}
          >
            <Edit3 size={12} />
          </button>
        </div>
      </div>

      {quickSendInlineCount > 0 && (
        <div className="op-quick-send-row">
          {activeCommands.length > 0 ? (
            <>
              {inlineCommands.map(cmd => (
                <button
                  key={cmd.id}
                  className="btn btn-sm op-quick-cmd"
                  disabled={!isPortActive}
                  title={cmd.name && cmd.name !== cmd.content ? `${cmd.name} — ${cmd.content}` : cmd.content}
                  onClick={() => handleQuickCommand(cmd)}
                >
                  {cmd.type === 'hex' && <span className="op-quick-cmd-hex">HEX</span>}
                  <span className="op-quick-cmd-text">{cmd.name || cmd.content}</span>
                </button>
              ))}
              {hiddenCount > 0 && (
                <button
                  className="btn btn-sm op-quick-cmd op-quick-cmd-overflow"
                  title={t('quickSend.overflow')}
                  onClick={() =>
                    popoutService
                      .openPopout('quick-send')
                      .catch((e) => console.debug('[SendSection] openPopout failed:', e))
                  }
                >
                  ⋯ +{hiddenCount}
                </button>
              )}
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
      )}

      <div className="op-send-row">
        <textarea
          ref={textareaRef}
          className="input op-send-input"
          placeholder={
            !isPortActive ? t('sendSection.input.placeholder.noPort')
            : sendIsHex ? t('sendSection.input.placeholder.hex')
            : t('sendSection.input.placeholder.active')
          }
          disabled={!isPortActive}
          value={sendInput}
          onChange={e => setOpState({ sendInput: sendIsHex ? sanitizeHexInput(e.target.value) : e.target.value })}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (e.ctrlKey || e.metaKey || e.shiftKey) {
                insertNewlineAtCursor();          // Ctrl/Meta/Shift+Enter: ALWAYS newline
              } else if (sendOnEnter) {
                handleSend();                     // plain Enter: sends only when setting on
              } else {
                insertNewlineAtCursor();
              }
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
          {fileProgress !== null ? (
            <button
              className="btn btn-sm btn-danger"
              title={t('sendSection.file.cancel')}
              onClick={handleCancelFile}
            >
              <Square size={13} /> {t('sendSection.file.cancel')}
            </button>
          ) : (
            <button
              className="btn btn-sm"
              title={t('sendSection.file.button')}
              onClick={handleSendFile}
              disabled={!isConnected}
            >
              <FileUp size={13} /> {t('sendSection.file.button')}
            </button>
          )}
          <div className="op-send-options">
            <label className="checkbox-wrapper op-checkbox-compact">
              <input
                type="checkbox"
                checked={sendIsHex}
                onChange={e => handleToggleHex(e.target.checked)}
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
