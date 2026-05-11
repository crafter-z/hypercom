import React, { useState, useCallback } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import type { SerialPort, PortGroup } from '../../types';
import { useContextMenu, type ContextMenuEntry } from '../shared/ContextMenu';
import {
  Play, Square, Eye, EyeOff, ArrowUpDown, Save, RefreshCw,
  ChevronRight, Plus, X, Search, FlaskConical,
  PlugZap, Pencil, Unplug, ExternalLink
} from 'lucide-react';
import { useSerialPorts, useSerialConnection, useSimulation, useConfigPersistence } from '../../hooks/useTauri';

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
  return (
    <div className="sidebar-toolbar">
      <span className="sidebar-toolbar-title">串口管理</span>
      <div className="sidebar-toolbar-actions">
        <button className="btn btn-icon btn-sm" title="一键打开全部" onClick={onOpenAll}><Play size={14} /></button>
        <button className="btn btn-icon btn-sm" title="一键关闭全部" onClick={onCloseAll}><Square size={14} /></button>
        <button
          className={`btn btn-icon btn-sm${simulationMode ? ' active' : ''}`}
          title={simulationMode ? '关闭模拟模式' : '开启模拟模式'}
          onClick={onToggleSimulation}
        >
          <FlaskConical size={14} />
        </button>
        <button
          className={`btn btn-icon btn-sm${showHidden ? ' active' : ''}`}
          title={showHidden ? '隐藏已隐藏串口' : '显示已隐藏串口'}
          onClick={onToggleHidden}
        >
          {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
        <button className="btn btn-icon btn-sm" title="按端口号排序" onClick={onSortByPort}><ArrowUpDown size={14} /></button>
        <button className="btn btn-icon btn-sm" title="保存布局" onClick={onSaveLayout}><Save size={14} /></button>
        <button className="btn btn-icon btn-sm" title="刷新串口列表" onClick={onRefresh}><RefreshCw size={14} /></button>
      </div>
    </div>
  );
};

