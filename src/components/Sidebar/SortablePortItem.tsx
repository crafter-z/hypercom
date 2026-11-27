import React from 'react';
import { useTranslation } from 'react-i18next';
import { findSerialTabByPortId, useAppStore } from '../../stores/useAppStore';
import type { SerialPort } from '../../types';
import { useContextMenu, type ContextMenuEntry } from '../shared/ContextMenu';
import { useSidebarActions } from './SidebarActions';
import { usePortPluginMenuItems, dispatchPluginUiClick } from '../../hooks/usePluginUi';
import { pluginIcon } from './pluginIcon';
import { getPortCapabilities } from '../../utils/portCapabilities';
import {
  Play, Square, Eye, EyeOff, PlugZap, Pencil, Unplug, ExternalLink, GripVertical,
  Wrench, TerminalSquare, FolderPlus, FolderInput, FolderMinus, Loader2, RotateCcw,
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
  /** Active selection is independent from the port's connection state. */
  isActive: boolean;
  isConnected: boolean;
}

interface PortItemRowProps extends SortablePortItemProps {
  sortable?: boolean;
  wrapperRef?: (node: HTMLElement | null) => void;
  wrapperStyle?: React.CSSProperties;
  dragAttributes?: React.HTMLAttributes<HTMLElement>;
  dragListeners?: Record<string, unknown>;
}

/**
 * 端口 USB 元数据（厂商 · 产品）的悬停提示。
 * 去空、去重；两个字段都没有时返回 undefined（不渲染空 title 属性）。
 */
function portMetadataTitle(port: SerialPort): string | undefined {
  const parts = [port.manufacturer, port.product]
    .map((value) => value?.trim())
    .filter((value): value is string => !!value);
  const unique = [...new Set(parts)];
  return unique.length > 0 ? unique.join(' · ') : undefined;
}

function loanTooltip(port: SerialPort): string | undefined {
  if (!port.loan) return undefined;
  return port.loan.reason
    ? `${port.loan.holder} · ${port.loan.reason}`
    : port.loan.holder;
}

/**
 * Shared row presentation used by both draggable local ports (`SortablePortItem`)
 * and remote ports (`RemoteHostsSection`).
 */
