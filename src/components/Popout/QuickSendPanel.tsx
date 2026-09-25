import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { popoutEventService, storageService } from '../../services/tauri';
import { notifyError } from '../../stores/useToastStore';
import { LINE_ENDING_VALUES, lineEndingLabelKey } from '../../utils/sendUtils';
import { clampInterval, clampRoundInterval } from '../../utils/textSend';
import { usePopoutSync } from './usePopoutSync';
import { usePanelTextConfig } from './usePanelTextConfig';
import QuickSendList from './QuickSendList';
import QuickSendText from './QuickSendText';
import type { LineEnding, SendCommand, SendCommandSet } from '../../types';

/** 发送成功的行内闪烁时长（与内联条共用"短促闪烁"反馈语言）。 */
const FLASH_MS = 260;

/** 文本模式发送间隔 / 轮次间隔的可调上限（ms）。 */
const SEND_INTERVAL_MAX = 60_000;
const ROUND_INTERVAL_MAX = 600_000;

/**
 * 快捷发送面板（瘦高独立窗内容，宿主无关组件，issue #5-4 双模式重构）。
 *
 * 架构原则：弹窗与主窗不共享可变前端态，只交换意图/事件。
 * - 数据：主窗 `useRuleStore` 是唯一真相——`usePopoutSync` 负责基线、事件总线与
 *   对表；命令集编辑经 `popout:command-set-updated` 整集回传主窗（K6），
 *   弹窗本地不再持有可写的命令集副本。
 * - 模式 A（命令列表）：整行可点 = 发送；行内「修改」展开就地编辑器。
 * - 模式 B（文本）：textarea 每行一条命令，当前行 / 顺序 / 从光标 / 循环四种执行
 *   方式由共享引擎驱动（见 QuickSendText）。
 * - 目标端口来自共享参数栏（`portId` 直传主窗，缺省跟随主窗活动标签）。
 *
 * 本文件只做编排：参数栏 + 模式切换 + 目标指示；两种模式各自成组件，窗口同步与
 * 参数持久化各自成 hook。
 */
