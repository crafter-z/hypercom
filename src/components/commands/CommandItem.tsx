import { useState } from 'react';
import { Play, Edit2, Trash2, Check, X } from 'lucide-react';
import type { Command } from '../../types';

interface CommandItemProps {
  command: Command;
  onExecute: (command: Command) => void;
  onEdit: (command: Command) => void;
  onDelete: (id: string) => void;
}

export function CommandItem({ command, onExecute, onEdit, onDelete }: CommandItemProps) {
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = () => {
    if (isDeleting) {
      onDelete(command.id);
      setIsDeleting(false);
    } else {
      setIsDeleting(true);
      // 3秒后自动取消删除确认状态
      setTimeout(() => setIsDeleting(false), 3000);
    }
  };

  return (
    <div className="group flex items-center gap-2 p-2 rounded-lg hover:bg-accent/50 transition-colors">
      {/* 命令名称 */}
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate">{command.name}</div>
        <div className="text-xs text-muted-foreground font-mono truncate">
          {command.data}
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {/* 执行按钮 */}
        <button
          onClick={() => onExecute(command)}
          className="p-1.5 rounded hover:bg-primary/10 text-primary transition-colors"
          title="发送命令"
        >
          <Play size={14} />
        </button>

        {/* 编辑按钮 */}
        <button
          onClick={() => onEdit(command)}
          className="p-1.5 rounded hover:bg-secondary transition-colors"
          title="编辑命令"
        >
          <Edit2 size={14} />
        </button>

        {/* 删除按钮 */}
        <button
          onClick={handleDelete}
          className={`p-1.5 rounded transition-colors ${
            isDeleting
              ? 'bg-destructive/10 text-destructive'
              : 'hover:bg-destructive/10 hover:text-destructive'
          }`}
          title={isDeleting ? '确认删除' : '删除命令'}
        >
          {isDeleting ? <Check size={14} /> : <Trash2 size={14} />}
        </button>

        {/* 取消删除按钮 */}
        {isDeleting && (
          <button
            onClick={() => setIsDeleting(false)}
            className="p-1.5 rounded hover:bg-secondary transition-colors"
            title="取消"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
