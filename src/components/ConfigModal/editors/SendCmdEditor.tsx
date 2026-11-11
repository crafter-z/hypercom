import React, { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownToLine, ArrowUpToLine, Trash2 } from 'lucide-react';
import type { CommandStepKind, SendCommand } from '../../../types';
import { LINE_ENDING_VALUES, lineEndingLabelKey } from '../../../utils/sendUtils';
import { COMMAND_BAUD_RATE, commandStepKindPatch, getCommandStepKind } from '../../../utils/commandSteps';
import { AfterDelayField } from '../../shared/AfterDelayField';
import { NumericInput } from '../../shared/NumericInput';

interface SendCmdEditorProps {
  cmd: SendCommand;
  cmdIdx: number;
  onChange: (patch: Partial<SendCommand>) => void;
  onDelete: () => void;
  autoFocus?: boolean;
  handle?: React.ReactNode;
  onInsert?: () => void;
  onInsertBelow?: () => void;
  /**
   * 本轮的最后一步。轮末不使用本步的 `delay`——轮与轮之间的间隔由集合的
   * 「轮间间隔」承担；`AfterDelayField` 据此把这件事写在界面上。
   */
  isRoundFinal?: boolean;
  /** 该集合会跑多轮（`runsMultipleRounds`），决定轮末是否提供「并入轮间间隔」。 */
  loops?: boolean;
  onFoldIntoRoundGap?: () => void;
}

const SendCmdEditor: React.FC<SendCmdEditorProps> = ({
  cmd, cmdIdx, onChange, onDelete, autoFocus, handle, onInsert, onInsertBelow,
  isRoundFinal = false, loops = false, onFoldIntoRoundGap,
}) => {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const kind = getCommandStepKind(cmd);

  useEffect(() => {
    if (autoFocus) {
      const input = contentRef.current ?? nameRef.current;
      input?.focus();
      input?.scrollIntoView({ block: 'nearest' });
    }
  }, [autoFocus]);

  return (
    <div style={{ background: 'var(--bg-secondary)', borderRadius: 4, padding: 8, marginBottom: 6 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 4 }}>
        {handle}
        {onInsert && <button type="button" className="btn btn-icon btn-sm" title={t('editor.insertAbove')} aria-label={t('editor.insertAbove')} onClick={onInsert}><ArrowUpToLine size={12} /></button>}
        {onInsertBelow && <button type="button" className="btn btn-icon btn-sm" title={t('editor.insertBelow')} aria-label={t('editor.insertBelow')} onClick={onInsertBelow}><ArrowDownToLine size={12} /></button>}
        <span style={{ fontSize: 11, color: 'var(--text-secondary)', minWidth: 20 }}>#{cmdIdx + 1}</span>
        <input ref={nameRef} className="input" value={cmd.name} onChange={e => onChange({ name: e.target.value })} aria-label={t('sendCmdEditor.namePlaceholder')} placeholder={t('sendCmdEditor.namePlaceholder')} style={{ width: 110 }} />
        <select className="select" value={kind} aria-label={t('sendCmdEditor.stepKind')} onChange={e => onChange(commandStepKindPatch(cmd, e.target.value as CommandStepKind))}>
          <option value="send">{t('sendCmdEditor.kind.send')}</option>
          <option value="setParams">{t('sendCmdEditor.kind.setParams')}</option>
          {kind === 'unknown' && <option value="unknown" disabled>{t('sendCmdEditor.kind.unknown')}</option>}
        </select>
        {kind === 'send' && <>
          <select className="select" value={cmd.type} onChange={e => onChange({ type: e.target.value as 'string' | 'hex' })} style={{ width: 80 }}>
            <option value="string">{t('sendCmdEditor.type.string')}</option>
            <option value="hex">HEX</option>
          </select>
          <select className="select" value={cmd.appendLineEnding} onChange={e => onChange({ appendLineEnding: e.target.value as SendCommand['appendLineEnding'] })} style={{ width: 70 }}>
            {LINE_ENDING_VALUES.map(v => <option key={v} value={v}>{t(lineEndingLabelKey(v, 'sendCmdEditor'))}</option>)}
          </select>
        </>}
        {kind === 'setParams' && <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
          {t('sendCmdEditor.baudRate')}
          <NumericInput className="input" value={cmd.baudRate ?? 115200} min={COMMAND_BAUD_RATE[0]} max={COMMAND_BAUD_RATE[1]} onCommit={baudRate => onChange({ baudRate })} aria-label={t('sendCmdEditor.baudRate')} style={{ width: 110 }} />
        </label>}
        <button type="button" className="btn btn-icon btn-sm" onClick={onDelete} title={t('sendCmdEditor.delete')} aria-label={t('sendCmdEditor.delete')}><Trash2 size={12} /></button>
      </div>

      {kind === 'send' && <input ref={contentRef} className="input" value={cmd.content} onChange={e => onChange({ content: e.target.value })} aria-label={t('sendCmdEditor.contentPlaceholder')} placeholder={t('sendCmdEditor.contentPlaceholder')} style={{ width: '100%' }} />}
      {kind === 'setParams' && <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{t('sendCmdEditor.paramsHint')}</div>}
      {kind === 'unknown' && <div role="alert">{t('editor.unknownCommandStep')}</div>}

      {/* 「之后等待」：每步自带的位置属性，发送与改参都生效。 */}
      {kind !== 'unknown' && (
        <div style={{ marginTop: 6 }}>
          <AfterDelayField
            delay={cmd.delay}
            onCommit={delay => onChange({ delay })}
            isRoundFinal={isRoundFinal}
            loops={loops}
            onFoldIntoRoundGap={onFoldIntoRoundGap}
          />
        </div>
      )}
    </div>
  );
};

export default SendCmdEditor;
