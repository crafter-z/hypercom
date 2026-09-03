import React, { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import type { SerialPort, PortGroup } from '../../types';
import { useContextMenu, type ContextMenuEntry } from '../shared/ContextMenu';
import {
  Play, Square, Eye, EyeOff, ArrowUpDown, RefreshCw,
  ChevronRight, Plus, X, Search, FlaskConical, Ellipsis,
  PlugZap, Pencil, Unplug, ExternalLink, GripVertical, Trash2,
  Wrench, TerminalSquare, FolderPlus, FolderInput, FolderMinus,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import { useSerialPorts, useSerialConnection, useSimulation, usePortToolActions, useGitBashSim } from '../../hooks';
import { useToolbarPluginButtons, usePortPluginMenuItems, dispatchPluginUiClick } from '../../hooks/usePluginUi';
import { DEV_FEATURES_ENABLED } from '../../utils/devMode';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
} from '@dnd-kit/core';
import AliasDialog from './AliasDialog';
import GuideCard from './GuideCard';
import { usePortDragEnd } from './hooks/usePortDragEnd';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

/** lucide 图标名 → 组件 映射（manifest ui.icon 白名单，评审 v2 D2）。
 *  未知名回退 Plug 图标。随 Sidebar 实际使用图标扩充。 */
const PLUGIN_ICONS: Record<string, LucideIcon> = {
  Search: Search,
  Wrench: Wrench,
  Play: Play,
  Square: Square,
  Terminal: Terminal,
  RefreshCw: RefreshCw,
  Eye: Eye,
  EyeOff: EyeOff,
  ArrowUpDown: ArrowUpDown,
  Zap: PlugZap,
  Send: PlugZap,
};

function pluginIcon(name: string | undefined, size = 13): React.ReactElement {
  const Cmp = (name && PLUGIN_ICONS[name]) || PlugZap;
  return <Cmp size={size} />;
}

/**
 * Sidebar toolbar — the rack's control strip.
 *
 * High-frequency actions live here visibly: simulation toggle (dev builds
 * only), refresh, and open/close all (promoted from the overflow menu —
 * they're the rack's bread and butter). Only low-frequency actions
 * (show hidden, sort) fold into the overflow menu. 分组/布局变更现在自动
 * 持久化（issue #2-3），原「保存布局」按钮已移除。
 */
const SidebarToolbar: React.FC<{
  showHidden: boolean;
  onToggleHidden: () => void;
  onRefresh: () => void;
  simulationMode: boolean;
  simulationAvailable: boolean;
  onToggleSimulation: () => void;
  gitBashMode: boolean;
  gitBashAvailable: boolean;
  onToggleGitBash: () => void;
  onOpenAll: () => void;
  onCloseAll: () => void;
  onSortByPort: () => void;
}> = ({ showHidden, onToggleHidden, onRefresh, simulationMode, simulationAvailable, onToggleSimulation, gitBashMode, gitBashAvailable, onToggleGitBash, onOpenAll, onCloseAll, onSortByPort }) => {
  const { t } = useTranslation();
  const { show, element } = useContextMenu();
  // issue #17：插件声明式工具栏按钮（manifest ui.buttons target=sidebar）。
  const pluginButtons = useToolbarPluginButtons();

  const overflowItems: ContextMenuEntry[] = [
    {
      label: showHidden ? t('sidebar.toolbar.hideHidden') : t('sidebar.toolbar.showHidden'),
      icon: showHidden ? <Eye size={14} /> : <EyeOff size={14} />,
      onClick: onToggleHidden,
    },
    // issue #6-4：排序改一次性动作（重排后仍可拖拽/分组），不再是持久开关
    { label: t('sidebar.toolbar.sortByPort'), icon: <ArrowUpDown size={14} />, onClick: onSortByPort },
  ];

  return (
    <div className="sidebar-toolbar">
      <span className="sidebar-toolbar-title eyebrow">{t('sidebar.toolbar.title')}</span>
      <div className="sidebar-toolbar-actions">
        {simulationAvailable && (
          <button
            className={`icon-btn${simulationMode ? ' active' : ''}`}
            title={simulationMode ? t('sidebar.toolbar.disableSimulation') : t('sidebar.toolbar.enableSimulation')}
            onClick={onToggleSimulation}
          >
            <FlaskConical size={14} />
          </button>
        )}
        {gitBashAvailable && (
          <button
            className={`icon-btn${gitBashMode ? ' active' : ''}`}
            title={gitBashMode ? t('sidebar.toolbar.disableGitBashSim') : t('sidebar.toolbar.enableGitBashSim')}
            onClick={onToggleGitBash}
          >
            <Terminal size={14} />
          </button>
        )}
        {/* issue #17：插件声明式按钮（点击 → worker ui.buttonClick） */}
        {pluginButtons.length > 0 && <span className="toolbar-sep" />}
        {pluginButtons.map((reg) => {
          const btn = reg.buttons[reg.buttonIndex];
          return (
            <button
              key={`${reg.pluginId}:${btn.id}`}
              className="icon-btn"
              title={`${reg.pluginName}: ${btn.label}`}
              onClick={() => dispatchPluginUiClick(reg, btn.id)}
            >
              {pluginIcon(btn.icon, 14)}
            </button>
          );
        })}
        <button className="icon-btn" title={t('sidebar.toolbar.refresh')} onClick={onRefresh}>
          <RefreshCw size={14} />
        </button>
        <button className="icon-btn" title={t('sidebar.toolbar.openAll')} onClick={onOpenAll}>
          <Play size={14} />
        </button>
        <button className="icon-btn" title={t('sidebar.toolbar.closeAll')} onClick={onCloseAll}>
          <Square size={14} />
        </button>
        <span className="toolbar-sep" />
        <button
          className="icon-btn"
          title={t('sidebar.toolbar.more')}
          aria-label={t('sidebar.toolbar.more')}
          onClick={(e) => show(e, overflowItems)}
        >
          <Ellipsis size={14} />
        </button>
      </div>
      {element}
    </div>
  );
};

const SearchBox: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
  const { t } = useTranslation();
  return (
    <div className="sidebar-search">
      <Search size={13} className="sidebar-search-icon" />
      <input
        className="toolbar-input sidebar-search-input"
        placeholder={t('sidebar.search.placeholder')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button className="sidebar-search-clear" onClick={() => onChange('')}>
          <X size={12} />
        </button>
      )}
    </div>
  );
};