export const PortItemRow: React.FC<PortItemRowProps> = ({
  port,
  isActive,
  isConnected,
  sortable = false,
  wrapperRef,
  wrapperStyle,
  dragAttributes,
  dragListeners,
}) => {
  const { t } = useTranslation();
  const actions = useSidebarActions();
  const { show, showAt, element } = useContextMenu();
  const pluginMenuItems = usePortPluginMenuItems();
  // 分组控制菜单在渲染时构建，需要实时读 groups。
  const groups = useAppStore((s) => s.groups);
  const caps = getPortCapabilities(port);

  const statusKey = STATUS_LABEL_KEY[port.status];
  const label = statusKey ? t(statusKey) : port.status;
  const metadataTitle = loanTooltip(port) ?? portMetadataTitle(port);
  const isConnecting = port.status === 'connecting';
  const displayName = caps.isRemote ? (port.remotePortId ?? port.name) : port.id;
  const productLabel = !port.alias ? port.product?.trim() : undefined;
  const connectDisabled = isConnecting || caps.isLoaned || (caps.isRemote && !caps.canControl);
  const connectBtnLabel = caps.isLoaned
    ? t('sidebar.port.loanedConnectDisabled')
    : caps.isRemote && !caps.canControl
      ? t('sidebar.port.remoteControlRequired')
      : isConnecting
        ? t('sidebar.port.status.connecting')
        : isConnected
          ? t('sidebar.port.connectBtn.disconnect')
          : t('sidebar.port.connectBtn.connect');

  const handleRowClick = () => {
    const state = useAppStore.getState();
    const existing = findSerialTabByPortId(state, port.id);
    if (existing && state.activeTabId !== existing.id) {
      state.setActiveTab(existing.id);
    }
  };

  // 串口分组控制（仅本地端口）：
  const currentGroup = !caps.isRemote && port.groupId ? groups.find(g => g.id === port.groupId) : undefined;
  const groupControlItems: ContextMenuEntry[] = [];
  if (!caps.isRemote) {
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
  }

  const items: ContextMenuEntry[] = [
    {
      label: isConnected ? t('sidebar.port.contextMenu.disconnect') : t('sidebar.port.contextMenu.connect'),
      icon: isConnected ? <Unplug size={14} /> : <PlugZap size={14} />,
      disabled: connectDisabled,
      onClick: () => actions.toggleConnect(port.id),
    },
    ...(port.loan && (!caps.isRemote || caps.canLoan)
      ? [{
          label: t('sidebar.port.contextMenu.reclaimLoan'),
          icon: <RotateCcw size={14} />,
          danger: true,
          onClick: () => { void actions.reclaimLoan(port.id); },
        } as ContextMenuEntry]
      : []),
    { type: 'separator' },
    { label: t('sidebar.port.contextMenu.setAlias'), icon: <Pencil size={14} />, onClick: () => actions.setAlias(port.id) },
    { label: t('sidebar.port.contextMenu.openInTab'), icon: <ExternalLink size={14} />, onClick: () => actions.openTab(port.id) },
    ...(!caps.isRemote
      ? [
          { type: 'separator' } as ContextMenuEntry,
          port.toolRunning
            ? { label: t('sidebar.port.contextMenu.killTool'), icon: <TerminalSquare size={14} />, onClick: () => actions.killTool(port.id), danger: true }
            : { label: t('sidebar.port.contextMenu.runTool'), icon: <Wrench size={14} />, onClick: () => actions.runTool(port.id), disabled: port.pluginToolRunning || !!port.loan },
          { label: t('sidebar.port.contextMenu.configTool'), icon: <Wrench size={14} />, onClick: actions.configTool },
          { type: 'separator' } as ContextMenuEntry,
          ...groupControlItems,
          ...(pluginMenuItems.length > 0 ? [{ type: 'separator' } as ContextMenuEntry] : []),
          ...pluginMenuItems.map((reg): ContextMenuEntry => {
            const item = reg.menuItems[reg.itemIndex];
            return {
              label: `${reg.pluginName}: ${item.label}`,
              icon: pluginIcon(undefined),
              onClick: () => dispatchPluginUiClick(reg, item.id, { portId: port.id }, 'port-context'),
            };
          }),
          { type: 'separator' } as ContextMenuEntry,
          port.isHidden
            ? { label: t('sidebar.port.contextMenu.unhide'), icon: <Eye size={14} />, onClick: () => actions.showPort(port.id) }
            : { label: t('sidebar.port.contextMenu.hide'), icon: <EyeOff size={14} />, onClick: () => actions.hidePort(port.id) },
        ]
      : []),
  ];

  const roleBadgeText = caps.isRemote && port.remoteRole
    ? t(`collaboration.role.${port.remoteRole}`)
    : null;

  return (
    <div ref={wrapperRef} style={wrapperStyle}>
      <div
        className={`port-item${isActive ? ' active' : ''}${isConnected ? ' connected' : ''}${caps.isRemote ? ' remote' : ''}`}
        tabIndex={0}
        aria-current={isActive ? 'true' : undefined}
        aria-label={`${port.alias || displayName} (${label})`}
        onClick={handleRowClick}
        onDoubleClick={() => actions.openTab(port.id)}
        onContextMenu={(e) => show(e, items)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            actions.openTab(port.id);
          } else if (e.key === ' ') {
            e.preventDefault();
            if (!connectDisabled) void actions.toggleConnect(port.id);
          } else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            showAt(rect.left, rect.bottom, items, e.currentTarget, port.alias || displayName);
          }
        }}
      >
        {sortable ? (
          <span className="port-item-drag" {...dragAttributes} {...dragListeners}>
            <GripVertical size={12} />
          </span>
        ) : (
          <span className="port-item-remote-indent" aria-hidden="true" />
        )}
        <span className={`status-dot ${port.status}`} />
        <div className="port-item-info" title={metadataTitle}>
          <div className="port-item-title">
            <span className="port-item-name">{displayName}</span>
            {port.alias && <span className="port-item-alias">{port.alias}</span>}
            {productLabel && <span className="port-item-product">{productLabel}</span>}
            {port.type === 'sim' && <span className="port-item-badge sim">{t('sidebar.port.badge.sim')}</span>}
            {port.type === 'virtual' && <span className="port-item-badge">{t('sidebar.port.badge.vcp')}</span>}
            {roleBadgeText && <span className={`port-item-badge remote-role role-${port.remoteRole}`}>{roleBadgeText}</span>}
            {port.loan ? (
              <span className="port-item-badge loaned" title={loanTooltip(port)}>
                {t('sidebar.port.badge.loaned')}
              </span>
            ) : (
              (port.toolRunning || port.pluginToolRunning) && <span className="port-item-badge tool">TOOL</span>
            )}
          </div>
          <div className="port-item-meta">
            <span>{port.loan ? `${t('sidebar.port.badge.loaned')} · ${port.loan.holder}` : label}</span>
            {port.baudRate && (
              <span className="port-item-baud">
                {port.baudRate},{port.dataBits || 8}{port.parity?.[0] || 'N'}{port.stopBits === 'One' ? '1' : '2'}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          className={`icon-btn port-connect-btn${isConnected ? ' connected' : ''}`}
          title={connectBtnLabel}
          aria-label={connectBtnLabel}
          disabled={connectDisabled}
          onClick={(e) => { e.stopPropagation(); void actions.toggleConnect(port.id); }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {isConnecting
            ? <Loader2 size={12} className="spin-icon" />
            : isConnected ? <Square size={12} /> : <Play size={12} />}
        </button>
      </div>
      {element}
    </div>
  );
};

/**
 * One slot in the port rack: drag handle, pulsing status dot, name
 * (+alias/badges), a quiet monospace meta line, and the connect toggle.
 * Everything else lives in the right-click menu.
 */
const SortablePortItem: React.FC<SortablePortItemProps> = ({ port, isActive, isConnected }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: port.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <PortItemRow
      port={port}
      isActive={isActive}
      isConnected={isConnected}
      sortable
      wrapperRef={setNodeRef}
      wrapperStyle={style}
      dragAttributes={attributes}
      dragListeners={listeners}
    />
  );
};

export default SortablePortItem;
