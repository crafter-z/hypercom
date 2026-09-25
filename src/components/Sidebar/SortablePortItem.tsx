import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import type { SerialPort } from '../../types';
import { useContextMenu, type ContextMenuEntry } from '../shared/ContextMenu';
import { useSidebarActions } from './SidebarActions';
import {
  Play, Square, Eye, EyeOff, PlugZap, Pencil, Unplug, ExternalLink, GripVertical,
  Wrench, TerminalSquare, FolderPlus, FolderInput, FolderMinus,
} from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

/**
 * 端口状态的展示文案。模块级常量：原实现每次渲染重建整个映射表。
 */
const STATUS_LABEL_KEY: Record<string, string> = {
  disconnected: 'sidebar.port.status.disconnected',
  error: 'sidebar.port.status.error',
  connected: 'sidebar.port.status.connected',
  connecting: 'sidebar.port.status.connecting',
};

interface SortablePortItemProps {
  port: SerialPort;
  isConnected: boolean;
}

/**
 * One slot in the port rack: drag handle, pulsing status dot, name
 * (+alias/badges), a quiet monospace meta line, and the connect toggle.
 * Everything else lives in the right-click menu.
 */
const SortablePortItem: React.FC<SortablePortItemProps> = ({ port, isConnected }) => {
  const { t } = useTranslation();
  const actions = useSidebarActions();
  const { show, element } = useContextMenu();
  // 分组控制菜单在渲染时构建，需要实时读 groups。
  const groups = useAppStore((s) => s.groups);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: port.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const statusKey = STATUS_LABEL_KEY[port.status];
  const label = statusKey ? t(statusKey) : port.status;

  // 串口分组控制：
  //  - 已在组里：移出分组
  //  - 未分组且有组：快捷移入已有组（逐组一项）
  //  - 未分组且无组（或嫌逐个麻烦）：新建分组并移入
  const currentGroup = port.groupId ? groups.find(g => g.id === port.groupId) : undefined;
  const groupControlItems: ContextMenuEntry[] = [];
  if (currentGroup) {
    groupControlItems.push({
      label: t('sidebar.port.contextMenu.removeFromGroup'),
      icon: <FolderMinus size={14} />,
      onClick: () => actions.movePortToGroup(port.id, undefined),
    });
  } else {
    for (const g of groups) {
      groupControlItems.push({
        label: t('sidebar.port.contextMenu.addToGroup', { name: g.name }),
        icon: <FolderInput size={14} />,
        onClick: () => actions.movePortToGroup(port.id, g.id),
      });
    }
    groupControlItems.push({
      label: t('sidebar.port.contextMenu.createGroupWithPort'),
      icon: <FolderPlus size={14} />,
      // 建组 + 入组是一件事，实现在 groupActions.ts（唯一一份）。
      onClick: () => actions.createGroupWithPort(port.id),
    });
  }

  const items: ContextMenuEntry[] = [
    {
      label: isConnected ? t('sidebar.port.contextMenu.disconnect') : t('sidebar.port.contextMenu.connect'),
      icon: isConnected ? <Unplug size={14} /> : <PlugZap size={14} />,
      onClick: () => actions.toggleConnect(port.id),
    },
    { type: 'separator' },
    { label: t('sidebar.port.contextMenu.setAlias'), icon: <Pencil size={14} />, onClick: () => actions.setAlias(port.id) },
    { label: t('sidebar.port.contextMenu.openInTab'), icon: <ExternalLink size={14} />, onClick: () => actions.openTab(port.id) },
    { type: 'separator' },
    // 外部工具：执行入口始终可见；未配置时点击跳转配置页。运行中显示终止。
    port.toolRunning
      ? { label: t('sidebar.port.contextMenu.killTool'), icon: <TerminalSquare size={14} />, onClick: () => actions.killTool(port.id), danger: true }
      : { label: t('sidebar.port.contextMenu.runTool'), icon: <Wrench size={14} />, onClick: () => actions.runTool(port.id) },
    { label: t('sidebar.port.contextMenu.configTool'), icon: <Wrench size={14} />, onClick: actions.configTool },
    { type: 'separator' },
    ...groupControlItems,
    { type: 'separator' },
    port.isHidden
      ? { label: t('sidebar.port.contextMenu.unhide'), icon: <Eye size={14} />, onClick: () => actions.showPort(port.id) }
      : { label: t('sidebar.port.contextMenu.hide'), icon: <EyeOff size={14} />, onClick: () => actions.hidePort(port.id) },
  ];

  return (
    <div ref={setNodeRef} style={style}>
      <div
        className={`port-item${isConnected ? ' connected' : ''}`}
        onDoubleClick={() => actions.openTab(port.id)}
        onContextMenu={(e) => show(e, items)}
      >
        <span className="port-item-drag" {...attributes} {...listeners}>
          <GripVertical size={12} />
        </span>
        <span className={`status-dot ${port.status}`} />
        <div className="port-item-info">
          <div className="port-item-title">
            <span className="port-item-name">{port.id}</span>
            {port.alias && <span className="port-item-alias">{port.alias}</span>}
            {port.type === 'sim' && <span className="port-item-badge sim">{t('sidebar.port.badge.sim')}</span>}
            {port.type === 'virtual' && <span className="port-item-badge">{t('sidebar.port.badge.vcp')}</span>}
            {port.toolRunning && <span className="port-item-badge tool">TOOL</span>}
          </div>
          <div className="port-item-meta">
            <span>{label}</span>
            {port.baudRate && (
              <span className="port-item-baud">
                {port.baudRate},{port.dataBits || 8}{port.parity?.[0] || 'N'}{port.stopBits === 'One' ? '1' : '2'}
              </span>
            )}
          </div>
        </div>
        <button
          className={`icon-btn port-connect-btn${isConnected ? ' connected' : ''}`}
          title={isConnected ? t('sidebar.port.connectBtn.disconnect') : t('sidebar.port.connectBtn.connect')}
          onClick={(e) => { e.stopPropagation(); actions.toggleConnect(port.id); }}
        >
          {isConnected ? <Square size={12} /> : <Play size={12} />}
        </button>
      </div>
      {element}
    </div>
  );
};

export default SortablePortItem;