interface SortablePortItemProps {
  port: SerialPort;
  isConnected: boolean;
  onOpenTab: (portId: string) => void;
  onToggleConnect: (portId: string) => void;
  onSetAlias: (portId: string) => void;
  onHidePort: (portId: string) => void;
  onShowPort: (portId: string) => void;
  onRunTool: (portId: string) => void;
  onKillTool: (portId: string) => void;
  onConfigTool: () => void;
}

/**
 * One slot in the port rack: drag handle, pulsing status dot,
 * name (+alias/badges), a quiet monospace meta line, and the
 * connect toggle. Everything else lives in the right-click menu.
 */
const SortablePortItem: React.FC<SortablePortItemProps> = ({
  port,
  isConnected,
  onOpenTab,
  onToggleConnect,
  onSetAlias,
  onHidePort,
  onShowPort,
  onRunTool,
  onKillTool,
  onConfigTool,
}) => {
  const { t } = useTranslation();
  const { show, element } = useContextMenu();
  // issue #17：插件声明式端口菜单项（manifest ui.menuItems target=port-context）。
  const pluginMenuItems = usePortPluginMenuItems();
  // issue #6-5：分组控制需要实时读 groups 与 store actions（菜单项在渲染时构建）
  const groups = useAppStore((s) => s.groups);
  const movePortToGroup = useAppStore((s) => s.movePortToGroup);
  const addGroup = useAppStore((s) => s.addGroup);
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

  const statusLabel: Record<string, string> = {
    disconnected: t('sidebar.port.status.disconnected'),
    error: t('sidebar.port.status.error'),
    connected: t('sidebar.port.status.connected'),
    connecting: t('sidebar.port.status.connecting'),
  };
  const label = statusLabel[port.status] || port.status;

  // issue #6-5：串口分组控制——
  //  - 已在组里：移出分组
  //  - 未分组且有组：快捷移入已有组（逐组一项）
  //  - 未分组且无组（或嫌逐个麻烦）：新建分组并移入
  const currentGroup = port.groupId ? groups.find(g => g.id === port.groupId) : undefined;
  const groupControlItems: ContextMenuEntry[] = [];
  if (currentGroup) {
    groupControlItems.push({
      label: t('sidebar.port.contextMenu.removeFromGroup'),
      icon: <FolderMinus size={14} />,
      onClick: () => movePortToGroup(port.id, undefined),
    });
  } else {
    for (const g of groups) {
      groupControlItems.push({
        label: t('sidebar.port.contextMenu.addToGroup', { name: g.name }),
        icon: <FolderInput size={14} />,
        onClick: () => movePortToGroup(port.id, g.id),
      });
    }
    groupControlItems.push({
      label: t('sidebar.port.contextMenu.createGroupWithPort'),
      icon: <FolderPlus size={14} />,
      onClick: () => {
        const id = `group-${Date.now()}`;
        // 先建组再加入端口：movePortToGroup 依赖 group 已存在于 store
        addGroup({
          id,
          name: t('sidebar.addGroup.defaultName'),
          isExpanded: true,
          portIds: [port.id],
          order: groups.length,
        });
        movePortToGroup(port.id, id);
      },
    });
  }

  const items: ContextMenuEntry[] = [
    { label: isConnected ? t('sidebar.port.contextMenu.disconnect') : t('sidebar.port.contextMenu.connect'), icon: isConnected ? <Unplug size={14} /> : <PlugZap size={14} />, onClick: () => onToggleConnect(port.id) },
    { type: 'separator' },
    { label: t('sidebar.port.contextMenu.setAlias'), icon: <Pencil size={14} />, onClick: () => onSetAlias(port.id) },
    { label: t('sidebar.port.contextMenu.openInTab'), icon: <ExternalLink size={14} />, onClick: () => onOpenTab(port.id) },
    { type: 'separator' },
    // 外部工具：执行入口始终可见；未配置时点击跳转配置页。运行中显示终止。
    port.toolRunning
      ? { label: t('sidebar.port.contextMenu.killTool'), icon: <TerminalSquare size={14} />, onClick: () => onKillTool(port.id), danger: true }
      : { label: t('sidebar.port.contextMenu.runTool'), icon: <Wrench size={14} />, onClick: () => onRunTool(port.id) },
    { label: t('sidebar.port.contextMenu.configTool'), icon: <Wrench size={14} />, onClick: onConfigTool },
    { type: 'separator' },
    ...groupControlItems,
    // issue #17：插件声明式端口菜单项（点击 → worker ui.buttonClick + portId 上下文）
    ...(pluginMenuItems.length > 0 ? [{ type: 'separator' } as ContextMenuEntry] : []),
    ...pluginMenuItems.map((reg) => {
      const item = reg.menuItems[reg.itemIndex];
      return {
        label: `${reg.pluginName}: ${item.label}`,
        icon: pluginIcon(undefined),
        onClick: () => dispatchPluginUiClick(reg, item.id, { portId: port.id }),
      } as ContextMenuEntry;
    }),
    ...(pluginMenuItems.length > 0 ? [{ type: 'separator' } as ContextMenuEntry] : []),
    port.isHidden
      ? { label: t('sidebar.port.contextMenu.unhide'), icon: <Eye size={14} />, onClick: () => onShowPort(port.id) }
      : { label: t('sidebar.port.contextMenu.hide'), icon: <EyeOff size={14} />, onClick: () => onHidePort(port.id) },
  ];

  return (
    <div ref={setNodeRef} style={style}>
      <div
        className={`port-item${isConnected ? ' connected' : ''}`}
        onDoubleClick={() => onOpenTab(port.id)}
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
                {port.baudRate},{port.dataBits || 8}{port.parity?.[0] || 'N'}{port.stopBits === 'One' ? '1' : port.stopBits === 'Two' ? '2' : '1.5'}
              </span>
            )}
          </div>
        </div>
        <button
          className={`icon-btn port-connect-btn${isConnected ? ' connected' : ''}`}
          title={isConnected ? t('sidebar.port.connectBtn.disconnect') : t('sidebar.port.connectBtn.connect')}
          onClick={(e) => { e.stopPropagation(); onToggleConnect(port.id); }}
        >
          {isConnected ? <Square size={12} /> : <Play size={12} />}
        </button>
      </div>
      {element}
    </div>
  );
};

