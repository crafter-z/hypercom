import React, { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownToLine, ArrowUpToLine, CircleHelp, Trash2 } from 'lucide-react';
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
  /** 本轮最后一步的 delay 不生效，交给共享等待字段就地说明。 */
  isRoundFinal?: boolean;
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
    <div className="command-step-row" data-step-kind={kind}>
      <div className="command-step-meta">
        <span className="command-step-handle">{handle}</span>
        <span className="command-step-index">{cmdIdx + 1}</span>
        <input ref={nameRef} className="input command-step-name" value={cmd.name} onChange={e => onChange({ name: e.target.value })} aria-label={t('sendCmdEditor.namePlaceholder')} placeholder={t('sendCmdEditor.namePlaceholder')} title={cmd.name} />
        <select className="select command-step-kind" value={kind} aria-label={t('sendCmdEditor.stepKind')} title={t('sendCmdEditor.stepKind')} onChange={e => onChange(commandStepKindPatch(cmd, e.target.value as CommandStepKind))}>
          <option value="send">{t('sendCmdEditor.kind.send')}</option>
          <option value="setParams">{t('sendCmdEditor.kind.setParams')}</option>
          {kind === 'unknown' && <option value="unknown" disabled>{t('sendCmdEditor.kind.unknown')}</option>}
        </select>
        {kind === 'send' ? <>
          <label className="command-row-field">
            <span className="command-sr-only">{t('quickSend.format')}</span>
            <select className="select" value={cmd.type} aria-label={t('quickSend.format')} title={t('quickSend.format')} onChange={e => onChange({ type: e.target.value as 'string' | 'hex' })}>
              <option value="string">{t('sendCmdEditor.type.string')}</option>
              <option value="hex">HEX</option>
            </select>
          </label>
          <label className="command-row-field">
            <span className="command-sr-only">{t('quickSend.lineEnding')}</span>
            <select className="select" value={cmd.appendLineEnding} disabled={cmd.type === 'hex'} aria-label={t('quickSend.lineEnding')} title={t('quickSend.lineEnding')} onChange={e => onChange({ appendLineEnding: e.target.value as SendCommand['appendLineEnding'] })}>
              {LINE_ENDING_VALUES.map(v => <option key={v} value={v}>{t(lineEndingLabelKey(v, 'sendCmdEditor'))}</option>)}
            </select>
          </label>
        </> : <span className="command-step-format-placeholder" />}
        <div className="command-step-actions">
          {onInsert && <button type="button" className="btn btn-icon btn-sm" title={t('editor.insertAbove')} aria-label={t('editor.insertAbove')} onClick={onInsert}><ArrowUpToLine size={12} /></button>}
          {onInsertBelow && <button type="button" className="btn btn-icon btn-sm" title={t('editor.insertBelow')} aria-label={t('editor.insertBelow')} onClick={onInsertBelow}><ArrowDownToLine size={12} /></button>}
          <button type="button" className="btn btn-icon btn-sm command-step-delete" onClick={onDelete} title={t('sendCmdEditor.delete')} aria-label={t('sendCmdEditor.delete')}><Trash2 size={12} /></button>
        </div>
      </div>
      {kind !== 'unknown' ? <div className="command-step-payload">
        {kind === 'send' ? <input ref={contentRef} className="input command-step-content" value={cmd.content} onChange={e => onChange({ content: e.target.value })} aria-label={t('sendCmdEditor.contentPlaceholder')} placeholder={t('sendCmdEditor.contentPlaceholder')} spellCheck={false} /> : <div className="command-step-params">
          <label>{t('sendCmdEditor.baudRate')}
            <NumericInput className="input" value={cmd.baudRate ?? 115200} min={COMMAND_BAUD_RATE[0]} max={COMMAND_BAUD_RATE[1]} onCommit={baudRate => onChange({ baudRate })} aria-label={t('sendCmdEditor.baudRate')} />
          </label>
          <details className="command-step-help">
            <summary title={t('sendCmdEditor.paramsHint')} aria-label={t('sendCmdEditor.paramsHint')}><CircleHelp size={13} /></summary>
            <p className="command-help-content">{t('sendCmdEditor.paramsHint')}</p>
          </details>
        </div>}
        <AfterDelayField compact delay={cmd.delay} onCommit={delay => onChange({ delay })}
          isRoundFinal={isRoundFinal} loops={loops} onFoldIntoRoundGap={onFoldIntoRoundGap} />
      </div> : <div className="editor-error" role="alert">{t('editor.unknownCommandStep')}</div>}
    </div>
  );
};

export default SendCmdEditor;
