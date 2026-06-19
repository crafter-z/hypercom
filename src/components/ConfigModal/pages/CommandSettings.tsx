import React, { useState, useEffect } from 'react';
import { useRuleStore } from '../../../stores/useRuleStore';
import { storageService } from '../../../services/tauri';
import type { SendCommandSet, SendCommand } from '../../../types';
import RuleSetAccordion from '../RuleSetAccordion';
import SendCmdEditor from '../editors/SendCmdEditor';

const CommandSettings: React.FC = () => {
  const sendCommandSets = useRuleStore((s) => s.sendCommandSets);
  const addSendCommandSet = useRuleStore((s) => s.addSendCommandSet);
  const updateSendCommandSet = useRuleStore((s) => s.updateSendCommandSet);
  const removeSendCommandSet = useRuleStore((s) => s.removeSendCommandSet);
  const [expandedSetId, setExpandedSetId] = useState<string | null>(null);

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
    try { await storageService.deleteCommandSet(setId); } catch (e) { console.error('Failed to delete command set from DB:', e); }
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
    }
  };

  const handleAddSet = () => {
    const id = `cmd-${Date.now()}`;
    addSendCommandSet({ id, name: '新建命令集', commands: [], isLoop: false, loopDelay: 1000 });
    setExpandedSetId(id);
  };

  const handleAddCmd = (setId: string) => {
    const cmdId = `scmd-${Date.now()}`;
    const sets = useRuleStore.getState().sendCommandSets;
    const set = sets.find(s => s.id === setId);
    if (set) {
      updateSendCommandSet(setId, {
        commands: [...set.commands, {
          id: cmdId,
          name: `命令 ${set.commands.length + 1}`,
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
      title="发送命令规则集"
      description="管理自动发送命令规则集。每个规则集包含多条命令，可设置顺序、名称、延时、发送类型、命令内容。支持循环发送模式。"
      addLabel="新建规则集"
      emptyText='暂无命令规则集，点击"新建规则集"创建'
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
            /> 循环
          </label>
          {set.isLoop && (
            <input
              className="input"
              type="number"
              value={set.loopDelay}
              onChange={e => updateSendCommandSet(set.id, { loopDelay: Number(e.target.value) })}
              onClick={e => e.stopPropagation()}
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
          onChange={(patch) => {
            const newCmds = set.commands.map((c, i) => i === idx ? { ...c, ...patch } : c);
            updateSendCommandSet(set.id, { commands: newCmds });
          }}
          onDelete={() => {
            updateSendCommandSet(set.id, { commands: set.commands.filter((_, i) => i !== idx) });
          }}
        />
      ))}
      countLabel={(set) => `${set.commands.length} 条命令`}
      addItemLabel="添加命令"
      onAddItem={handleAddCmd}
      itemCount={(set) => set.commands.length}
      emptyItemText="暂无命令，请添加"
    />
  );
};

export default CommandSettings;
