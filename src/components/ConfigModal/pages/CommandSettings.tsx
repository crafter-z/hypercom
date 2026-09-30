import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRuleStore } from '../../../stores/useRuleStore';
import { storageService } from '../../../services/tauri';
import type { SendCommandSet } from '../../../types';
import RuleSetAccordion from '../RuleSetAccordion';
import SendCmdEditor from '../editors/SendCmdEditor';
import { useEntityPage } from '../hooks/useEntityPage';
import { clampNumber } from '../../../utils/clampNumber';

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
  const sendCommandSets = useRuleStore((s) => s.sendCommandSets);
  const updateSendCommandSet = useRuleStore((s) => s.updateSendCommandSet);
  const [lastAddedCmdId, setLastAddedCmdId] = useState<string | null>(null);

  const page = useEntityPage<SendCommandSet>({
    items: sendCommandSets,
    label: 'CommandSettings',
    ops: {
      load: () => storageService.loadCommandSets(),
      read: () => useRuleStore.getState().sendCommandSets,
      replace: (items) => useRuleStore.getState().setSendCommandSets(items),
      add: (set) => useRuleStore.getState().addSendCommandSet(set),
      drop: (id) => useRuleStore.getState().removeSendCommandSet(id),
      persist: (set) => storageService.saveCommandSet(set),
      remove: (id) => storageService.deleteCommandSet(id),
    },
  });

  const handleAddSet = () => {
    page.create({
      id: `cmd-${Date.now()}`,
      name: t('commandSettings.addSet'),
      commands: [],
      isLoop: false,
      loopDelay: 1000,
      repeatCount: 0,
    });
  };

  const handleAddCmd = (setId: string) => {
    const set = useRuleStore.getState().sendCommandSets.find(s => s.id === setId);
    if (!set) return;
    const cmdId = `scmd-${Date.now()}`;
    setLastAddedCmdId(cmdId);
    updateSendCommandSet(setId, {
      commands: [...set.commands, {
        id: cmdId,
        name: t('commandSettings.defaultCommandName', { index: set.commands.length + 1 }),
        order: set.commands.length,
        delay: 100,
        type: 'string',
        content: '',
        appendLineEnding: '\\r\\n',
      }],
    });
  };

  return (
    <RuleSetAccordion<SendCommandSet>
      title={t('commandSettings.accordionTitle')}
      description={t('commandSettings.accordionDescription')}
      addLabel={t('commandSettings.accordionAddLabel')}
      emptyText={t('commandSettings.accordionEmptyText')}
      items={sendCommandSets}
      selectedId={page.expandedId}
      onSelect={page.toggleExpanded}
      onAdd={handleAddSet}
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
            <input
              className="input"
              type="number"
              value={set.loopDelay}
              onChange={e => updateSendCommandSet(set.id, { loopDelay: clampNumber(e.target.value, LOOP_DELAY_MS[0], LOOP_DELAY_MS[1]) })}
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
          <input
            className="input"
            type="number"
            value={set.repeatCount ?? 0}
            onChange={e => updateSendCommandSet(set.id, { repeatCount: clampNumber(e.target.value, REPEAT_COUNT[0], REPEAT_COUNT[1]) })}
            onClick={e => e.stopPropagation()}
            min={REPEAT_COUNT[0]}
            max={REPEAT_COUNT[1]}
            style={{ width: 52, fontSize: 11 }}
            title={t('commandSettings.repeatTooltip')}
          />
        </>
      )}
      renderEditor={(set) => set.commands.map((cmd, idx) => (
        <SendCmdEditor
          key={cmd.id}
          cmd={cmd}
          cmdIdx={idx}
          autoFocus={cmd.id === lastAddedCmdId}
          onChange={(patch) => {
            const newCmds = set.commands.map((c, i) => i === idx ? { ...c, ...patch } : c);
            updateSendCommandSet(set.id, { commands: newCmds });
          }}
          onDelete={() => {
            updateSendCommandSet(set.id, { commands: set.commands.filter((_, i) => i !== idx) });
          }}
        />
      ))}
      countLabel={(set) => t('commandSettings.countLabel', { count: set.commands.length })}
      addItemLabel={t('commandSettings.addCommandButton')}
      onAddItem={handleAddCmd}
      itemCount={(set) => set.commands.length}
      emptyItemText={t('commandSettings.emptyCommandsText')}
    />
  );
};

export default CommandSettings;
