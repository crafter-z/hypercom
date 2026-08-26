import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useRuleStore } from '../../../stores/useRuleStore';
import { storageService } from '../../../services/tauri';
import { notifyError } from '../../../stores/useToastStore';
import type { SendCommandSet } from '../../../types';
import RuleSetAccordion from '../RuleSetAccordion';
import SendCmdEditor from '../editors/SendCmdEditor';
import { clampNumber } from '../../../utils/clampNumber';

const CommandSettings: React.FC = () => {
  const { t } = useTranslation();
  const sendCommandSets = useRuleStore((s) => s.sendCommandSets);
  const addSendCommandSet = useRuleStore((s) => s.addSendCommandSet);
  const updateSendCommandSet = useRuleStore((s) => s.updateSendCommandSet);
  const removeSendCommandSet = useRuleStore((s) => s.removeSendCommandSet);
  const [expandedSetId, setExpandedSetId] = useState<string | null>(null);
  const [lastAddedCmdId, setLastAddedCmdId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    storageService.loadCommandSets().then(sets => {
      // 无条件替换：空结果也要写入 store，否则「删光全部命令集」后重开弹窗
      // 会复活幽灵条目并随 ✓ 保存重新落盘（issue #5-2）。
      // 慢返回防护：加载期间用户已增删条目（store 已变）时不覆盖本地编辑。
      if (cancelled) return;
      if (useRuleStore.getState().sendCommandSets.length > 0) return;
      useRuleStore.getState().setSendCommandSets(sets);
    }).catch((e) => {
      console.warn('[ConfigModal] loadCommandSets failed:', e);
      notifyError(e);
    });
    return () => { cancelled = true; };
  }, []);

  const handleRemoveCmdSet = async (setId: string) => {
    removeSendCommandSet(setId);
    try { await storageService.deleteCommandSet(setId); } catch (e) { console.error('Failed to delete command set:', e); notifyError(e); }
  };

  const handleSaveSet = async (setId: string) => {
    const set = useRuleStore.getState().sendCommandSets.find(s => s.id === setId);
    if (!set) return;
    try {
      await storageService.saveCommandSet(set);
    } catch (err) {
      console.error('Failed to save command set:', err);
      notifyError(err);
    }
  };

  const handleAddSet = () => {
    const id = `cmd-${Date.now()}`;
    addSendCommandSet({ id, name: t('commandSettings.addSet'), commands: [], isLoop: false, loopDelay: 1000, repeatCount: 0 });
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
            onChange={e => updateSendCommandSet(set.id, { repeatCount: clampNumber(e.target.value, 0, 1000000) })}
            onClick={e => e.stopPropagation()}
            min={0}
            max={1000000}
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