interface GroupItemProps {
  group: PortGroup;
  ports: SerialPort[];
  onOpenTab: (portId: string) => void;
  onToggleConnect: (portId: string) => void;
  onToggleExpand: (groupId: string) => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onRemoveGroup: (groupId: string) => void;
  onSetAlias: (portId: string) => void;
  onHidePort: (portId: string) => void;
  onShowPort: (portId: string) => void;
  onRunTool: (portId: string) => void;
  onKillTool: (portId: string) => void;
  onConfigTool: () => void;
  onRunToolForGroup: (group: PortGroup) => void;
}

/**
 * Group header — chevron + name + connected-count, nothing else.
 * Connect-all / disconnect-all / rename / delete all live in the
 * right-click context menu. The header stays a droppable target for
 * cross-group port drops.
 */
const GroupItem: React.FC<GroupItemProps> = ({
  group,
  ports,
  onOpenTab,
  onToggleConnect,
  onToggleExpand,
  onRenameGroup,
  onRemoveGroup,
  onSetAlias,
  onHidePort,
  onShowPort,
  onRunTool,
  onKillTool,
  onConfigTool,
  onRunToolForGroup,
}) => {
  const { t } = useTranslation();
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
    id: `droppable-${group.id}`,
  });

  const connectAll = () => {
    groupPorts.forEach(p => { if (p.status !== 'connected') onToggleConnect(p.id); });
  };

  const disconnectAll = () => {
    groupPorts.forEach(p => { if (p.status === 'connected') onToggleConnect(p.id); });
  };

  const handleStartRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setRenameValue(group.name);
    setIsRenaming(true);
  };

  const handleCommitRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== group.name) {
      onRenameGroup(group.id, trimmed);
    }
    setIsRenaming(false);
  };

  const hasDisconnectable = groupPorts.some(p => p.status === 'connected');
  const hasConnectable = groupPorts.some(p => p.status !== 'connected');

  const groupMenuItems: ContextMenuEntry[] = [
    { label: t('sidebar.group.connectAll'), icon: <Play size={14} />, onClick: connectAll, disabled: !hasConnectable },
    { label: t('sidebar.group.disconnectAll'), icon: <Square size={14} />, onClick: disconnectAll, disabled: !hasDisconnectable },
    { label: t('sidebar.group.contextMenu.runTool'), icon: <Wrench size={14} />, onClick: () => onRunToolForGroup(group) },
    { type: 'separator' },
    { label: t('sidebar.group.contextMenu.rename'), icon: <Pencil size={14} />, onClick: () => { setRenameValue(group.name); setIsRenaming(true); } },
    { type: 'separator' },
    { label: t('sidebar.group.contextMenu.delete'), icon: <Trash2 size={14} />, danger: true, onClick: () => onRemoveGroup(group.id) },
  ];

  const portIds = useMemo(() => groupPorts.map(p => p.id), [groupPorts]);

  return (
    <div
      ref={setGroupDropRef}
      className={`port-group${isGroupDropOver ? ' drop-active' : ''}`}
    >
      <div
        className="port-group-header"
        onClick={() => onToggleExpand(group.id)}
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
                onOpenTab={onOpenTab}
                onToggleConnect={onToggleConnect}
                onSetAlias={onSetAlias}
                onHidePort={onHidePort}
                onShowPort={onShowPort}
                onRunTool={onRunTool}
                onKillTool={onKillTool}
                onConfigTool={onConfigTool}
              />
            ))}
          </div>
        </SortableContext>
      )}
    </div>
  );
};

