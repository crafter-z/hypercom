import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useRuleStore } from '../../../stores/useRuleStore';
import { storageService } from '../../../services/tauri';
import { notifyError } from '../../../stores/useToastStore';
import type { SendCommandSet, SendCommand } from '../../../types';
import RuleSetAccordion from '../RuleSetAccordion';
import SendCmdEditor from '../editors/SendCmdEditor';

/** Clamp a numeric input to [min, max], falling back to min on NaN (e.g. a cleared field). */
const clampNumber = (raw: string, min: number, max: number): number => {
  const value = Number(raw);
  return Number.isNaN(value) ? min : Math.max(min, Math.min(max, value));
};

const CommandSettings: React.FC = () => {
  const { t } = useTranslation();
  const sendCommandSets = useRuleStore((s) => s.sendCommandSets);
  const addSendCommandSet = useRuleStore((s) => s.addSendCommandSet);
  const updateSendCommandSet = useRuleStore((s) => s.updateSendCommandSet);
  const removeSendCommandSet = useRuleStore((s) => s.removeSendCommandSet);
  const [expandedSetId, setExpandedSetId] = useState<string | null>(null);
  const [lastAddedCmdId, setLastAddedCmdId] = useState<string | null>(null);

  useEffect(() => {
    storageService.loadCommandSets().then(sets => {
      if (sets.length > 0) {
        useRuleStore.getState().setSendCommandSets(sets.map(s => ({
          id: s.id,
          name: s.name,
          isLoop: s.is_loop,
          loopDelay: s.loop_delay_ms,
          commands: s.commands.map(c => ({
            id: c.id,
            name: c.name,
            order: c.order_idx,
            delay: c.delay_ms,
            type: c.cmd_type as 'string' | 'hex',
            content: c.content,
            appendLineEnding: c.append_line_ending as SendCommand['appendLineEnding'],
          })),
        })));
      }
    }).catch((e) => console.debug('[ConfigModal] loadCommandSets failed:', e));
  }, []);

  const handleRemoveCmdSet = async (setId: string) => {
    removeSendCommandSet(setId);
    try { await storageService.deleteCommandSet(setId); } catch (e) { console.error('Failed to delete command set from DB:', e); notifyError(e); }
  };

  const handleSaveSet = async (setId: string) => {
    const set = useRuleStore.getState().sendCommandSets.find(s => s.id === setId);
    if (!set) return;
    try {
      await storageService.saveCommandSet({
        id: set.id,
        name: set.name,
        is_loop: set.isLoop,
        loop_delay_ms: set.loopDelay,
        commands: set.commands.map(c => ({
          id: c.id,
          name: c.name,
          order_idx: c.order,
          delay_ms: c.delay,
          cmd_type: c.type,
          content: c.content,
          append_line_ending: c.appendLineEnding,
        })),
      });
    } catch (err) {
      console.error('Failed to save command set:', err);
      notifyError(err);
    }
  };

  const handleAddSet = () => {
    const id = `cmd-${Date.now()}`;
    addSendCommandSet({ id, name: t('commandSettings.addSet'), commands: [], isLoop: false, loopDelay: 1000 });
    setExpandedSetId(id);
  };

  const handleAddCmd = (setId: string) => {
    const cmdId = `scmd-${Date.now()}`;
    setLastAddedCmdId(cmdId);
    const sets = useRuleStore.getState().sendCommandSets;
    const set = sets.find(s => s.id === setId);
    if (set) {
      updateSendCommandSet(setId, {
        commands: [...set.commands, {
          id: cmdId,
          name: t('commandSettings.defaultCommandName', { index: set.commands.length + 1 }),
          order: set.commands.length,
          delay: 100,
          type: 'string',
          content: '',
          appendLineEnding: '\\r\\n',
        }]
      });
    }
  };

  const handleSelect = (id: string) => setExpandedSetId(expandedSetId === id ? null : id);

  return (
    <RuleSetAccordion<SendCommandSet>
      title={t('commandSettings.accordionTitle')}
      description={t('commandSettings.accordionDescription')}
      addLabel={t('commandSettings.accordionAddLabel')}
      emptyText={t('commandSettings.accordionEmptyText')}
      items={sendCommandSets}
      selectedId={expandedSetId}
      onSelect={handleSelect}
      onAdd={handleAddSet}
      onDelete={handleRemoveCmdSet}
      onSave={handleSaveSet}
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
              onChange={e => updateSendCommandSet(set.id, { loopDelay: clampNumber(e.target.value, 0, 3600000) })}
              onClick={e => e.stopPropagation()}
              min={0}
              max={3600000}
              style={{ width: 60, fontSize: 11 }}
              placeholder="ms"
            />
          )}
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
