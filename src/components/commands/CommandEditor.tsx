import { useState, useEffect } from 'react';
import { X, Save, Plus } from 'lucide-react';
import type { Command, CommandGroup } from '../../types';
import { createEmptyCommand } from '../../types';

interface CommandEditorProps {
  group: CommandGroup | null;
  editingCommand: Command | null;
  onSaveGroup: (group: CommandGroup) => void;
  onSaveCommand: (command: Command) => void;
  onCancel: () => void;
}

export function CommandEditor({
  group,
  editingCommand,
  onSaveGroup,
  onSaveCommand,
  onCancel,
}: CommandEditorProps) {
  const [groupName, setGroupName] = useState('');
  const [commandName, setCommandName] = useState('');
  const [commandData, setCommandData] = useState('');
  const [commandDescription, setCommandDescription] = useState('');
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);

  // 初始化表单数据
  useEffect(() => {
    if (group) {
      setGroupName(group.name);
      setIsCreatingGroup(false);
    } else {
      setGroupName('');
      setIsCreatingGroup(true);
    }

    if (editingCommand) {
      setCommandName(editingCommand.name);
      setCommandData(editingCommand.data);
      setCommandDescription(editingCommand.description || '');
    } else {
      setCommandName('');
      setCommandData('');
      setCommandDescription('');
    }
  }, [group, editingCommand]);

  const handleSaveGroup = () => {
    if (!groupName.trim()) return;

    const newGroup: CommandGroup = {
      id: group?.id || crypto.randomUUID(),
      name: groupName.trim(),
      commands: group?.commands || [],
      createdAt: group?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };

    onSaveGroup(newGroup);
    onCancel();
  };

  const handleSaveCommand = () => {
    if (!commandName.trim() || !commandData.trim()) return;

    const newCommand: Command = {
      id: editingCommand?.id || crypto.randomUUID(),
      name: commandName.trim(),
      data: commandData.trim(),
      description: commandDescription.trim() || undefined,
      createdAt: editingCommand?.createdAt || Date.now(),
    };

    onSaveCommand(newCommand);
    
    // 清空表单，准备添加下一条命令
    setCommandName('');
    setCommandData('');
    setCommandDescription('');
  };

  const isEditingCommand = editingCommand !== null;
  const showGroupEditor = isCreatingGroup || (group && !isEditingCommand);

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center justify-between p-4 border-b">
        <h3 className="font-semibold">
          {isEditingCommand ? '编辑命令' : isCreatingGroup ? '新建命令组' : '编辑命令组'}
        </h3>
        <button
          onClick={onCancel}
          className="p-1.5 rounded hover:bg-accent transition-colors"
        >
          <X size={18} />
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* 命令组编辑 */}
        {showGroupEditor && (
          <div className="space-y-3">
            <label className="block">
              <span className="text-sm font-medium text-muted-foreground">
                命令组名称
              </span>
              <input
                type="text"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="输入命令组名称..."
                className="mt-1 w-full px-3 py-2 rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </label>

            <button
              onClick={handleSaveGroup}
              disabled={!groupName.trim()}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Save size={16} />
              保存命令组
            </button>
          </div>
        )}

        {/* 命令编辑 */}
        {group && (
          <div className="space-y-3">
            <div className="text-sm font-medium text-muted-foreground">
              {isEditingCommand ? '编辑命令' : '添加新命令'}
            </div>

            <label className="block">
              <span className="text-xs text-muted-foreground">命令名称</span>
              <input
                type="text"
                value={commandName}
                onChange={(e) => setCommandName(e.target.value)}
                placeholder="例如：读取版本"
                className="mt-1 w-full px-3 py-2 rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </label>

            <label className="block">
              <span className="text-xs text-muted-foreground">命令数据 (Hex)</span>
              <input
                type="text"
                value={commandData}
                onChange={(e) => setCommandData(e.target.value)}
                placeholder="例如：01 03 00 00 00 01"
                className="mt-1 w-full px-3 py-2 rounded-lg border bg-background font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </label>

            <label className="block">
              <span className="text-xs text-muted-foreground">描述 (可选)</span>
              <textarea
                value={commandDescription}
                onChange={(e) => setCommandDescription(e.target.value)}
                placeholder="命令描述..."
                rows={2}
                className="mt-1 w-full px-3 py-2 rounded-lg border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </label>

            <div className="flex gap-2">
              <button
                onClick={handleSaveCommand}
                disabled={!commandName.trim() || !commandData.trim()}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isEditingCommand ? <Save size={16} /> : <Plus size={16} />}
                {isEditingCommand ? '保存修改' : '添加命令'}
              </button>

              {isEditingCommand && (
                <button
                  onClick={onCancel}
                  className="px-4 py-2 rounded-lg border hover:bg-accent transition-colors"
                >
                  取消
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
