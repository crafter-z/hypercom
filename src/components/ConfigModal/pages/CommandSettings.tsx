import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import SortableEditorList from '../../shared/SortableEditorList';
import { orderedCommands, renumberCommands } from '../../../utils/commandOrder';
import type { SendCommandSet } from '../../../types';
import RuleSetAccordion from '../RuleSetAccordion';
import SendCmdEditor from '../editors/SendCmdEditor';
import { useEntityPage } from '../hooks/useEntityPage';
import { NumericInput } from '../../shared/NumericInput';

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

  const handleAddCmd = (setId: string, beforeId?: string) => {
    const set = page.items.find(s => s.id === setId);
    if (!set) return;
    const cmdId = crypto.randomUUID();
    const commands = orderedCommands(set.commands);
    const index = beforeId ? commands.findIndex(command => command.id === beforeId) : commands.length;
    commands.splice(index < 0 ? commands.length : index, 0, {
      id: cmdId,
      name: t('commandSettings.defaultCommandName', { index: commands.length + 1 }),
      order: 0, delay: 100, type: 'string', content: '', appendLineEnding: '\\r\\n',
    });
    setLastAddedCmdId(cmdId);
    page.update(setId, { commands: renumberCommands(commands) });
  };

  return (
    <RuleSetAccordion<SendCommandSet>
      title={t('commandSettings.accordionTitle')}
      description={`${t('commandSettings.accordionDescription')} ${t('editor.changesNextRun')}`}
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
      renderHeaderExtra={(set) => (
        <>
          <label className="checkbox-wrapper" style={{ fontSize: 11 }} onClick={e => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={set.isLoop}
              onChange={e => updateSendCommandSet(set.id, { isLoop: e.target.checked })}
            /> {t('commandSettings.loopCheckbox')}
          </label>
          {set.isLoop && (
            <NumericInput
              className="input"
              value={set.loopDelay}
              onCommit={value => updateSendCommandSet(set.id, { loopDelay: value })}
              onClick={e => e.stopPropagation()}
              min={LOOP_DELAY_MS[0]}
              max={LOOP_DELAY_MS[1]}
              style={{ width: 60, fontSize: 11 }}
              placeholder="ms"
              title={t('commandSettings.loopDelayTooltip')}
            />
          )}
          <span style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
            {t('commandSettings.repeatLabel')}
          </span>
          <NumericInput
            className="input"
            value={set.repeatCount ?? 0}
            onCommit={value => updateSendCommandSet(set.id, { repeatCount: value })}
            onClick={e => e.stopPropagation()}
            min={REPEAT_COUNT[0]}
            max={REPEAT_COUNT[1]}
            style={{ width: 52, fontSize: 11 }}
            title={t('commandSettings.repeatTooltip')}
          />
        </>
      )}
      renderEditor={(set) => <SortableEditorList items={orderedCommands(set.commands)} disabled={page.saving}
        onReorder={ids => page.update(set.id, { commands: renumberCommands(ids.map(id => set.commands.find(command => command.id === id)!)) })}
        renderItem={(cmd, idx, handle) => <SendCmdEditor
          cmd={cmd}
          cmdIdx={idx}
          handle={handle}
          onInsert={() => handleAddCmd(set.id, cmd.id)}
          onInsertBelow={() => handleAddCmd(set.id, orderedCommands(set.commands)[idx + 1]?.id)}
          autoFocus={cmd.id === lastAddedCmdId}
          onChange={patch => page.update(set.id, { commands: set.commands.map(command => command.id === cmd.id ? { ...command, ...patch } : command) })}
          onDelete={() => page.update(set.id, { commands: renumberCommands(orderedCommands(set.commands).filter(command => command.id !== cmd.id)) })}
        />} />}
      countLabel={(set) => t('commandSettings.countLabel', { count: set.commands.length })}
      addItemLabel={t('commandSettings.addCommandButton')}
      onAddItem={handleAddCmd}
      itemCount={(set) => set.commands.length}
      emptyItemText={t('commandSettings.emptyCommandsText')}
    />
  );
};

export default CommandSettings;