const Sidebar: React.FC = () => {
  const { t } = useTranslation();
  const ports = useAppStore((s) => s.ports);
  const groups = useAppStore((s) => s.groups);
  const openTab = useAppStore((s) => s.openTab);
  const updatePort = useAppStore((s) => s.updatePort);
  const updateGroup = useAppStore((s) => s.updateGroup);
  const addGroup = useAppStore((s) => s.addGroup);
  const removeGroup = useAppStore((s) => s.removeGroup);

  const { refreshPorts } = useSerialPorts(3000);
  const { toggleConnection } = useSerialConnection();
  const { simulationMode, toggleSimulation } = useSimulation();
  const { gitBashMode, toggleGitBashSim } = useGitBashSim();
  const { runTool, killTool, configTool, runToolForGroup, groupToolDialog } = usePortToolActions();

  const [showHidden, setShowHidden] = useState(false);
  const [search, setSearch] = useState('');
  const [aliasDialog, setAliasDialog] = useState<{ portId: string; currentAlias: string } | null>(null);

  const handleOpenTab = useCallback((portId: string) => {
    if (useAppStore.getState().activeTabId === portId) return;
    // Defer openTab to next microtask to decouple from @dnd-kit event processing.
    queueMicrotask(() => openTab(portId));
  }, [openTab]);

  const handleToggleConnect = useCallback((portId: string) => {
    toggleConnection(portId);
  }, [toggleConnection]);

  const handleToggleExpand = useCallback((groupId: string) => {
    const group = groups.find(g => g.id === groupId);
    if (group) updateGroup(groupId, { isExpanded: !group.isExpanded });
  }, [groups, updateGroup]);

  const handleSetAlias = useCallback((portId: string) => {
    const port = ports.find(p => p.id === portId);
    if (port) setAliasDialog({ portId, currentAlias: port.alias || '' });
  }, [ports]);

  const handleHidePort = useCallback((portId: string) => { updatePort(portId, { isHidden: true }); }, [updatePort]);
  const handleShowPort = useCallback((portId: string) => { updatePort(portId, { isHidden: false }); }, [updatePort]);

  const handleSaveAlias = useCallback((alias: string) => {
    if (aliasDialog) {
      updatePort(aliasDialog.portId, { alias: alias || undefined });
      setAliasDialog(null);
    }
  }, [aliasDialog, updatePort]);

  const handleAddGroup = useCallback(() => {
    const id = `group-${Date.now()}`;
    addGroup({ id, name: t('sidebar.addGroup.defaultName'), isExpanded: true, portIds: [], order: groups.length });
  }, [addGroup, groups.length, t]);

  const handleRenameGroup = useCallback((groupId: string, name: string) => {
    updateGroup(groupId, { name });
  }, [updateGroup]);

  const handleRemoveGroup = useCallback((groupId: string) => {
    removeGroup(groupId);
  }, [removeGroup]);

  const filteredPorts = useMemo(() => {
    if (!search) return ports;
    const searchLower = search.toLowerCase();
    return ports.filter(p => p.id.toLowerCase().includes(searchLower) || (p.alias?.toLowerCase().includes(searchLower)));
  }, [ports, search]);

  // issue #6-4：排序是一次性动作（sortPortsByNumber 直接重排 store 的 ports 数组），
  // 不再是持久派生模式——列表始终按 store 顺序渲染，拖拽/分组操作始终可用，
  // 3s 轮询的 mergePorts 按 existing 顺序合并，不会冲掉手动/排序后的顺序。
  const displayedPorts = filteredPorts;

  // Hidden ports never appear in their normal location (group / ungrouped);
  // they surface ONLY in the dedicated hidden section when toggled visible.
  // (Previously they double-rendered — once here and once in the hidden
  // section — producing duplicate @dnd-kit ids and broken dragging.)
  const ungroupedPorts = displayedPorts.filter(p => !p.groupId && !p.isHidden);
  const ungroupedIds = useMemo(() => ungroupedPorts.map(p => p.id), [ungroupedPorts]);
  const hiddenPorts = useMemo(() => {
    return ports.filter(p => p.isHidden);
  }, [ports]);
  const hiddenIds = useMemo(() => hiddenPorts.map(p => p.id), [hiddenPorts]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  // issue #6-4：点击「按端口号排序」= 一次性重排 store 顺序（含组内顺序），
  // 排序后拖拽/分组照常可用；组内顺序随 save_port_groups 持久化。
  const handleSortByPort = useCallback(() => {
    useAppStore.getState().sortPortsByNumber();
  }, []);

  const handleDragEnd = usePortDragEnd({ groups, ports });

  return (
    <div className="sidebar">
      <SidebarToolbar
        showHidden={showHidden}
        onToggleHidden={() => setShowHidden(!showHidden)}
        onRefresh={refreshPorts}
        simulationMode={simulationMode}
        simulationAvailable={DEV_FEATURES_ENABLED}
        onToggleSimulation={toggleSimulation}
        gitBashMode={gitBashMode}
        gitBashAvailable={DEV_FEATURES_ENABLED}
        onToggleGitBash={toggleGitBashSim}
        onOpenAll={async () => {
          for (const p of ports) {
            if (p.status !== 'connected') {
              toggleConnection(p.id);
              await new Promise(r => setTimeout(r, 100));
            }
          }
        }}
        onCloseAll={async () => {
          for (const p of ports) {
            if (p.status === 'connected') {
              toggleConnection(p.id);
              await new Promise(r => setTimeout(r, 100));
            }
          }
        }}
        onSortByPort={handleSortByPort}
      />
      <SearchBox value={search} onChange={setSearch} />

      <div className="sidebar-list">
        {/* 空端口引导卡片：任意端口（真实/SIM）出现后条件不成立自动消失。
            位于 DndContext 之外，不影响端口拖拽排序。 */}
        {ports.length === 0 && !simulationMode && (
          <GuideCard onEnableSimulation={toggleSimulation} simulationAvailable={DEV_FEATURES_ENABLED} />
        )}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          {groups.map(group => {
            const groupPorts = displayedPorts.filter(p => group.portIds.includes(p.id) && !p.isHidden);
            if (groupPorts.length === 0 && search) return null;
            return (
              <GroupItem
                key={group.id}
                group={group}
                ports={displayedPorts}
                onOpenTab={handleOpenTab}
                onToggleConnect={handleToggleConnect}
                onToggleExpand={handleToggleExpand}
                onRenameGroup={handleRenameGroup}
                onRemoveGroup={handleRemoveGroup}
                onSetAlias={handleSetAlias}
                onHidePort={handleHidePort}
                onShowPort={handleShowPort}
                onRunTool={runTool}
                onKillTool={killTool}
                onConfigTool={configTool}
                onRunToolForGroup={runToolForGroup}
              />
            );
          })}

          {ungroupedPorts.length > 0 && (
            <div className="sidebar-section">
              <div className="sidebar-section-header eyebrow">{t('sidebar.section.ungrouped')}</div>
              <SortableContext items={ungroupedIds} strategy={verticalListSortingStrategy}>
                {ungroupedPorts.map(port => (
                  <SortablePortItem
                    key={port.id}
                    port={port}
                    isConnected={port.status === 'connected'}
                        onOpenTab={handleOpenTab}
                    onToggleConnect={handleToggleConnect}
                    onSetAlias={handleSetAlias}
                    onHidePort={handleHidePort}
                    onShowPort={handleShowPort}
                    onRunTool={runTool}
                    onKillTool={killTool}
                    onConfigTool={configTool}
                  />
                ))}
              </SortableContext>
            </div>
          )}

          {showHidden && hiddenPorts.length > 0 && (
            <div className="sidebar-section">
              <div className="sidebar-section-header eyebrow">{t('sidebar.section.hidden')}</div>
              <SortableContext items={hiddenIds} strategy={verticalListSortingStrategy}>
                {hiddenPorts.map(port => (
                  <SortablePortItem
                    key={port.id}
                    port={port}
                    isConnected={port.status === 'connected'}
                        onOpenTab={handleOpenTab}
                    onToggleConnect={handleToggleConnect}
                    onSetAlias={handleSetAlias}
                    onHidePort={handleHidePort}
                    onShowPort={handleShowPort}
                    onRunTool={runTool}
                    onKillTool={killTool}
                    onConfigTool={configTool}
                  />
                ))}
              </SortableContext>
            </div>
          )}
        </DndContext>

        <div className="sidebar-add-group">
          <button className="btn sidebar-add-group-btn" onClick={handleAddGroup}>
            <Plus size={14} />
            {t('sidebar.addGroup.button')}
          </button>
        </div>
      </div>

      {aliasDialog && (
        <AliasDialog
          portId={aliasDialog.portId}
          currentAlias={aliasDialog.currentAlias}
          onSave={handleSaveAlias}
          onCancel={() => setAliasDialog(null)}
        />
      )}
      {groupToolDialog}
    </div>
  );
};

export default Sidebar;