const SearchBox: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
  return (
    <div className="sidebar-search">
      <Search size={14} className="sidebar-search-icon" />
      <input
        className="sidebar-search-input"
        placeholder="搜索串口..."
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

interface PortItemProps {
  port: SerialPort;
  isConnected: boolean;
  onOpenTab: (portId: string) => void;
  onToggleConnect: (portId: string) => void;
  onSetAlias: (portId: string) => void;
  onHidePort: (portId: string) => void;
  onShowPort: (portId: string) => void;
}

const PortItem: React.FC<PortItemProps> = ({
  port,
  isConnected,
  onOpenTab,
  onToggleConnect,
  onSetAlias,
  onHidePort,
  onShowPort,
}) => {
  const { show, element } = useContextMenu();

  const statusColor = {
    disconnected: 'var(--status-disconnected)',
    error: 'var(--status-error)',
    connected: 'var(--status-connected)',
  }[port.status];

  const statusLabel = {
    disconnected: '未连接',
    error: '错误',
    connected: '已连接',
  }[port.status];

  const items: ContextMenuEntry[] = [
    { label: isConnected ? '断开连接' : '连接串口', icon: isConnected ? <Unplug size={14} /> : <PlugZap size={14} />, onClick: () => onToggleConnect(port.id) },
    { type: 'separator' },
    { label: '设置备注名', icon: <Pencil size={14} />, onClick: () => onSetAlias(port.id) },
    { label: '在标签页中打开', icon: <ExternalLink size={14} />, onClick: () => onOpenTab(port.id) },
    { type: 'separator' },
    port.isHidden
      ? { label: '取消隐藏', icon: <Eye size={14} />, onClick: () => onShowPort(port.id) }
      : { label: '隐藏此串口', icon: <EyeOff size={14} />, onClick: () => onHidePort(port.id) },
  ];

  return (
    <>
      <div
        className="port-item"
        onDoubleClick={() => onOpenTab(port.id)}
        onContextMenu={(e) => show(e, items)}
      >
        <div className="port-item-status" style={{ backgroundColor: statusColor, boxShadow: port.status === 'connected' ? `0 0 6px ${statusColor}` : 'none' }} />
        <div className="port-item-info">
          <div className="port-item-title">
            <span className="port-item-name">{port.id}</span>
            {port.alias && <span className="port-item-alias">{port.alias}</span>}
            {port.type === 'sim' && <span className="port-item-badge" style={{ backgroundColor: 'var(--accent-color, #4fc3f7)' }}>SIM</span>}
            {port.type === 'virtual' && <span className="port-item-badge">VCP</span>}
          </div>
          <div className="port-item-meta">
            <span style={{ color: statusColor }}>{statusLabel}</span>
            {port.baudRate && (
              <span className="port-item-baud">
                {port.baudRate},{port.dataBits || 8}{port.parity?.[0] || 'N'}{port.stopBits === 'One' ? '1' : port.stopBits === 'Two' ? '2' : '1.5'}
              </span>
            )}
          </div>
        </div>
        <button
          className={`btn btn-icon btn-sm port-connect-btn${isConnected ? ' connected' : ''}`}
          title={isConnected ? '断开连接' : '连接串口'}
          onClick={(e) => { e.stopPropagation(); onToggleConnect(port.id); }}
        >
          {isConnected ? <Square size={12} /> : <Play size={12} />}
        </button>
      </div>
      {element}
    </>
  );
};

interface GroupItemProps {
  group: PortGroup;
  ports: SerialPort[];
  onOpenTab: (portId: string) => void;
  onToggleConnect: (portId: string) => void;
  onToggleExpand: (groupId: string) => void;
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
  onSetAlias,
  onHidePort,
  onShowPort,
}) => {
  const groupPorts = ports.filter(p => group.portIds.includes(p.id));
  const connectedCount = groupPorts.filter(p => p.status === 'connected').length;

  const handleConnectAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    groupPorts.forEach(p => { if (p.status !== 'connected') onToggleConnect(p.id); });
  };

  const handleDisconnectAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    groupPorts.forEach(p => { if (p.status === 'connected') onToggleConnect(p.id); });
  };

  return (
    <div className="port-group">
      <div className="port-group-header" onClick={() => onToggleExpand(group.id)}>
        <ChevronRight
          size={12}
          className="port-group-chevron"
          style={{ transform: group.isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
        />
        <span className="port-group-name">{group.name}</span>
        <span className="port-group-count">{connectedCount}/{groupPorts.length}</span>
        <button className="btn btn-icon btn-sm" title="一键连接整组" onClick={handleConnectAll}>
          <Play size={10} />
        </button>
        <button className="btn btn-icon btn-sm" title="一键断开整组" onClick={handleDisconnectAll}>
          <Square size={10} />
        </button>
      </div>
      {group.isExpanded && (
        <div className="port-group-list">
          {groupPorts.map(port => (
            <PortItem
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
      )}
    </div>
  );
};

const AliasDialog: React.FC<{ portId: string; currentAlias: string; onSave: (alias: string) => void; onCancel: () => void }> = ({
  portId,
  currentAlias,
  onSave,
  onCancel,
}) => {
  const [value, setValue] = useState(currentAlias);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-dialog animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-dialog-title">设置备注名</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 }}>
          为 <strong>{portId}</strong> 设置备注名
        </p>
        <input
          className="input modal-dialog-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="输入备注名..."
          autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter') onSave(value); if (e.key === 'Escape') onCancel(); }}
        />
        <div className="modal-dialog-actions">
          <button className="btn" onClick={onCancel}>取消</button>
          <button className="btn btn-primary" onClick={() => onSave(value)}>确定</button>
        </div>
      </div>
    </div>
  );
};

const Sidebar: React.FC = () => {
  const {
    ports,
    groups,
    openTab,
    updatePort,
    updateGroup,
    addGroup,
  } = useAppStore();

  const { refreshPorts } = useSerialPorts(3000);
  const { toggleConnection } = useSerialConnection();
  const { simulationMode, toggleSimulation } = useSimulation();
  const { saveConfig } = useConfigPersistence();

  const [showHidden, setShowHidden] = useState(false);
  const [search, setSearch] = useState('');
  const [aliasDialog, setAliasDialog] = useState<{ portId: string; currentAlias: string } | null>(null);

  React.useEffect(() => {
    if (groups.length === 0) {
      const mockGroups: PortGroup[] = [
        { id: 'group1', name: '开发板组', isExpanded: true, portIds: ['COM3', 'COM4'], order: 0 },
        { id: 'group2', name: '传感器组', isExpanded: true, portIds: ['COM5', 'COM7', 'COM8'], order: 1 },
        { id: 'group3', name: '虚拟端口', isExpanded: true, portIds: ['COM9', 'COM10'], order: 2 },
      ];
      mockGroups.forEach(g => addGroup(g));
    }
  }, [groups.length, addGroup]);

  const handleOpenTab = useCallback((portId: string) => { openTab(portId); }, [openTab]);

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
    addGroup({ id, name: '新建分组', isExpanded: true, portIds: [], order: groups.length });
  }, [addGroup, groups.length]);

  const searchLower = search.toLowerCase();
  const filteredPorts = search
    ? ports.filter(p => p.id.toLowerCase().includes(searchLower) || (p.alias?.toLowerCase().includes(searchLower)))
    : ports;

  const ungroupedPorts = filteredPorts.filter(p => !p.groupId && (!p.isHidden || showHidden));

  const handleSortByPort = useCallback(() => {
    const sorted = [...ports].sort((a, b) => {
      const aNum = parseInt(a.id.replace(/\D/g, ''), 10) || 0;
      const bNum = parseInt(b.id.replace(/\D/g, ''), 10) || 0;
      return aNum - bNum;
    });
    useAppStore.getState().setPorts(sorted);
  }, [ports]);

  return (
    <div className="sidebar">
      <SidebarToolbar
        showHidden={showHidden}
        onToggleHidden={() => setShowHidden(!showHidden)}
        onRefresh={refreshPorts}
        simulationMode={simulationMode}
        onToggleSimulation={toggleSimulation}
        onOpenAll={() => { ports.forEach(p => { if (p.status !== 'connected') toggleConnection(p.id); }); }}
        onCloseAll={() => { ports.forEach(p => { if (p.status === 'connected') toggleConnection(p.id); }); }}
        onSortByPort={handleSortByPort}
        onSaveLayout={() => { saveConfig(useAppStore.getState().config); }}
      />
      <SearchBox value={search} onChange={setSearch} />

      <div className="sidebar-list">
        {groups.map(group => {
          const groupPorts = filteredPorts.filter(p => group.portIds.includes(p.id));
          if (groupPorts.length === 0 && !search) return null;
          return (
            <GroupItem
              key={group.id}
              group={group}
              ports={filteredPorts}
              onOpenTab={handleOpenTab}
              onToggleConnect={handleToggleConnect}
              onToggleExpand={handleToggleExpand}
              onSetAlias={handleSetAlias}
              onHidePort={handleHidePort}
              onShowPort={handleShowPort}
            />
          );
        })}

        {ungroupedPorts.length > 0 && (
          <div className="sidebar-section">
            <div className="sidebar-section-header">未分组</div>
            {ungroupedPorts.map(port => (
              <PortItem
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

        {showHidden && ports.filter(p => p.isHidden).length > 0 && (
          <div className="sidebar-section">
            <div className="sidebar-section-header">已隐藏</div>
            {ports.filter(p => p.isHidden).map(port => (
              <PortItem
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
            新建分组
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