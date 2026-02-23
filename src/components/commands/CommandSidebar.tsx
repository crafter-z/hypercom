import { useState, useEffect } from 'react';
import { PanelLeftClose, PanelLeft } from 'lucide-react';
import { useCommandStore } from '../../stores';
import type { Command, CommandGroup } from '../../types';
import { CommandList } from './CommandList';
import { CommandEditor } from './CommandEditor';

interface CommandSidebarProps {
  isCollapsed: boolean;
  onToggle: () => void;
}

type EditorMode = 'list' | 'create-group' | 'edit-group' | 'create-command' | 'edit-command';

export function CommandSidebar({ isCollapsed, onToggle }: CommandSidebarProps) {
  const {
    groups,
    activeGroupId,
    loading,
    loadGroups,
    saveGroup,
    deleteGroup,
    setActiveGroup,
    executeCommand,
  } = useCommandStore();

  const [editorMode, setEditorMode] = useState<EditorMode>('list');
  const [editingGroup, setEditingGroup] = useState<CommandGroup | null>(null);
  const [editingCommand, setEditingCommand] = useState<Command | null>(null);
  const [targetGroupId, setTargetGroupId] = useState<string | null>(null);

  // 加载命令组
  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  // 处理创建命令组
  const handleCreateGroup = () => {
    setEditingGroup(null);
    setEditorMode('create-group');
  };

  // 处理编辑命令组
  const handleEditGroup = (group: CommandGroup) => {
    setEditingGroup(group);
    setEditorMode('edit-group');
  };

  // 处理删除命令组
  const handleDeleteGroup = async (id: string) => {
    await deleteGroup(id);
    if (activeGroupId === id) {
      setActiveGroup(null);
    }
  };

  // 处理选择命令组
  const handleSelectGroup = (id: string) => {
    setActiveGroup(id);
  };

  // 处理添加命令
  const handleAddCommand = (groupId: string) => {
    setTargetGroupId(groupId);
    setEditingCommand(null);
    setEditorMode('create-command');
  };

  // 处理编辑命令
  const handleEditCommand = (command: Command, groupId: string) => {
    setTargetGroupId(groupId);
    setEditingCommand(command);
    setEditorMode('edit-command');
  };

  // 处理删除命令
  const handleDeleteCommand = async (commandId: string, groupId: string) => {
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;

    const updatedGroup: CommandGroup = {
      ...group,
      commands: group.commands.filter((c) => c.id !== commandId),
      updatedAt: Date.now(),
    };

    await saveGroup(updatedGroup);
  };

  // 处理执行命令
  const handleExecuteCommand = async (command: Command) => {
    await executeCommand(command);
  };

  // 处理保存命令组
  const handleSaveGroup = async (group: CommandGroup) => {
    await saveGroup(group);
    setEditorMode('list');
    setEditingGroup(null);
  };

  // 处理保存命令
  const handleSaveCommand = async (command: Command) => {
    if (!targetGroupId) return;

    const group = groups.find((g) => g.id === targetGroupId);
    if (!group) return;

    const existingIndex = group.commands.findIndex((c) => c.id === command.id);
    let updatedCommands: Command[];

    if (existingIndex >= 0) {
      updatedCommands = [...group.commands];
      updatedCommands[existingIndex] = command;
    } else {
      updatedCommands = [...group.commands, command];
    }

    const updatedGroup: CommandGroup = {
      ...group,
      commands: updatedCommands,
      updatedAt: Date.now(),
    };

    await saveGroup(updatedGroup);
    
    // 如果是编辑模式，返回列表；否则继续添加
    if (editorMode === 'edit-command') {
      setEditorMode('list');
      setEditingCommand(null);
    }
  };

  // 处理取消编辑
  const handleCancelEdit = () => {
    setEditorMode('list');
    setEditingGroup(null);
    setEditingCommand(null);
    setTargetGroupId(null);
  };

  // 获取当前正在编辑的命令组
  const currentGroup = editorMode === 'create-command' || editorMode === 'edit-command'
    ? groups.find((g) => g.id === targetGroupId) || null
    : editingGroup;

  if (isCollapsed) {
    return (
      <div className="w-12 flex flex-col items-center py-2 border-r bg-background">
        <button
          onClick={onToggle}
          className="p-2 rounded hover:bg-accent transition-colors"
          title="展开侧边栏"
        >
          <PanelLeft size={18} />
        </button>
      </div>
    );
  }

  return (
    <div className="w-72 flex flex-col border-r bg-background">
      {/* 折叠按钮 */}
      <div className="flex items-center justify-end p-2 border-b">
        <button
          onClick={onToggle}
          className="p-1.5 rounded hover:bg-accent transition-colors"
          title="折叠侧边栏"
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-hidden">
        {editorMode === 'list' ? (
          <CommandList
            groups={groups}
            activeGroupId={activeGroupId}
            onSelectGroup={handleSelectGroup}
            onCreateGroup={handleCreateGroup}
            onEditGroup={handleEditGroup}
            onDeleteGroup={handleDeleteGroup}
            onExecuteCommand={handleExecuteCommand}
            onEditCommand={handleEditCommand}
            onDeleteCommand={handleDeleteCommand}
            onAddCommand={handleAddCommand}
          />
        ) : (
          <CommandEditor
            group={currentGroup || null}
            editingCommand={editingCommand}
            onSaveGroup={handleSaveGroup}
            onSaveCommand={handleSaveCommand}
            onCancel={handleCancelEdit}
          />
        )}
      </div>

      {/* 加载状态 */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/50">
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" />
        </div>
      )}
    </div>
  );
}
