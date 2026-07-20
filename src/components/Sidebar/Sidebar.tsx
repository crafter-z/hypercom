import React, { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import type { SerialPort, PortGroup } from '../../types';
import { useContextMenu, type ContextMenuEntry } from '../shared/ContextMenu';
import {
  Play, Square, Eye, EyeOff, ArrowUpDown, Save, RefreshCw,
  ChevronRight, Plus, X, Search, FlaskConical,
  PlugZap, Pencil, Unplug, ExternalLink, GripVertical, Trash2
} from 'lucide-react';
import { useSerialPorts, useSerialConnection, useSimulation, useConfigPersistence } from '../../hooks/useTauri';
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
  return (
    <div className="sidebar-toolbar">
      <span className="sidebar-toolbar-title">{t('sidebar.toolbar.title')}</span>
      <div className="sidebar-toolbar-actions">
        <button className="btn btn-icon btn-sm" title={t('sidebar.toolbar.openAll')} onClick={onOpenAll}><Play size={14} /></button>
        <button className="btn btn-icon btn-sm" title={t('sidebar.toolbar.closeAll')} onClick={onCloseAll}><Square size={14} /></button>
        <span className="sidebar-toolbar-sep" />
        <button
          className={`btn btn-icon btn-sm${simulationMode ? ' active' : ''}`}
          title={simulationMode ? t('sidebar.toolbar.disableSimulation') : t('sidebar.toolbar.enableSimulation')}
          onClick={onToggleSimulation}
        >
          <FlaskConical size={14} />
        </button>
        <button
          className={`btn btn-icon btn-sm${showHidden ? ' active' : ''}`}
          title={showHidden ? t('sidebar.toolbar.hideHidden') : t('sidebar.toolbar.showHidden')}
          onClick={onToggleHidden}
        >
          {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
        <button className="btn btn-icon btn-sm" title={t('sidebar.toolbar.sortByPort')} onClick={onSortByPort}><ArrowUpDown size={14} /></button>
        <span className="sidebar-toolbar-sep" />
        <button className="btn btn-icon btn-sm" title={t('sidebar.toolbar.saveLayout')} onClick={onSaveLayout}><Save size={14} /></button>
        <button className="btn btn-icon btn-sm" title={t('sidebar.toolbar.refresh')} onClick={onRefresh}><RefreshCw size={14} /></button>
      </div>
    </div>
  );
};

const SearchBox: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
  const { t } = useTranslation();
  return (
    <div className="sidebar-search">
      <Search size={14} className="sidebar-search-icon" />
      <input
        className="sidebar-search-input"
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
}

const SortablePortItem: React.FC<SortablePortItemProps> = ({
  port,
  isConnected,
  onOpenTab,
  onToggleConnect,
  onSetAlias,
  onHidePort,
  onShowPort,
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

  const statusColor = {
    disconnected: 'var(--status-disconnected)',
    error: 'var(--status-error)',
    connected: 'var(--status-connected)',
    connecting: 'var(--status-connecting)',
  }[port.status] || 'var(--status-disconnected)';

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
    port.isHidden
      ? { label: t('sidebar.port.contextMenu.unhide'), icon: <Eye size={14} />, onClick: () => onShowPort(port.id) }
      : { label: t('sidebar.port.contextMenu.hide'), icon: <EyeOff size={14} />, onClick: () => onHidePort(port.id) },
  ];

  return (
    <div ref={setNodeRef} style={style}>
      <div
        className="port-item"
        onDoubleClick={() => onOpenTab(port.id)}
        onContextMenu={(e) => show(e, items)}
      >
        <span className="port-item-drag" {...attributes} {...listeners}>
          <GripVertical size={12} />
        </span>
        <div className="port-item-status" style={{ backgroundColor: statusColor, boxShadow: port.status === 'connected' ? `0 0 6px ${statusColor}` : 'none' }} />
        <div className="port-item-info">
          <div className="port-item-title">
            <span className="port-item-name">{port.id}</span>
            {port.alias && <span className="port-item-alias">{port.alias}</span>}
            {port.type === 'sim' && <span className="port-item-badge" style={{ backgroundColor: 'var(--accent-color, #4fc3f7)' }}>SIM</span>}
            {port.type === 'virtual' && <span className="port-item-badge">VCP</span>}
          </div>
          <div className="port-item-meta">
            <span style={{ color: statusColor }}>{label}</span>
            {port.baudRate && (
              <span className="port-item-baud">
                {port.baudRate},{port.dataBits || 8}{port.parity?.[0] || 'N'}{port.stopBits === 'One' ? '1' : port.stopBits === 'Two' ? '2' : '1.5'}
              </span>
            )}
          </div>
        </div>
        <button
          className={`btn btn-icon btn-sm port-connect-btn${isConnected ? ' connected' : ''}`}
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
}

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
}) => {
  const { t } = useTranslation();
  const groupPorts = ports.filter(p => group.portIds.includes(p.id));
  const connectedCount = groupPorts.filter(p => p.status === 'connected').length;
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(group.name);

  const { show, element } = useContextMenu();

  // Make the group a droppable target so ports can be dropped onto the group
  // header itself (not just onto individual ports inside the group).
  const { setNodeRef: setGroupDropRef, isOver: isGroupDropOver } = useDroppable({
    id: `droppable-${group.id}`,
  });

  const handleConnectAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    groupPorts.forEach(p => { if (p.status !== 'connected') onToggleConnect(p.id); });
  };

  const handleDisconnectAll = (e: React.MouseEvent) => {
    e.stopPropagation();
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

  const groupMenuItems: ContextMenuEntry[] = [
    { label: t('sidebar.group.contextMenu.rename'), icon: <Pencil size={14} />, onClick: () => { setRenameValue(group.name); setIsRenaming(true); } },
    { label: t('sidebar.group.contextMenu.delete'), icon: <Trash2 size={14} />, onClick: () => onRemoveGroup(group.id) },
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
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); show(e, groupMenuItems); }}
      >
        <ChevronRight
          size={12}
          className="port-group-chevron"
          style={{ transform: group.isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
        />
        {isRenaming ? (
          <input
            className="input"
            style={{ flex: 1, fontSize: 12, padding: '2px 4px', minWidth: 0 }}
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
            className="port-group-name"
            onDoubleClick={handleStartRename}
            title={t('sidebar.group.doubleClickRename')}
          >
            {group.name}
          </span>
        )}
        <span className="port-group-count">{connectedCount}/{groupPorts.length}</span>
        <button className="btn btn-icon btn-sm" title={t('sidebar.group.connectAll')} onClick={handleConnectAll}>
          <Play size={10} />
        </button>
        <button className="btn btn-icon btn-sm" title={t('sidebar.group.disconnectAll')} onClick={handleDisconnectAll}>
          <Square size={10} />
        </button>
        <button
          className="btn btn-icon btn-sm"
          title={t('sidebar.group.delete')}
          onClick={(e) => { e.stopPropagation(); onRemoveGroup(group.id); }}
        >
          <Trash2 size={10} />
        </button>
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

  const ungroupedPorts = filteredPorts.filter(p => !p.groupId && (!p.isHidden || showHidden));
  const ungroupedIds = useMemo(() => ungroupedPorts.map(p => p.id), [ungroupedPorts]);

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
            const groupPorts = filteredPorts.filter(p => group.portIds.includes(p.id));
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
              />
            );
          })}

          {ungroupedPorts.length > 0 && (
            <div className="sidebar-section">
              <div className="sidebar-section-header">{t('sidebar.section.ungrouped')}</div>
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
                  />
                ))}
              </SortableContext>
            </div>
          )}
        </DndContext>

        {showHidden && ports.filter(p => p.isHidden).length > 0 && (
          <div className="sidebar-section">
            <div className="sidebar-section-header">{t('sidebar.section.hidden')}</div>
            {ports.filter(p => p.isHidden).map(port => (
              <SortablePortItem
                key={port.id}
                port={port}
                isConnected={port.status === 'connected'}
                onOpenTab={handleOpenTab}
                onToggleConnect={handleToggleConnect}
                onSetAlias={handleSetAlias}
                onHidePort={handleHidePort}
                onShowPort={handleShowPort}
              />
            ))}
          </div>
        )}

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
