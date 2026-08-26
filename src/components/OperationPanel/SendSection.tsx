import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useOperationStore } from '../../stores/useOperationStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useAppStore } from '../../stores/useAppStore';
import { useRuleStore } from '../../stores/useRuleStore';
import { Send, Plus, Edit3, FileUp, Play, Square, PanelRightOpen } from 'lucide-react';
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
import { computeFitCount } from '../../utils/sendStrip';
import type { SendStripLayout } from '../../utils/sendStrip';

export interface SendSectionProps {
  activeTabId: string | null;
  isPortActive: boolean;
  isConnected: boolean;
  sendData: (portId: string, data: string, isHex: boolean, lineEnding: string) => Promise<number>;
  historyUp: () => SendHistoryEntry | null;
  historyDown: () => SendHistoryEntry | null;
}

// Strip layout constants — must mirror the CSS:
// - gap = var(--space-1) = 4px (`.op-quick-send-row` gap)
// - panel button estimate used before the first measurement lands.
const QUICK_STRIP_GAP = 4;
const PANEL_BUTTON_ESTIMATE = 32;

// 命令药丸的单点渲染源：可见行与隐藏测量行共用同一份 JSX，保证测量宽度
// 与真实渲染宽度一致（模块级函数，非组件——不携带 hook，避免重挂载）。
function renderQuickCmdPill(cmd: SendCommand, isPortActive: boolean, onClick: () => void) {
  return (
    <button
      key={cmd.id}
      className="btn btn-sm op-quick-cmd"
      disabled={!isPortActive}
      title={cmd.name && cmd.name !== cmd.content ? `${cmd.name} — ${cmd.content}` : cmd.content}
      onClick={onClick}
    >
      {/* issue #6-9：名称在上（HEX 徽标与名称同行）、内容在下，两行显示 */}
      <span className="op-quick-cmd-name-row">
        {cmd.type === 'hex' && <span className="op-quick-cmd-hex">HEX</span>}
        <span className="op-quick-cmd-name">{cmd.name || cmd.content}</span>
      </span>
      <span className="op-quick-cmd-content">{cmd.content}</span>
    </button>
  );
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
  const setOpState = useOperationStore(s => s.setOpState);
  const sendOnEnter = useAppStore(s => s.config.sendOnEnter);
  const clearSendInputAfterSend = useAppStore(s => s.config.clearSendInputAfterSend);
  const quickSendInlineCount = useAppStore(s => s.config.quickSendInlineCount);
  // 选择器闭包引用 prop activeTabId（props 变化时组件重渲染、重新订阅）。
  // 返回 undefined/字符串原语，zustand Object.is 比较安全——不会因选择器
  // 构造新对象在每次 terminal store 更新时误重渲染。
  const encoding = useTerminalStore((s) => (activeTabId ? s.terminals[activeTabId]?.encoding : undefined));
  const setConfig = useAppStore(s => s.setConfig);
  // issue #12：循环发送为每端口独立状态——按钮按**当前聚焦端口**查询，切换
  // 标签后按钮自动反映该端口的循环运行态（切回正在循环的端口显示「停止」）。
  const cyclicLoops = useOperationStore(s => s.cyclicLoops);
  const setCyclicLoop = useOperationStore(s => s.setCyclicLoop);
  const isLoopSending = activeTabId ? !!cyclicLoops[activeTabId] : false;
  const sendCommandSets = useRuleStore(s => s.sendCommandSets);
  const activeSendCommandSetId = useRuleStore(s => s.activeSendCommandSetId);
  const setActiveSendCommandSetId = useRuleStore(s => s.setActiveSendCommandSetId);
  const setConfigActiveTab = useAppStore(s => s.setConfigActiveTab);
  const toggleConfigModal = useAppStore(s => s.toggleConfigModal);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [fileProgress, setFileProgress] = useState<{ sent: number; total: number } | null>(null);

  // ---- Quick-send strip: width-adaptive visibility (issue #5-4) ----
  // The inline strip shows as many command pills as fit the available width:
  // a ResizeObserver tracks the strip container, a hidden measuring row tracks
  // every command pill's real width, and computeFitCount derives the visible
  // slice + overflow count. quickSendInlineCount still gates visibility only
  // (0 = hide the strip entirely — pure pop-out mode).
  const stripRef = useRef<HTMLDivElement>(null);
  const measureRowRef = useRef<HTMLDivElement>(null);
  const panelBtnRef = useRef<HTMLButtonElement>(null);
  const [stripWidth, setStripWidth] = useState(0);
  const [panelBtnWidth, setPanelBtnWidth] = useState(0);
  const [cmdWidths, setCmdWidths] = useState<number[]>([]);
  const stripVisible = quickSendInlineCount > 0;

  // Quick-send is driven by the ACTIVE send-command set — the same sets the
  // loop-send system uses. quickSendInlineCount only gates strip visibility
  // (0 = pure pop-out mode); the visible slice is width-driven (issue #5-4).
  const activeCommands = useMemo(() => {
    const set = sendCommandSets.find(s => s.id === activeSendCommandSetId);
    if (!set) return [];
    return [...set.commands].sort((a, b) => a.order - b.order);
  }, [sendCommandSets, activeSendCommandSetId]);

  // 容器宽度 + 面板按钮宽度：挂载即测（useLayoutEffect 保证首帧前就有值），
  // 之后由 ResizeObserver 跟踪窗口/面板缩放。
  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const update = () => {
      setStripWidth(el.getBoundingClientRect().width);
      setPanelBtnWidth(panelBtnRef.current?.getBoundingClientRect().width ?? 0);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [stripVisible]);

  // 命令药丸宽度：隐藏测量行渲染全部命令，其尺寸变化（命令集切换/字体加载）
  // 由 ResizeObserver 捕获；等值守卫避免无谓的重渲染循环。
  useLayoutEffect(() => {
    const row = measureRowRef.current;
    if (!row) {
      setCmdWidths([]);
      return;
    }
    const update = () => {
      const widths = Array.from(row.children).map(c =>
        Math.ceil(c.getBoundingClientRect().width)
      );
      setCmdWidths(prev =>
        prev.length === widths.length && prev.every((w, i) => w === widths[i]) ? prev : widths
      );
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(row);
    return () => ro.disconnect();
  }, [activeCommands, stripVisible]);

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

  // 布局：按实际测量宽度计算「放得下几条 + 溢出几条」。测量未落地前保守
  // 回退为 0 可见（useLayoutEffect 保证首帧前完成测量，用户看不到回退态）。
  const layout = useMemo<SendStripLayout>(() => {
    if (activeCommands.length === 0) return { visibleCount: 0, overflowCount: 0 };
    if (stripWidth <= 0 || cmdWidths.length === 0) {
      return { visibleCount: 0, overflowCount: activeCommands.length };
    }
    return computeFitCount(stripWidth, cmdWidths, {
      panelButtonWidth: panelBtnWidth > 0 ? panelBtnWidth : PANEL_BUTTON_ESTIMATE,
      gap: QUICK_STRIP_GAP,
      minButtons: 1, // 有条命令时至少露一条（容器放得下面板按钮的前提下）
      maxButtons: activeCommands.length, // 纯宽度驱动，不再按 config 条数截断
    });
  }, [stripWidth, cmdWidths, panelBtnWidth, activeCommands]);
  const visibleCommands = useMemo(
    () => activeCommands.slice(0, layout.visibleCount),
    [activeCommands, layout.visibleCount]
  );

  const openQuickPanel = () => {
    popoutService
      .openPopout('quick-send')
      .catch((e) => console.debug('[SendSection] openPopout failed:', e));
  };
  const handleSend = async () => {
    if (!isPortActive || !sendInput.trim()) return;
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
      if (!sendCommandSets.find(s => s.id === activeSendCommandSetId) && sendCommandSets.length > 0) {
        setActiveSendCommandSetId(sendCommandSets[0].id);
      }
      setCyclicLoop(activeTabId, true);
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
        <div className="op-quick-send-row" ref={stripRef}>
          {/* 首槽：常驻「打开独立发送面板」入口——issue #7-2：明显的按压按钮样式
              （accent 填充 + 文字标签，区别于滚动锁定等带状态的图标按钮），
              高度与两行药丸对齐；0 条命令时也保留（面板仍有内容可看）。 */}
          <button
            ref={panelBtnRef}
            className="btn btn-sm op-quick-panel-btn"
            title={t('quickSend.openPanel')}
            onClick={openQuickPanel}
          >
            <PanelRightOpen size={14} />
            <span className="op-quick-panel-btn-label">{t('quickSend.openPanelShort')}</span>
          </button>
          {activeCommands.length > 0 ? (
            <>
              {visibleCommands.map(cmd => renderQuickCmdPill(cmd, isPortActive, () => handleQuickCommand(cmd)))}
              {layout.overflowCount > 0 && (
                <button
                  className="btn btn-sm op-quick-cmd op-quick-cmd-overflow"
                  title={t('quickSend.overflow')}
                  onClick={openQuickPanel}
                >
                  ⋯ +{layout.overflowCount}
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
          {/* 隐藏测量行：绝对定位 + visibility:hidden，渲染全部命令以测量
              真实宽度；与可见药丸共用 renderQuickCmdPill，宽度严格一致。 */}
          {activeCommands.length > 0 && (
            <div className="op-quick-measure-row" ref={measureRowRef} aria-hidden="true">
              {activeCommands.map(cmd => renderQuickCmdPill(cmd, isPortActive, () => {}))}
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
            <label className="checkbox-wrapper op-checkbox-compact" title={t('sendSection.clearAfterSend')}>
              <input
                type="checkbox"
                checked={clearSendInputAfterSend}
                onChange={e => setConfig({ clearSendInputAfterSend: e.target.checked })}
              />
              {t('sendSection.clearAfterSend')}
            </label>
            <select
              className="select op-line-ending-select"
              value={sendAppendLineEnding}
              onChange={e => setOpState({ sendAppendLineEnding: e.target.value as LineEnding })}
            >
              <option value={'\r\n'}>{t('sendSection.lineEnding.crlf')}</option>
              <option value={'\r'}>{t('sendSection.lineEnding.cr')}</option>
              <option value={'\n'}>{t('sendSection.lineEnding.lf')}</option>
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

// memo：props 均稳定（activeTabId 字符串 / 布尔原语 / sendData·historyUp·historyDown
// 均为 useCallback 返回），OperationPanel 重渲染时不再拖累发送区。
// historyUp/Down 仅在发送历史变化（即一次真实发送）后更换引用，此时重渲染是合理的。
export default React.memo(SendSection);
