import React, { useMemo, useRef } from 'react';
import { useOperationStore } from '../../stores/useOperationStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { getActivePortId, useAppStore } from '../../stores/useAppStore';
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
import { orderedCommands } from '../../utils/commandOrder';
import { isExecutableCommand, isSendCommand } from '../../utils/commandSteps';
import { executeQuickCommand } from '../../utils/commandExecution';
import { clearFlowStatus, isFlowRunning, useFlowStatus } from '../../utils/flowRuntime';
import type { FlowPhase } from '../../utils/flowRuntime';

/** i18n key for a flow phase label; terminal phases stay visible until cleared. */
function flowPhaseKey(phase: FlowPhase): string {
  return `flow.status.${phase}`;
}

export interface SendSectionProps {
  activePortId: string | null;
  isPortActive: boolean;
  isConnected: boolean;
  sendData: (portId: string, data: string, isHex: boolean, lineEnding: string) => Promise<number>;
  historyUp: () => SendHistoryEntry | null;
  historyDown: () => SendHistoryEntry | null;
}

const SendSection: React.FC<SendSectionProps> = ({
  activePortId,
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
  // 选择器闭包引用 prop activePortId（props 变化时组件重渲染、重新订阅）。
  // 返回 undefined/字符串原语，zustand Object.is 比较安全——不会因选择器
  // 构造新对象在每次 terminal store 更新时误重渲染。
  const encoding = useTerminalStore((s) => (activePortId ? s.terminals[activePortId]?.encoding : undefined));
  const setConfig = useAppStore((s) => s.setConfig);
  // issue #12：循环发送为每端口独立状态——按钮按**当前聚焦端口**查询，切换
  // 标签后按钮自动反映该端口的循环运行态（切回正在循环的端口显示「停止」）。
  const cyclicLoops = useOperationStore((s) => s.cyclicLoops);
  const setCyclicLoop = useOperationStore((s) => s.setCyclicLoop);
  const isLoopSending = activePortId ? !!cyclicLoops[activePortId] : false;
  const sendCommandSets = useRuleStore((s) => s.sendCommandSets);
  const activeSendCommandSetId = useRuleStore((s) => s.activeSendCommandSetId);
  const setActiveSendCommandSetId = useRuleStore((s) => s.setActiveSendCommandSetId);
  const setConfigActiveTab = useSystemStore((s) => s.setConfigActiveTab);
  const toggleConfigModal = useSystemStore((s) => s.toggleConfigModal);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 增强流程运行态（每端口）：目标端口被流程独占时，本区所有手动发送入口
  // 都要置灰并拦截——统一入口 sendToPort 仍会兜底拒绝，界面不能给出假可用状态。
  const flowStatus = useFlowStatus(activePortId);
  const flowBusy = isFlowRunning(activePortId);

  // HEX 预览/转换 + 字节计数（含非法输入的错误态）与发送历史召回各自成模块。
  const { byteCount, hexSuffix, inputErrorKey, toEditableValue, toggleHexMode } = useHexCompose({
    sendInput,
    isHex: sendIsHex,
    encoding: encoding ?? 'ASCII',
  });
  const { recallUp, recallDown } = useSendHistoryRecall(historyUp, historyDown);
  const { progress, startFileSend, cancelFileSend } = useFileSend(activePortId);

  // Quick-send is driven by the ACTIVE send-command set — the same sets the
  // loop-send system uses. quickSendInlineCount only gates strip visibility
  // (0 = pure pop-out mode); the visible slice is width-driven (issue #5-4).
  const activeCommands = useMemo(() => {
    const set = sendCommandSets.find((s) => s.id === activeSendCommandSetId);
    if (!set) return [];
    // 发送和改本机波特率都可单步执行；未知导入步骤仍不可执行。
    return orderedCommands(set.commands).filter(isExecutableCommand);
  }, [sendCommandSets, activeSendCommandSetId]);

  const openConfigToTab = (tab: string) => {
    setConfigActiveTab(tab);
    toggleConfigModal(true);
  };

  const handleSend = async () => {
    const portId = getActivePortId(useAppStore.getState());
    if (!portId || !sendInput.trim() || inputErrorKey !== null) return;
    // Enter sends even when the button is disabled — keep the flow lock explicit.
    if (isFlowRunning(portId)) return;
    const sentInput = sendInput;
    const written = await sendData(portId, sentInput, sendIsHex, sendAppendLineEnding);
    // issue #13：默认保留输入框内容；仅在用户开启「发送后清空」时清空。
    // 被守卫/后端拒绝（written === 0）不得清空用户输入；发送期间用户继续
    // 输入的下一行也不能被这次迟到的清空抹掉。
    if (clearSendInputAfterSend && written > 0 && useOperationStore.getState().sendInput === sentInput) {
      setOpState({ sendInput: '' });
    }
  };

  // Execute the clicked step ONCE. Sends retain their own format/line ending;
  // parameter steps change the local baud instead of sending empty content.
  const handleQuickCommand = async (cmd: SendCommand) => {
    const portId = getActivePortId(useAppStore.getState());
    if (!portId || (isSendCommand(cmd) && !cmd.content)) return;
    await executeQuickCommand(portId, cmd, sendData);
  };

  // 循环发送开关（issue #12）：按**当前聚焦端口**启停该端口的独立循环——
  // 启动前若未选中命令集则自动选首个可用集（与快捷发送共用同一激活集）；
  // 停止只影响当前聚焦端口，其它端口已运行的循环不受影响。
  const handleToggleLoop = () => {
    const activePortId = getActivePortId(useAppStore.getState());
    if (!activePortId) return;
    if (useOperationStore.getState().cyclicLoops[activePortId]) {
      setCyclicLoop(activePortId, false);
    } else {
      if (!sendCommandSets.find((s) => s.id === activeSendCommandSetId) && sendCommandSets.length > 0) {
        setActiveSendCommandSetId(sendCommandSets[0].id);
      }
      setCyclicLoop(activePortId, true);
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
            disabled={!isLoopSending && (!isPortActive || !activeSendCommandSetId || !isConnected || flowBusy)}
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

      {/* 次要内容容器：流程状态条 + 快捷发送条。面板被拖矮时这一块自己滚动/
          收缩，下面的发送行（主操作列）固定保留可见，绝不被挤出面板。 */}
      <div className="op-send-secondary">
        {/* 增强流程状态条：显示当前阶段、轮次/步骤进度与终止原因；终止态保留到
            用户清除，避免「流程为什么停了」无从查起。运行中不提供暂停，只有停止
            （标题行的循环开关即该端口的停止入口）。 */}
        {flowStatus && (
          <div className={`op-flow-status is-${flowStatus.phase}`} role="status">
            <span className="op-flow-status-dot" aria-hidden="true" />
            <span className="op-flow-status-text">
              {t(flowPhaseKey(flowStatus.phase), { detail: flowStatus.detail ?? '' })}
            </span>
            {flowStatus.name && flowStatus.round !== undefined && flowStatus.step !== undefined && (
              <span className="op-flow-status-progress">
                {t(flowStatus.totalRounds ? 'flow.status.progress' : 'flow.status.progressOpen', {
                  name: flowStatus.name,
                  round: flowStatus.round,
                  total: flowStatus.totalRounds ?? 0,
                  step: flowStatus.step,
                  totalSteps: flowStatus.totalSteps ?? 0,
                })}
              </span>
            )}
            {!flowBusy && (
              <button
                type="button"
                className="btn btn-sm op-flow-status-dismiss"
                onClick={() => clearFlowStatus(flowStatus.portId, flowStatus.runId)}
              >
                {t('flow.status.dismiss')}
              </button>
            )}
          </div>
        )}

        <QuickSendStrip
          commands={activeCommands}
          isPortActive={isPortActive}
          isBusy={flowBusy}
          onSendCommand={handleQuickCommand}
          onConfigure={() => openConfigToTab('commands')}
        />
      </div>

      <div className="op-send-row">
        <div className="op-send-editor">
          <div className="op-send-input-wrap">
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
          </div>
        </div>
        <div className="op-send-actions">
          <button
            className="btn btn-primary op-send-btn"
            disabled={!isPortActive || inputErrorKey !== null || flowBusy}
            onClick={handleSend}
          >
            <Send size={14} />
            {t('sendSection.sendButton')}
          </button>
          <div className="op-send-options" role="group" aria-label={t('sendSection.cardTitle')}>
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
          <SendFileButton
            progress={progress}
            isConnected={isConnected && !flowBusy}
            onStart={() => void startFileSend()}
            onCancel={cancelFileSend}
          />
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

// memo：props 均稳定（activePortId 字符串 / 布尔原语 / sendData·historyUp·historyDown
// 均为 useCallback 返回），OperationPanel 重渲染时不再拖累发送区。
// historyUp/Down 仅在发送历史变化（即一次真实发送）后更换引用，此时重渲染是合理的。
export default React.memo(SendSection);
