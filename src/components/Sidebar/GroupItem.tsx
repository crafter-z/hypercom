import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PortGroup, SerialPort } from '../../types';
import { getActivePortId, useAppStore } from '../../stores/useAppStore';
import { useContextMenu, type ContextMenuEntry } from '../shared/ContextMenu';
import { useSidebarActions } from './SidebarActions';
import { groupDroppableId } from './hooks/usePortDragEnd';
import ConfirmDialog from '../shared/ConfirmDialog';
import SortablePortItem from './SortablePortItem';
import { Play, Square, Pencil, Trash2, Wrench, ChevronRight, Ellipsis } from 'lucide-react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { runSequential } from '../../utils/sequential';

interface GroupItemProps {
  group: PortGroup;
  /** 已按搜索/隐藏过滤的端口列表（成员判断在组件内做）。 */
  ports: SerialPort[];
  /** Auto-enter inline rename (e.g. immediately after creating a new group). */
  autoRename?: boolean;
  onRenameEnd?: () => void;
}

/**
 * Group header — chevron + name + connected-count + subtle hover/focus overflow
 * menu trigger. Connect-all / disconnect-all / rename / delete live in the
 * context menu. The header stays a droppable target for cross-group port drops.
 */
const GroupItem: React.FC<GroupItemProps> = ({ group, ports, autoRename, onRenameEnd }) => {
  const { t } = useTranslation();
  const actions = useSidebarActions();
  const activePortId = useAppStore((s) => getActivePortId(s));
  const byId = new Map(ports.map(p => [p.id, p] as const));
  const groupPorts = group.portIds
    .map(id => byId.get(id))
    .filter((p): p is NonNullable<typeof p> => p !== undefined && !p.isHidden);
  const connectedCount = groupPorts.filter(p => p.status === 'connected').length;
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(group.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const nameClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { show, showAt, element } = useContextMenu();

  // Auto-enter inline rename when a new group is created.
  useEffect(() => {
    if (!autoRename) return;
    setRenameValue(group.name);
    setIsRenaming(true);
  }, [autoRename, group.name]);

  useEffect(() => {
    if (isRenaming) {
      renameInputRef.current?.select();
    }
  }, [isRenaming]);

  useEffect(() => () => {
    if (nameClickTimerRef.current !== null) clearTimeout(nameClickTimerRef.current);
  }, []);

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

  const handleNameClick = (e: React.MouseEvent) => {
    // Delay single-click toggle on the name so double-click rename doesn't
    // fire toggleGroupExpand twice and jitter the list.
    e.stopPropagation();
    if (e.detail >= 2) {
      if (nameClickTimerRef.current !== null) {
        clearTimeout(nameClickTimerRef.current);
        nameClickTimerRef.current = null;
      }
      return;
    }
    if (nameClickTimerRef.current !== null) clearTimeout(nameClickTimerRef.current);
    nameClickTimerRef.current = setTimeout(() => {
      nameClickTimerRef.current = null;
      actions.toggleGroupExpand(group.id);
    }, 180);
  };

  const handleStartRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (nameClickTimerRef.current !== null) {
      clearTimeout(nameClickTimerRef.current);
      nameClickTimerRef.current = null;
    }
    setRenameValue(group.name);
    setIsRenaming(true);
  };

  const handleCommitRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== group.name) {
      actions.renameGroup(group.id, trimmed);
    }
    setIsRenaming(false);
    onRenameEnd?.();
  };

  const handleCancelRename = () => {
    setIsRenaming(false);
    onRenameEnd?.();
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
    { label: t('sidebar.group.contextMenu.delete'), icon: <Trash2 size={14} />, danger: true, onClick: () => setConfirmDelete(true) },
  ];

  const portIds = useMemo(() => groupPorts.map(p => p.id), [groupPorts]);

  return (
    <div
      ref={setGroupDropRef}
      className={`port-group${isGroupDropOver ? ' drop-active' : ''}`}
    >
      <div
        className="port-group-header"
        onContextMenu={(e) => show(e, groupMenuItems)}
      >
        <div
          className="port-group-header-main"
          role="button"
          tabIndex={0}
          aria-expanded={group.isExpanded}
          aria-label={group.name}
          onClick={() => {
            if (!isRenaming) actions.toggleGroupExpand(group.id);
          }}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              actions.toggleGroupExpand(group.id);
            } else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              showAt(rect.left, rect.bottom, groupMenuItems, e.currentTarget, group.name);
            }
          }}
        >
          <ChevronRight
            size={12}
            className="port-group-chevron"
            style={{ transform: group.isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
          />
          {isRenaming ? (
            <input
              ref={renameInputRef}
              className="input port-group-rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={handleCommitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCommitRename();
                if (e.key === 'Escape') handleCancelRename();
              }}
              onClick={(e) => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <span
              className="port-group-name eyebrow"
              onClick={handleNameClick}
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
        <button
          type="button"
          className="icon-btn port-group-menu-btn"
          title={t('sidebar.group.moreActions')}
          aria-label={t('sidebar.group.moreActions')}
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            showAt(rect.left, rect.bottom, groupMenuItems, e.currentTarget, group.name);
          }}
        >
          <Ellipsis size={13} />
        </button>
      </div>
      {element}
      <ConfirmDialog
        open={confirmDelete}
        title={t('sidebar.group.deleteTitle')}
        message={t('sidebar.group.deleteMessage', { name: group.name })}
        confirmLabel={t('confirmDialog.confirm')}
        cancelLabel={t('confirmDialog.cancel')}
        danger
        onConfirm={() => { setConfirmDelete(false); actions.removeGroup(group.id); }}
        onCancel={() => setConfirmDelete(false)}
      />
      {group.isExpanded && (
        <SortableContext items={portIds} strategy={verticalListSortingStrategy}>
          <div className="port-group-list">
            {groupPorts.map(port => (
              <SortablePortItem
                key={port.id}
                port={port}
                isActive={activePortId === port.id}
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
