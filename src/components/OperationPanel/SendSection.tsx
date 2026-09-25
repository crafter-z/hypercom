import React, { useMemo, useRef } from 'react';
import { useOperationStore } from '../../stores/useOperationStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useAppStore } from '../../stores/useAppStore';
import { useSystemStore } from '../../stores/useSystemStore';
import { useRuleStore } from '../../stores/useRuleStore';
import { Send, Edit3, Play, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SendCommand, SendHistoryEntry } from '../../types';
import { useHexCompose } from './hooks/useHexCompose';
import { useFileSend } from './hooks/useFileSend';
import { useSendHistoryRecall } from './hooks/useSendHistoryRecall';
import { QuickSendStrip } from './components/QuickSendStrip';
import { LineEndingSelect } from './components/LineEndingSelect';
import { FileSendProgress, SendFileButton } from './components/SendFileControls';

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
  const sendInput = useOperationStore((s) => s.sendInput);
  const sendIsHex = useOperationStore((s) => s.sendIsHex);
  const sendAppendLineEnding = useOperationStore((s) => s.sendAppendLineEnding);
  const setOpState = useOperationStore((s) => s.setOpState);
  const sendOnEnter = useAppStore((s) => s.config.sendOnEnter);
  const clearSendInputAfterSend = useAppStore((s) => s.config.clearSendInputAfterSend);
  // 选择器闭包引用 prop activeTabId（props 变化时组件重渲染、重新订阅）。
  // 返回 undefined/字符串原语，zustand Object.is 比较安全——不会因选择器
  // 构造新对象在每次 terminal store 更新时误重渲染。
  const encoding = useTerminalStore((s) => (activeTabId ? s.terminals[activeTabId]?.encoding : undefined));
  const setConfig = useAppStore((s) => s.setConfig);
  // issue #12：循环发送为每端口独立状态——按钮按**当前聚焦端口**查询，切换
  // 标签后按钮自动反映该端口的循环运行态（切回正在循环的端口显示「停止」）。
  const cyclicLoops = useOperationStore((s) => s.cyclicLoops);
  const setCyclicLoop = useOperationStore((s) => s.setCyclicLoop);
  const isLoopSending = activeTabId ? !!cyclicLoops[activeTabId] : false;
  const sendCommandSets = useRuleStore((s) => s.sendCommandSets);
  const activeSendCommandSetId = useRuleStore((s) => s.activeSendCommandSetId);
  const setActiveSendCommandSetId = useRuleStore((s) => s.setActiveSendCommandSetId);
  const setConfigActiveTab = useSystemStore((s) => s.setConfigActiveTab);
  const toggleConfigModal = useSystemStore((s) => s.toggleConfigModal);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // HEX 预览/转换 + 字节计数（含非法输入的错误态）与发送历史召回各自成模块。
  const { byteCount, hexSuffix, inputErrorKey, toEditableValue, toggleHexMode } = useHexCompose({
    sendInput,
    isHex: sendIsHex,
    encoding: encoding ?? 'ASCII',
  });
  const { recallUp, recallDown } = useSendHistoryRecall(historyUp, historyDown);
  const { progress, startFileSend, cancelFileSend } = useFileSend(activeTabId);

  // Quick-send is driven by the ACTIVE send-command set — the same sets the
  // loop-send system uses. quickSendInlineCount only gates strip visibility
  // (0 = pure pop-out mode); the visible slice is width-driven (issue #5-4).
  const activeCommands = useMemo(() => {
    const set = sendCommandSets.find((s) => s.id === activeSendCommandSetId);
    if (!set) return [];
    return [...set.commands].sort((a, b) => a.order - b.order);
  }, [sendCommandSets, activeSendCommandSetId]);

  const openConfigToTab = (tab: string) => {
    setConfigActiveTab(tab);
    toggleConfigModal(true);
  };

  const handleSend = async () => {
    if (!isPortActive || !sendInput.trim() || inputErrorKey !== null) return;
    await sendData(activeTabId!, sendInput, sendIsHex, sendAppendLineEnding);
    // issue #13：默认保留输入框内容；仅在用户开启「发送后清空」时清空。
    if (clearSendInputAfterSend) {
      setOpState({ sendInput: '' });
    }
  };

  // Send one command from the active set ONCE — each command carries its own
  // type (string/hex) and line ending, independent of the compose-row options.
  const handleQuickCommand = async (cmd: SendCommand) => {
    if (!isPortActive || !activeTabId || !cmd.content) return;
    await sendData(activeTabId, cmd.content, cmd.type === 'hex', cmd.appendLineEnding);
  };

  // 循环发送开关（issue #12）：按**当前聚焦端口**启停该端口的独立循环——
  // 启动前若未选中命令集则自动选首个可用集（与快捷发送共用同一激活集）；
  // 停止只影响当前聚焦端口，其它端口已运行的循环不受影响。
  const handleToggleLoop = () => {
    if (!activeTabId) return;
    if (isLoopSending) {
      setCyclicLoop(activeTabId, false);
    } else {
      if (!sendCommandSets.find((s) => s.id === activeSendCommandSetId) && sendCommandSets.length > 0) {
        setActiveSendCommandSetId(sendCommandSets[0].id);
      }
      setCyclicLoop(activeTabId, true);
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
            onChange={(e) => setActiveSendCommandSetId(e.target.value || null)}
            title={t('rulesSection.commandSetLabel')}
          >
            <option value="">{t('rulesSection.commandSetNone')}</option>
            {sendCommandSets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
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

      <QuickSendStrip
        commands={activeCommands}
        isPortActive={isPortActive}
        onSendCommand={handleQuickCommand}
        onConfigure={() => openConfigToTab('commands')}
      />

      <div className="op-send-row">
        <textarea
          ref={textareaRef}
          className={`input op-send-input${inputErrorKey !== null ? ' is-error' : ''}`}
          placeholder={
            !isPortActive
              ? t('sendSection.input.placeholder.noPort')
              : sendIsHex
              ? t('sendSection.input.placeholder.hex')
              : t('sendSection.input.placeholder.active')
          }
          disabled={!isPortActive}
          aria-invalid={inputErrorKey !== null}
          value={sendInput}
          onChange={(e) => setOpState({ sendInput: toEditableValue(e.target.value) })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (e.ctrlKey || e.metaKey || e.shiftKey) {
                insertNewlineAtCursor(); // Ctrl/Meta/Shift+Enter: ALWAYS newline
              } else if (sendOnEnter) {
                handleSend(); // plain Enter: sends only when setting on
              } else {
                insertNewlineAtCursor();
              }
            } else if (e.key === 'ArrowUp' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              recallUp();
            } else if (e.key === 'ArrowDown' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              recallDown();
            }
          }}
        />
        {/* 字节计数：非法 HEX 时（后端必然拒绝）显示原因而不是 "N B"（C4/K7）。 */}
        <div
          className={`chip op-send-byte-chip${inputErrorKey !== null ? ' is-error' : ''}`}
          title={inputErrorKey !== null ? t(inputErrorKey) : byteCount.tooltip}
        >
          {inputErrorKey !== null ? (
            t(inputErrorKey)
          ) : (
            <>
              {byteCount.count} {t('op.send.bytesLabel')}
            </>
          )}
        </div>
        <div className="op-send-actions">
          <button
            className="btn btn-primary op-send-btn"
            disabled={!isPortActive || inputErrorKey !== null}
            onClick={handleSend}
          >
            <Send size={14} />
            {t('sendSection.sendButton')}
          </button>
          <SendFileButton
            progress={progress}
            isConnected={isConnected}
            onStart={() => void startFileSend()}
            onCancel={cancelFileSend}
          />
          <div className="op-send-options">
            <label className="checkbox-wrapper op-checkbox-compact">
              <input type="checkbox" checked={sendIsHex} onChange={(e) => toggleHexMode(e.target.checked)} />
              HEX
            </label>
            <label className="checkbox-wrapper op-checkbox-compact" title={t('sendSection.clearAfterSend')}>
              <input
                type="checkbox"
                checked={clearSendInputAfterSend}
                onChange={(e) => setConfig({ clearSendInputAfterSend: e.target.checked })}
              />
              {t('sendSection.clearAfterSend')}
            </label>
            <LineEndingSelect />
          </div>
        </div>
      </div>

      {sendIsHex && (
        <div className="op-send-hex-suffix">
          {t('op.send.hexSuffixLabel')} {hexSuffix ?? t('sendSection.lineEnding.none')}
        </div>
      )}

      {progress && <FileSendProgress progress={progress} />}
    </div>
  );
};

// memo：props 均稳定（activeTabId 字符串 / 布尔原语 / sendData·historyUp·historyDown
// 均为 useCallback 返回），OperationPanel 重渲染时不再拖累发送区。
// historyUp/Down 仅在发送历史变化（即一次真实发送）后更换引用，此时重渲染是合理的。
export default React.memo(SendSection);
