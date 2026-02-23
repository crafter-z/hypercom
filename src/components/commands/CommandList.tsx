import { useState } from 'react';
import { Plus, FolderPlus, Edit2, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import type { Command, CommandGroup } from '../../types';
import { CommandItem } from './CommandItem';

interface CommandListProps {
  groups: CommandGroup[];
  activeGroupId: string | null;
  onSelectGroup: (id: string) => void;
  onCreateGroup: () => void;
  onEditGroup: (group: CommandGroup) => void;
  onDeleteGroup: (id: string) => void;
  onExecuteCommand: (command: Command) => void;
  onEditCommand: (command: Command, groupId: string) => void;
  onDeleteCommand: (commandId: string, groupId: string) => void;
  onAddCommand: (groupId: string) => void;
}

export function CommandList({
  groups,
  activeGroupId,
  onSelectGroup,
  onCreateGroup,
  onEditGroup,
  onDeleteGroup,
  onExecuteCommand,
  onEditCommand,
  onDeleteCommand,
  onAddCommand,
}: CommandListProps) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [deletingGroupId, setDeletingGroupId] = useState<string | null>(null);

  const toggleGroup = (id: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleDeleteGroup = (group: CommandGroup) => {
    if (deletingGroupId === group.id) {
      onDeleteGroup(group.id);
      setDeletingGroupId(null);
    } else {
      setDeletingGroupId(group.id);
      setTimeout(() => setDeletingGroupId(null), 3000);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center justify-between p-3 border-b">
        <h3 className="font-semibold text-sm">命令组</h3>
        <button
          onClick={onCreateGroup}
          className="p-1.5 rounded hover:bg-accent transition-colors"
          title="新建命令组"
        >
          <FolderPlus size={16} />
        </button>
      </div>

      {/* 命令组列表 */}
      <div className="flex-1 overflow-auto">
        {groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
            <p className="text-sm">暂无命令组</p>
            <button
              onClick={onCreateGroup}
              className="mt-2 flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <Plus size={12} />
              创建第一个命令组
            </button>
          </div>
        ) : (
          <div className="divide-y">
            {groups.map((group) => (
              <div key={group.id} className="group/item">
                {/* 命令组头部 */}
                <div
                  className={`flex items-center gap-2 p-2 cursor-pointer hover:bg-accent/50 transition-colors ${
                    activeGroupId === group.id ? 'bg-accent/50' : ''
                  }`}
                  onClick={() => {
                    onSelectGroup(group.id);
                    toggleGroup(group.id);
                  }}
                >
                  {/* 展开/折叠图标 */}
                  {expandedGroups.has(group.id) ? (
                    <ChevronDown size={14} className="text-muted-foreground" />
                  ) : (
                    <ChevronRight size={14} className="text-muted-foreground" />
                  )}

                  {/* 命令组名称 */}
                  <span className="flex-1 font-medium text-sm truncate">
                    {group.name}
                  </span>

                  {/* 命令数量 */}
                  <span className="text-xs text-muted-foreground">
                    {group.commands.length}
                  </span>

                  {/* 操作按钮 */}
                  <div className="flex items-center gap-1 opacity-0 group-hover/item:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onAddCommand(group.id);
                      }}
                      className="p-1 rounded hover:bg-primary/10 text-primary"
                      title="添加命令"
                    >
                      <Plus size={12} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditGroup(group);
                      }}
                      className="p-1 rounded hover:bg-secondary"
                      title="编辑命令组"
                    >
                      <Edit2 size={12} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteGroup(group);
                      }}
                      className={`p-1 rounded ${
                        deletingGroupId === group.id
                          ? 'bg-destructive/10 text-destructive'
                          : 'hover:bg-destructive/10 hover:text-destructive'
                      }`}
                      title={deletingGroupId === group.id ? '确认删除' : '删除命令组'}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>

                {/* 命令列表 */}
                {expandedGroups.has(group.id) && group.commands.length > 0 && (
                  <div className="pl-6 pr-2 pb-2 space-y-1">
                    {group.commands.map((command) => (
                      <CommandItem
                        key={command.id}
                        command={command}
                        onExecute={(cmd) => onExecuteCommand(cmd)}
                        onEdit={(cmd) => onEditCommand(cmd, group.id)}
                        onDelete={(cmdId) => onDeleteCommand(cmdId, group.id)}
                      />
                    ))}
                  </div>
                )}

                {/* 空命令组提示 */}
                {expandedGroups.has(group.id) && group.commands.length === 0 && (
                  <div className="pl-6 pr-2 pb-2">
                    <button
                      onClick={() => onAddCommand(group.id)}
                      className="w-full flex items-center justify-center gap-1 p-2 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded transition-colors"
                    >
                      <Plus size={12} />
                      添加命令
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
