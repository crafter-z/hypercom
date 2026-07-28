import React, { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import type { SerialPort, PortGroup } from '../../types';
import { useContextMenu, type ContextMenuEntry } from '../shared/ContextMenu';
import {
  Play, Square, Eye, EyeOff, ArrowUpDown, Save, RefreshCw,
  ChevronRight, Plus, X, Search, FlaskConical, Ellipsis,
  PlugZap, Pencil, Unplug, ExternalLink, GripVertical, Trash2,
  Wrench, TerminalSquare,
} from 'lucide-react';
import { useSerialPorts, useSerialConnection, useSimulation, useConfigPersistence } from '../../hooks';
import { toolService } from '../../services/tauri';
import { notifyError } from '../../stores/useToastStore';
import { useRuleStore } from '../../stores/useRuleStore';
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

/**
 * Sidebar toolbar — the rack's control strip.
 *
 * High-frequency actions live here visibly: simulation toggle,
 * refresh, and open/close all (promoted from the overflow menu —
 * they're the rack's bread and butter). Only low-frequency actions
 * (show hidden, sort, save layout) fold into the overflow menu.
 */
const SidebarToolbar: React.FC<{
  showHidden: boolean;
  onToggleHidden: () => void;
  onRefresh: () => void;
  simulationMode: boolean;
  onToggleSimulation: () => void;
  onOpenAll: () => void;
  onCloseAll: () => void;
  onSortByPort: () => void;
  onSaveLayout: () => void;
}> = ({ showHidden, onToggleHidden, onRefresh, simulationMode, onToggleSimulation, onOpenAll, onCloseAll, onSortByPort, onSaveLayout }) => {
  const { t } = useTranslation();
  const { show, element } = useContextMenu();

  const overflowItems: ContextMenuEntry[] = [
    {
      label: showHidden ? t('sidebar.toolbar.hideHidden') : t('sidebar.toolbar.showHidden'),
      icon: showHidden ? <Eye size={14} /> : <EyeOff size={14} />,
      onClick: onToggleHidden,
    },
    { label: t('sidebar.toolbar.sortByPort'), icon: <ArrowUpDown size={14} />, onClick: onSortByPort },
    { type: 'separator' },
    { label: t('sidebar.toolbar.saveLayout'), icon: <Save size={14} />, onClick: onSaveLayout },
  ];

  return (
    <div className="sidebar-toolbar">
      <span className="sidebar-toolbar-title eyebrow">{t('sidebar.toolbar.title')}</span>
      <div className="sidebar-toolbar-actions">
        <button
          className={`icon-btn${simulationMode ? ' active' : ''}`}
          title={simulationMode ? t('sidebar.toolbar.disableSimulation') : t('sidebar.toolbar.enableSimulation')}
          onClick={onToggleSimulation}
        >
          <FlaskConical size={14} />
        </button>
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
  const { saveConfig } = useConfigPersistence();

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

  const handleRunTool = useCallback(async (portId: string) => {
    const config = useRuleStore.getState().findToolConfigByPort(portId);
    if (!config) {
      // 未配置 → 跳转配置页
      useAppStore.getState().setConfigActiveTab('tools');
      useAppStore.getState().toggleConfigModal(true);
      return;
    }
    updatePort(portId, { toolRunning: true });
    try {
      await toolService.runPortTool({
        portId,
        command: config.command,
        workdir: config.workdir || undefined,
      });
    } catch (err) {
      updatePort(portId, { toolRunning: false });
      notifyError(err);
    }
  }, [updatePort]);

  const handleKillTool = useCallback(async (portId: string) => {
    try {
      await toolService.killPortTool(portId);
    } catch (err) {
      notifyError(err);
    }
  }, []);

  const handleConfigTool = useCallback(() => {
    useAppStore.getState().setConfigActiveTab('tools');
    useAppStore.getState().toggleConfigModal(true);
  }, []);

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

  const searchLower = search.toLowerCase();
  const filteredPorts = search
    ? ports.filter(p => p.id.toLowerCase().includes(searchLower) || (p.alias?.toLowerCase().includes(searchLower)))
    : ports;

  // Hidden ports never appear in their normal location (group / ungrouped);
  // they surface ONLY in the dedicated hidden section when toggled visible.
  // (Previously they double-rendered — once here and once in the hidden
  // section — producing duplicate @dnd-kit ids and broken dragging.)
  const ungroupedPorts = filteredPorts.filter(p => !p.groupId && !p.isHidden);
  const ungroupedIds = useMemo(() => ungroupedPorts.map(p => p.id), [ungroupedPorts]);
  const hiddenPorts = useMemo(() => ports.filter(p => p.isHidden), [ports]);
  const hiddenIds = useMemo(() => hiddenPorts.map(p => p.id), [hiddenPorts]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleSortByPort = useCallback(() => {
    const sorted = [...ports].sort((a, b) => {
      const aNum = parseInt(a.id.replace(/\D/g, ''), 10) || 0;
      const bNum = parseInt(b.id.replace(/\D/g, ''), 10) || 0;
      return aNum - bNum;
    });
    useAppStore.getState().setPorts(sorted);
  }, [ports]);

  const handleDragEnd = usePortDragEnd({ groups, ports });

  return (
    <div className="sidebar">
      <SidebarToolbar
        showHidden={showHidden}
        onToggleHidden={() => setShowHidden(!showHidden)}
        onRefresh={refreshPorts}
        simulationMode={simulationMode}
        onToggleSimulation={toggleSimulation}
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
        onSaveLayout={() => { saveConfig(useAppStore.getState().config); }}
      />
      <SearchBox value={search} onChange={setSearch} />

      <div className="sidebar-list">
        {/* 空端口引导卡片：任意端口（真实/SIM）出现后条件不成立自动消失。
            位于 DndContext 之外，不影响端口拖拽排序。 */}
        {ports.length === 0 && !simulationMode && (
          <GuideCard onEnableSimulation={toggleSimulation} />
        )}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          {groups.map(group => {
            const groupPorts = filteredPorts.filter(p => group.portIds.includes(p.id) && !p.isHidden);
            if (groupPorts.length === 0 && search) return null;
            return (
              <GroupItem
                key={group.id}
                group={group}
                ports={filteredPorts}
                onOpenTab={handleOpenTab}
                onToggleConnect={handleToggleConnect}
                onToggleExpand={handleToggleExpand}
                onRenameGroup={handleRenameGroup}
                onRemoveGroup={handleRemoveGroup}
                onSetAlias={handleSetAlias}
                onHidePort={handleHidePort}
                onShowPort={handleShowPort}
                onRunTool={handleRunTool}
                onKillTool={handleKillTool}
                onConfigTool={handleConfigTool}
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
                    onRunTool={handleRunTool}
                    onKillTool={handleKillTool}
                    onConfigTool={handleConfigTool}
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
                    onRunTool={handleRunTool}
                    onKillTool={handleKillTool}
                    onConfigTool={handleConfigTool}
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
    </div>
  );
};

export default Sidebar;
