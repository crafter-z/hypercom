import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PortGroup, SerialPort } from '../../types';
import { useContextMenu, type ContextMenuEntry } from '../shared/ContextMenu';
import { useSidebarActions } from './SidebarActions';
import { groupDroppableId } from './hooks/usePortDragEnd';
import SortablePortItem from './SortablePortItem';
import { Play, Square, Pencil, Trash2, Wrench, ChevronRight } from 'lucide-react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { runSequential } from '../../utils/sequential';

interface GroupItemProps {
  group: PortGroup;
  /** 已按搜索/隐藏过滤的端口列表（成员判断在组件内做）。 */
  ports: SerialPort[];
}

/**
 * Group header — chevron + name + connected-count, nothing else.
 * Connect-all / disconnect-all / rename / delete all live in the
 * right-click context menu. The header stays a droppable target for
 * cross-group port drops.
 */
const GroupItem: React.FC<GroupItemProps> = ({ group, ports }) => {
  const { t } = useTranslation();
  const actions = useSidebarActions();
  // Exclude hidden ports so "hide" actually works for grouped ports too
  // (they reappear in the hidden section when toggled visible).
  const groupPorts = ports.filter(p => group.portIds.includes(p.id) && !p.isHidden);
  const connectedCount = groupPorts.filter(p => p.status === 'connected').length;
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(group.name);

  const { show, element } = useContextMenu();

  // Make the group a droppable target so ports can be dropped onto the group
  // header itself (not just onto individual ports inside the group).
  const { setNodeRef: setGroupDropRef, isOver: isGroupDropOver } = useDroppable({
    id: groupDroppableId(group.id),
  });

  // 批量连接/断开与工具栏的「全部打开/关闭」用同一条节流序列：并发 open/close
  // 会在后端抢同一串口句柄。
  const connectAll = () => {
    void runSequential(groupPorts.filter(p => p.status !== 'connected'), (p) => actions.toggleConnect(p.id));
  };

  const disconnectAll = () => {
    void runSequential(groupPorts.filter(p => p.status === 'connected'), (p) => actions.toggleConnect(p.id));
  };

  const handleStartRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setRenameValue(group.name);
    setIsRenaming(true);
  };

  const handleCommitRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== group.name) {
      actions.renameGroup(group.id, trimmed);
    }
    setIsRenaming(false);
  };

  const hasDisconnectable = groupPorts.some(p => p.status === 'connected');
  const hasConnectable = groupPorts.some(p => p.status !== 'connected');

  const groupMenuItems: ContextMenuEntry[] = [
    { label: t('sidebar.group.connectAll'), icon: <Play size={14} />, onClick: connectAll, disabled: !hasConnectable },
    { label: t('sidebar.group.disconnectAll'), icon: <Square size={14} />, onClick: disconnectAll, disabled: !hasDisconnectable },
    { label: t('sidebar.group.contextMenu.runTool'), icon: <Wrench size={14} />, onClick: () => actions.runToolForGroup(group) },
    { type: 'separator' },
    { label: t('sidebar.group.contextMenu.rename'), icon: <Pencil size={14} />, onClick: () => { setRenameValue(group.name); setIsRenaming(true); } },
    { type: 'separator' },
    { label: t('sidebar.group.contextMenu.delete'), icon: <Trash2 size={14} />, danger: true, onClick: () => actions.removeGroup(group.id) },
  ];

  const portIds = useMemo(() => groupPorts.map(p => p.id), [groupPorts]);

  return (
    <div
      ref={setGroupDropRef}
      className={`port-group${isGroupDropOver ? ' drop-active' : ''}`}
    >
      <div
        className="port-group-header"
        onClick={() => actions.toggleGroupExpand(group.id)}
        onContextMenu={(e) => show(e, groupMenuItems)}
      >
        <ChevronRight
          size={12}
          className="port-group-chevron"
          style={{ transform: group.isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
        />
        {isRenaming ? (
          <input
            className="input port-group-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleCommitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCommitRename();
              if (e.key === 'Escape') setIsRenaming(false);
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <span
            className="port-group-name eyebrow"
            onDoubleClick={handleStartRename}
            title={t('sidebar.group.doubleClickRename')}
          >
            {group.name}
          </span>
        )}
        <span className={`port-group-count${connectedCount > 0 ? ' has-connected' : ''}`}>
          {connectedCount}/{groupPorts.length}
        </span>
      </div>
      {element}
      {group.isExpanded && (
        <SortableContext items={portIds} strategy={verticalListSortingStrategy}>
          <div className="port-group-list">
            {groupPorts.map(port => (
              <SortablePortItem
                key={port.id}
                port={port}
                isConnected={port.status === 'connected'}
              />
            ))}
          </div>
        </SortableContext>
      )}
    </div>
  );
};

export default GroupItem;