const QuickSendPanel: React.FC = () => {
  const { t } = useTranslation();
  const { sets, activePortId, ports, connectedPortIds, openSetEditor } = usePopoutSync();
  const { config, patchConfig } = usePanelTextConfig();

  // 模式切换即卸载另一种模式的组件：文本模式的顺序执行随组件卸载自停（引擎的
  // 卸载清理），不需要在这里额外协调 stop。
  const [mode, setMode] = useState<'list' | 'text'>('list');
  const [selectedSetId, setSelectedSetId] = useState<string | null>(null);
  const [flashingId, setFlashingId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 有效选中集由派生得出（而不是在命令集变更回调里维护"被删就回退"的状态）：
  // 用户显式选过就跟随，选择的集不存在或从未选择 → 第一个。
  const selectedSet = useMemo(
    () => sets.find((s) => s.id === selectedSetId) ?? sets[0] ?? null,
    [sets, selectedSetId],
  );

  // 持久化的 portId 已不存在（端口拔出/改名）→ 回退到跟随主窗活动标签。
  useEffect(() => {
    if (config.portId && !ports.some((p) => p.id === config.portId)) {
      patchConfig({ portId: '' });
    }
  }, [ports, config.portId, patchConfig]);

  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    [],
  );

  /** 实际发送目标：手动选择的端口优先，缺省跟随主窗活动标签。 */
  const effectivePortId = config.portId || activePortId;
  const canSend = effectivePortId != null;

  /** 唯一的发送意图出口（两种模式共用；portId 缺省时主窗发送到自己的活动标签）。 */
  const emitSendIntent = useCallback(
    (content: string, isHex: boolean, lineEnding: LineEnding) =>
      popoutEventService.emitSendCommand({
        content,
        isHex,
        lineEnding,
        portId: config.portId || undefined,
      }),
    [config.portId],
  );

  /** 行内闪烁反馈。 */
  const flashRow = useCallback((id: string) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setFlashingId(id);
    flashTimerRef.current = setTimeout(() => setFlashingId(null), FLASH_MS);
  }, []);

  /** 模式 A：发送 = 命令自身携带的类型/行尾；目标端口来自共享参数栏。 */
  const sendCommand = useCallback(
    (cmd: SendCommand) => {
      if (!canSend) return;
      void emitSendIntent(cmd.content, cmd.type === 'hex', cmd.appendLineEnding).catch((e) =>
        console.debug('[QuickSendPanel] emitSendCommand failed:', e),
      );
      flashRow(cmd.id);
    },
    [canSend, emitSendIntent, flashRow],
  );

  /**
   * 模式 A：就地编辑保存——整集回传主窗定案 + 落盘（K6）。
   *
   * 不能只写本地 store：弹窗那份 `useRuleStore` 是另一个 webview 的空实例，
   * `updateSendCommandSet` 在里面恒为 no-op；而主窗之后的任何一次 save_config 都会
   * 拿自己的活实体覆盖 config.json，主窗不知道这次编辑就等于被回滚。
   * 列表刷新走主窗回的 `command-sets:changed`（与其它同步同一个路径，不另存副本）。
   */
  const saveSet = useCallback((set: SendCommandSet) => {
    void popoutEventService
      .emitCommandSetUpdated(set)
      .catch((e) => console.debug('[QuickSendPanel] emitCommandSetUpdated failed:', e));
    void storageService.saveCommandSet(set).catch((e) => notifyError(e));
  }, []);

  return (
    <div className="quicksend-panel">
      {/* 模式切换 */}
      <div className="quicksend-mode-tabs" role="tablist" aria-label={t('quickSend.setLabel')}>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'list'}
          className={`quicksend-mode-tab${mode === 'list' ? ' active' : ''}`}
          onClick={() => setMode('list')}
        >
          {t('quickSend.mode.list')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'text'}
          className={`quicksend-mode-tab${mode === 'text' ? ' active' : ''}`}
          onClick={() => setMode('text')}
        >
          {t('quickSend.mode.text')}
        </button>
      </div>

      {/* 共享参数栏（两种模式） */}
      <div className="quicksend-params">
        <div className="quicksend-param-row">
          <label className="quicksend-param-label">{t('quickSend.targetPort')}</label>
          <select
            className="select quicksend-param-control"
            value={config.portId || activePortId || ''}
            disabled={ports.length === 0}
            onChange={(e) => patchConfig({ portId: e.target.value })}
            title={t('quickSend.targetPort')}
          >
            <option value="">
              {ports.length === 0 ? t('quickSend.noPorts') : activePortId ?? t('quickSend.noActivePort')}
            </option>
            {ports.map((p) => (
              <option key={p.id} value={p.id}>
                {/* issue #7-4：去掉无意义的「· REAL/VIRTUAL」类型后缀，只显示串口号 */}
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="quicksend-param-row">
          <label className="quicksend-param-label">{t('quickSend.lineEnding')}</label>
          <select
            className="select quicksend-param-control"
            value={config.lineEnding}
            onChange={(e) => patchConfig({ lineEnding: e.target.value as LineEnding })}
          >
            {LINE_ENDING_VALUES.map((v) => (
              <option key={v} value={v}>
                {t(lineEndingLabelKey(v, 'sendSection'))}
              </option>
            ))}
          </select>
          <label className="quicksend-param-label">{t('quickSend.format')}</label>
          <div className="quicksend-format-toggle">
            <button
              type="button"
              className={!config.isHex ? 'active' : ''}
              onClick={() => patchConfig({ isHex: false })}
            >
              STR
            </button>
            <button
              type="button"
              className={config.isHex ? 'active' : ''}
              onClick={() => patchConfig({ isHex: true })}
            >
              HEX
            </button>
          </div>
        </div>
        {mode === 'text' && (
          <>
            <div className="quicksend-param-row">
              <label className="quicksend-param-label">{t('quickSend.sendInterval')}</label>
              <input
                type="number"
                className="input quicksend-param-number"
                min={1}
                max={SEND_INTERVAL_MAX}
                step={1}
                value={config.sendIntervalMs}
                onChange={(e) =>
                  patchConfig({
                    sendIntervalMs: Math.min(
                      SEND_INTERVAL_MAX,
                      clampInterval(Number(e.target.value)),
                    ),
                  })
                }
              />
            </div>
            <div className="quicksend-param-row">
              <label className="quicksend-param-label">{t('quickSend.roundInterval')}</label>
              <input
                type="number"
                className="input quicksend-param-number"
                min={0}
                max={ROUND_INTERVAL_MAX}
                step={1}
                value={config.roundIntervalMs}
                onChange={(e) =>
                  patchConfig({
                    roundIntervalMs: Math.min(
                      ROUND_INTERVAL_MAX,
                      clampRoundInterval(Number(e.target.value)),
                    ),
                  })
                }
              />
            </div>
          </>
        )}
      </div>

      {mode === 'list' ? (
        <QuickSendList
          sets={sets}
          selectedSet={selectedSet}
          onSelectSet={setSelectedSetId}
          flashingId={flashingId}
          onSend={sendCommand}
          onOpenSetEditor={openSetEditor}
          onSaveSet={saveSet}
        />
      ) : (
        <QuickSendText
          text={text}
          onTextChange={setText}
          config={config}
          canSend={canSend}
          onSendLine={emitSendIntent}
        />
      )}

      <div className="quicksend-footer">
        {effectivePortId ? (
          <span className="quicksend-target">
            {t('quickSend.sendTo')}
            {/* issue #7-5：提示灯跟随真实连接状态——已连接绿色（呼吸）、未连接灰色 */}
            <span
              className={`quicksend-dot${connectedPortIds.has(effectivePortId) ? ' is-connected' : ''}`}
              aria-hidden="true"
            />
            <span className="quicksend-target-port">{effectivePortId}</span>
          </span>
        ) : (
          <span className="quicksend-target quicksend-target-muted">
            {ports.length === 0 ? t('quickSend.noActivePort') : t('quickSend.portClosed')}
          </span>
        )}
      </div>
    </div>
  );
};

export default QuickSendPanel;
