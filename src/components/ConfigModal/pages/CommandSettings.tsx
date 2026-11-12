import React, { useId, useState } from 'react';
import { CircleHelp, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import SortableEditorList from '../../shared/SortableEditorList';
import { orderedCommands, renumberCommands } from '../../../utils/commandOrder';
import type { CommandStepKind, SendCommandSet } from '../../../types';
import { createCommandStep, foldDelayIntoRoundGap, isEnhancedCommandSet, runsMultipleRounds } from '../../../utils/commandSteps';
import { formatDurationMs, roundDurationMs, totalDurationMs } from '../../../utils/flowTiming';
import RuleSetAccordion from '../RuleSetAccordion';
import SendCmdEditor from '../editors/SendCmdEditor';
import { useEntityPage } from '../hooks/useEntityPage';
import { NumericInput } from '../../shared/NumericInput';
import '../../../styles/command-settings.css';

/**
 * Command-set fields are not app settings, so their input range is local —
 * the shared `CONFIG_BOUNDS` table only covers `AppConfig` numbers that the Rust
 * side also clamps. Kept as one pair per field so the `clampNumber` bounds and
 * the `min`/`max` attributes can never drift apart.
 */
const LOOP_DELAY_MS = [0, 3_600_000] as const;
const REPEAT_COUNT = [0, 1_000_000] as const;

const CommandSettings: React.FC = () => {
  const { t } = useTranslation();
  const repeatHelpId = useId();
  const [lastAddedCmdId, setLastAddedCmdId] = useState<string | null>(null);
  const page = useEntityPage<SendCommandSet>({ kind: 'sendCommandSets' });
  const updateSendCommandSet = page.update;

  const handleAddSet = (beforeId?: string) => {
    page.create({
      id: crypto.randomUUID(),
      name: t('commandSettings.addSet'),
      commands: [],
      isLoop: false,
      loopDelay: 1000,
      repeatCount: 0,
    }, beforeId);
  };

  const handleAddCmd = (setId: string, beforeId?: string, kind: CommandStepKind = 'send') => {
    const set = page.items.find(s => s.id === setId);
    if (!set) return;
    const cmdId = crypto.randomUUID();
    const commands = orderedCommands(set.commands);
    const index = beforeId ? commands.findIndex(command => command.id === beforeId) : commands.length;
    const name = kind === 'send'
      ? t('commandSettings.defaultCommandName', { index: commands.length + 1 })
      : t(`sendCmdEditor.kind.${kind}`);
    commands.splice(index < 0 ? commands.length : index, 0, createCommandStep(kind, cmdId, name));
    setLastAddedCmdId(cmdId);
    page.update(setId, {
      commands: renumberCommands(commands),
      ...(kind !== 'send' ? { schemaVersion: 2 as const } : {}),
    });
  };

  return (
    <div className="command-settings">
      <RuleSetAccordion<SendCommandSet>
        title={t('commandSettings.accordionTitle')}
        addLabel={t('commandSettings.accordionAddLabel')}
        emptyText={t('commandSettings.accordionEmptyText')}
        items={page.items}
        selectedId={page.expandedId}
        onSelect={page.toggleExpanded}
        onAdd={() => handleAddSet()}
        onInsert={handleAddSet}
        onReorder={page.reorder}
        onDiscard={page.discard}
        dirty={page.dirty}
        isDirty={page.isDirty}
        saving={page.saving}
        error={page.error}
        onDelete={page.remove}
        onSave={page.save}
        onRename={(id, name) => updateSendCommandSet(id, { name })}
        renderEditor={(set) => {
          // 轮末判定与列表顺序同源：最后一步的「之后等待」不生效（轮间用 loopDelay），
          // 编辑器据此把这件事直接说出来，并允许一键并入轮间间隔。
          const ordered = orderedCommands(set.commands);
          const loops = runsMultipleRounds(set);
          const repeat = set.repeatCount ?? 0;
          const round = roundDurationMs(ordered);
          const total = totalDurationMs(ordered, loops ? set.loopDelay : 0, loops ? repeat : 1) ?? 0;
          return <div className="command-set-editor">
            <section className="command-run-bar" aria-label={t('commandSettings.executionTitle')}>
              <label className="checkbox-wrapper">
                <input type="checkbox" checked={set.isLoop} onChange={e => updateSendCommandSet(set.id, { isLoop: e.target.checked })} />
                {t('commandSettings.loopCheckbox')}
              </label>
              <label title={t('commandSettings.repeatTooltip')}>
                {t('commandSettings.repeatLabel')}
                <NumericInput className="input command-repeat-input" value={repeat} min={REPEAT_COUNT[0]} max={REPEAT_COUNT[1]}
                  aria-describedby={repeatHelpId}
                  onCommit={value => updateSendCommandSet(set.id, { repeatCount: value })} />
              </label>
              <label title={t('commandSettings.loopDelayTooltip')}>
                {t('commandSettings.roundGapLabel')}
                <NumericInput className="input command-round-gap-input" value={set.loopDelay} min={LOOP_DELAY_MS[0]} max={LOOP_DELAY_MS[1]}
                  aria-label={`${t('commandSettings.roundGapLabel')} (ms)`} disabled={!loops}
                  onCommit={value => updateSendCommandSet(set.id, { loopDelay: value })} />
                ms
              </label>
              <span className="command-sr-only" id={repeatHelpId}>{t('commandSettings.repeatTooltip')}</span>
              {round > 0 && <span className="command-timing-summary" aria-live="polite" title={t('commandSettings.timingExcludesDevice')}>
                {loops
                  ? (repeat > 0
                    ? t('commandSettings.timingSummary', { round: formatDurationMs(round), rounds: repeat, total: formatDurationMs(total) })
                    : t('commandSettings.timingSummaryOpen', { round: formatDurationMs(round) }))
                  : t('commandSettings.timingSummaryOnce', { round: formatDurationMs(total) })}
              </span>}
            </section>
            <div className="command-list-toolbar">
              <div className="command-list-actions">
                <button type="button" className="btn btn-sm" disabled={page.saving} onClick={() => handleAddCmd(set.id)}><Plus size={12} />{t('commandSettings.addCommandButton')}</button>
                <button type="button" className="btn btn-sm" disabled={page.saving} onClick={() => handleAddCmd(set.id, undefined, 'setParams')}><Plus size={12} />{t('commandSettings.addParams')}</button>
              </div>
              <details className="command-behavior-details">
                <summary title={t('commandSettings.behaviorDetails')} aria-label={t('commandSettings.behaviorDetails')}><CircleHelp size={14} /></summary>
                <div className="command-help-content">
                  <p>{t('commandSettings.accordionDescription')} {t('editor.changesNextRun')}</p>
                  <p>{t('commandSettings.repeatTooltip')}</p>
                  <p>{t(isEnhancedCommandSet(set) ? 'commandSettings.enhancedHint' : 'commandSettings.legacyHint')}</p>
                  <p>{t('commandSettings.timingExcludesDevice')}</p>
                </div>
              </details>
            </div>
            {ordered.length > 0 && <div className="command-column-headings" aria-hidden="true">
              <span /><span>#</span><span>{t('sendCmdEditor.namePlaceholder')}</span>
              <span>{t('sendCmdEditor.stepKind')}</span><span>{t('quickSend.format')}</span><span>{t('quickSend.lineEnding')}</span><span />
            </div>}
            {ordered.length === 0 && <div className="config-placeholder">{t('commandSettings.emptyCommandsText')}</div>}
            <SortableEditorList items={ordered} disabled={page.saving}
              onReorder={ids => page.update(set.id, { commands: renumberCommands(ids.map(id => set.commands.find(command => command.id === id)!)) })}
              renderItem={(cmd, idx, handle) => <SendCmdEditor
                cmd={cmd}
                cmdIdx={idx}
                handle={handle}
                isRoundFinal={idx === ordered.length - 1}
                loops={loops}
                onFoldIntoRoundGap={() => page.update(set.id, foldDelayIntoRoundGap(set, cmd.id))}
                onInsert={() => handleAddCmd(set.id, cmd.id)}
                onInsertBelow={() => handleAddCmd(set.id, ordered[idx + 1]?.id)}
                autoFocus={cmd.id === lastAddedCmdId}
                onChange={patch => page.update(set.id, {
                  commands: set.commands.map(command => command.id === cmd.id ? { ...command, ...patch } : command),
                  ...(patch.kind && patch.kind !== 'send' ? { schemaVersion: 2 as const } : {}),
                })}
                onDelete={() => page.update(set.id, { commands: renumberCommands(orderedCommands(set.commands).filter(command => command.id !== cmd.id)) })}
              />} />
          </div>;
        }}
        countLabel={(set) => t('commandSettings.countLabel', { count: set.commands.length })}
      />
    </div>
  );
};

export default CommandSettings;
