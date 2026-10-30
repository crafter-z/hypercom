import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { popoutEventService } from '../../services/tauri';
import { LINE_ENDING_VALUES, lineEndingLabelKey } from '../../utils/sendUtils';
import { clampInterval, clampRoundInterval } from '../../utils/textSend';
import { NumericInput } from '../shared/NumericInput';
import { usePopoutSync } from './usePopoutSync';
import { usePanelTextConfig } from './usePanelTextConfig';
import QuickSendList from './QuickSendList';
import QuickSendText from './QuickSendText';
import type { LineEnding, SendCommand } from '../../types';

/** 发送成功的行内闪烁时长（与内联条共用"短促闪烁"反馈语言）。 */
const FLASH_MS = 260;

/** 文本模式发送间隔 / 轮次间隔的可调上限（ms）。 */
const SEND_INTERVAL_MAX = 60_000;
const ROUND_INTERVAL_MAX = 600_000;

/**
 * 快捷发送面板（瘦高独立窗内容，宿主无关组件，issue #5-4 双模式重构）。
 *
 * 架构原则：弹窗与主窗不共享可变前端态，只交换意图/事件。
 * - Main owns versioned command drafts; usePopoutSync retains local text until
 *   replacement/save/discard is acknowledged. Only committed rows may send.
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
  const editor = usePopoutSync();
  const { sets, activePortId, ports, connectedPortIds, openSetEditor } = editor;
  const { config, patchConfig } = usePanelTextConfig();

  // Keep the list mounted so expanded editors/search survive mode switches.
  // Text sequences still stop when their component unmounts.
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


  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    [],
  );

  /** 实际发送目标：手动选择的端口优先，缺省跟随主窗活动标签。 */
  const effectivePortId = config.portId || activePortId;
  const canSend = effectivePortId != null;

  /** Each intent carries an explicit target; a text sequence freezes it at start. */
  const emitSendIntent = useCallback(
    (content: string, isHex: boolean, lineEnding: LineEnding, portId = effectivePortId) => {
      if (!portId) return Promise.reject(new Error('No serial target selected'));
      return popoutEventService.emitSendCommand({ content, isHex, lineEnding, portId });
    },
    [effectivePortId],
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
      if (!canSend || !selectedSet || !editor.ready || editor.saving || editor.pending || editor.dirtyIds.has(selectedSet.id)) return;
      void emitSendIntent(cmd.content, cmd.type === 'hex', cmd.appendLineEnding).catch((e) =>
        console.debug('[QuickSendPanel] emitSendCommand failed:', e),
      );
      flashRow(cmd.id);
    },
    [canSend, selectedSet, editor.ready, editor.saving, editor.pending, editor.dirtyIds, emitSendIntent, flashRow],
  );


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
            {config.portId && !ports.some((port) => port.id === config.portId) && (
              <option value={config.portId}>{config.portId}</option>
            )}
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
              <NumericInput
                className="input quicksend-param-number"
                min={1}
                max={SEND_INTERVAL_MAX}
                step={1}
                value={config.sendIntervalMs}
                onCommit={(value) => patchConfig({ sendIntervalMs: clampInterval(value) })}
              />
            </div>
            <div className="quicksend-param-row">
              <label className="quicksend-param-label">{t('quickSend.roundInterval')}</label>
              <NumericInput
                className="input quicksend-param-number"
                min={0}
                max={ROUND_INTERVAL_MAX}
                step={1}
                value={config.roundIntervalMs}
                onCommit={(value) => patchConfig({ roundIntervalMs: clampRoundInterval(value) })}
              />
            </div>
          </>
        )}
      </div>

      <div style={{ display: mode === 'list' ? 'contents' : 'none' }}>
        <QuickSendList
          active={mode === 'list'}
          sets={sets}
          selectedSet={selectedSet}
          onSelectSet={setSelectedSetId}
          flashingId={flashingId}
          onSend={sendCommand}
          onOpenSetEditor={openSetEditor}
          ready={editor.ready}
          dirty={editor.dirty}
          dirtyIds={editor.dirtyIds}
          pending={editor.pending}
          saving={editor.saving}
          error={editor.error}
          conflict={editor.conflict}
          canSend={canSend}
          onReplaceSets={editor.replaceSets}
          onSave={editor.save}
          onDiscard={editor.discard}
          onOverwriteHost={editor.overwriteHost}
          onReloadHost={editor.reloadHost}
        />
      </div>
      {mode === 'text' && (
        <QuickSendText
          text={text}
          onTextChange={setText}
          config={config}
          canSend={canSend}
          targetPortId={effectivePortId}
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
