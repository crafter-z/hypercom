/**
 * 左侧串口管理边栏
 * 包含顶部工具栏、串口列表、分组管理、右键菜单
 * 状态由 Zustand 统一管理
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import type { SerialPort, PortGroup, PortStatus } from '../../types';

// ==================== 初始化模拟数据 ====================
const mockPorts: SerialPort[] = [
  { id: 'COM3', name: 'COM3', alias: 'STM32_TTY', status: 'connected', type: 'real', isHidden: false, groupId: 'group1', baudRate: 115200 },
  { id: 'COM4', name: 'COM4', alias: 'ESP32-DevKit', status: 'error', type: 'real', isHidden: false, groupId: 'group1', baudRate: 115200 },
  { id: 'COM5', name: 'COM5', alias: 'JLink_VCOM', status: 'disconnected', type: 'real', isHidden: false, groupId: 'group2' },
  { id: 'COM7', name: 'COM7', alias: 'Temp_Sensor', status: 'connected', type: 'real', isHidden: false, groupId: 'group2', baudRate: 57600 },
  { id: 'COM8', name: 'COM8', alias: 'IMU_Module', status: 'disconnected', type: 'real', isHidden: false, groupId: 'group2' },
  { id: 'COM9', name: 'COM9', alias: 'VSPort_1', status: 'disconnected', type: 'virtual', isHidden: false, groupId: 'group3' },
  { id: 'COM10', name: 'COM10', alias: 'VSPort_2', status: 'error', type: 'virtual', isHidden: false, groupId: 'group3' },
  { id: 'COM11', name: 'COM11', alias: 'Hidden_COM111', status: 'disconnected', type: 'real', isHidden: true },
];

const mockGroups: PortGroup[] = [
  { id: 'group1', name: '开发板组', isExpanded: true, portIds: ['COM3', 'COM4'], order: 0 },
  { id: 'group2', name: '传感器组', isExpanded: true, portIds: ['COM5', 'COM7', 'COM8'], order: 1 },
  { id: 'group3', name: '虚拟端口', isExpanded: true, portIds: ['COM9', 'COM10'], order: 2 },
];

// ==================== 子组件：顶部工具栏 ====================

const SidebarToolbar: React.FC<{ showHidden: boolean; onToggleHidden: () => void }> = ({ showHidden, onToggleHidden }) => {
  const { setPorts } = useAppStore();

  return (
    <div className="toolbar" style={{ padding: '6px 8px', justifyContent: 'space-between' }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>串口管理</span>
      <div style={{ display: 'flex', gap: 2 }}>
        <button className="btn btn-icon btn-sm" title="一键打开全部">▶</button>
        <button className="btn btn-icon btn-sm" title="一键关闭全部">⏹</button>
        <button
          className="btn btn-icon btn-sm"
          title={showHidden ? '隐藏' : '显示已隐藏串口'}
          onClick={onToggleHidden}
          style={{ color: showHidden ? 'var(--text-link)' : undefined }}
        >
          👁
        </button>
        <button className="btn btn-icon btn-sm" title="按端口号排序">⇅</button>
        <button className="btn btn-icon btn-sm" title="保存布局">💾</button>
        <button className="btn btn-icon btn-sm" title="刷新串口列表" onClick={() => setPorts(mockPorts)}>↻</button>
      </div>
    </div>
  );
};

// ==================== 子组件：搜索框 ====================

const SearchBox: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
  return (
    <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-color)' }}>
      <input
        className="input"
        style={{ width: '100%', fontSize: 12 }}
        placeholder="搜索串口或备注名..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
};

// ==================== 子组件：串口项 ====================

interface PortItemProps {
  port: SerialPort;
  isConnected: boolean;
  onOpenTab: (portId: string) => void;
  onToggleConnect: (portId: string) => void;
}

const PortItem: React.FC<PortItemProps> = ({ port, isConnected, onOpenTab, onToggleConnect }) => {
  const statusColor = {
    disconnected: 'var(--status-disconnected)',
    error: 'var(--status-error)',
    connected: 'var(--status-connected)',
  }[port.status];

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 10px',
        cursor: 'pointer',
        transition: 'background var(--transition-fast)',
        borderLeft: `3px solid ${statusColor}`,
      }}
      onDoubleClick={() => onOpenTab(port.id)}
      onContextMenu={(e) => e.preventDefault()}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      {/* 状态指示 */}
      <div
        className="status-dot"
        style={{ background: statusColor, boxShadow: `0 0 4px ${statusColor}` }}
      />

      {/* 串口信息 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
            {port.id}
          </span>
          {port.alias && (
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }} className="text-ellipsis">
              {port.alias}
            </span>
          )}
          {port.type === 'virtual' && (
            <span style={{ fontSize: 9, color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 2, padding: '0 3px' }}>
              VCP
            </span>
          )}
        </div>
        {port.baudRate && (
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
            {port.baudRate},{port.dataBits || 8}{port.parity?.[0] || 'N'}{port.stopBits === 'One' ? '1' : port.stopBits === 'Two' ? '2' : '1.5'}
          </div>
        )}
      </div>

      {/* 连接/断开按钮 */}
      <button
        className="btn btn-icon btn-sm"
        title={isConnected ? '断开连接' : '连接串口'}
        onClick={(e) => {
          e.stopPropagation();
          onToggleConnect(port.id);
        }}
        style={{ color: isConnected ? 'var(--status-connected)' : 'var(--status-disconnected)' }}
      >
        {isConnected ? '⏹' : '▶'}
      </button>
    </div>
  );
};

// ==================== 子组件：分组项 ====================

interface GroupItemProps {
  group: PortGroup;
  ports: SerialPort[];
  onOpenTab: (portId: string) => void;
  onToggleConnect: (portId: string) => void;
  onToggleExpand: (groupId: string) => void;
}

const GroupItem: React.FC<GroupItemProps> = ({ group, ports, onOpenTab, onToggleConnect, onToggleExpand }) => {
  const groupPorts = ports.filter(p => group.portIds.includes(p.id));
  const connectedCount = groupPorts.filter(p => p.status === 'connected').length;

  return (
    <div style={{ marginBottom: 2 }}>
      {/* 分组头部 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 10px',
          cursor: 'pointer',
          background: 'var(--bg-tertiary)',
          borderBottom: '1px solid var(--border-color)',
        }}
        onClick={() => onToggleExpand(group.id)}
      >
        <span style={{
          fontSize: 10,
          transition: 'transform 0.2s',
          transform: group.isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
        }}>
          ▶
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', flex: 1 }}>
          {group.name}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
          {connectedCount}/{groupPorts.length}
        </span>
        <button className="btn btn-icon btn-sm" title="一键连接整组" onClick={(e) => e.stopPropagation()}>▶</button>
        <button className="btn btn-icon btn-sm" title="一键断开整组" onClick={(e) => e.stopPropagation()}>⏹</button>
      </div>

      {/* 分组内的串口 */}
      {group.isExpanded && (
        <div>
          {groupPorts.map(port => (
            <PortItem
              key={port.id}
              port={port}
              isConnected={port.status === 'connected'}
              onOpenTab={onOpenTab}
              onToggleConnect={onToggleConnect}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ==================== 主组件：侧边栏 ====================

const Sidebar: React.FC = () => {
  const {
    ports,
    groups,
    openTab,
    updatePort,
    updateGroup,
    setPorts,
    addGroup,
  } = useAppStore();

  const [showHidden, setShowHidden] = useState(false);
  const [search, setSearch] = useState('');

  // 首次加载时初始化模拟数据
  useEffect(() => {
    if (ports.length === 0) {
      setPorts(mockPorts);
      mockGroups.forEach(g => addGroup(g));
    }
  }, []);

  const handleOpenTab = useCallback((portId: string) => {
    openTab(portId);
  }, [openTab]);

  const handleToggleConnect = useCallback((portId: string) => {
    const port = ports.find(p => p.id === portId);
    if (!port) return;
    const newStatus: PortStatus = port.status === 'connected' ? 'disconnected' : 'connected';
    updatePort(portId, { status: newStatus });
  }, [ports, updatePort]);

  const handleToggleExpand = useCallback((groupId: string) => {
    const group = groups.find(g => g.id === groupId);
    if (group) {
      updateGroup(groupId, { isExpanded: !group.isExpanded });
    }
  }, [groups, updateGroup]);

  // 过滤搜索
  const searchLower = search.toLowerCase();
  const filteredPorts = search
    ? ports.filter(p => p.id.toLowerCase().includes(searchLower) || (p.alias?.toLowerCase().includes(searchLower)))
    : ports;

  // 未分组的串口
  const ungroupedPorts = filteredPorts.filter(p => !p.groupId && (!p.isHidden || showHidden));

  return (
    <div
      style={{
        width: 'var(--sidebar-width)',
        minWidth: 200,
        maxWidth: 400,
        background: 'var(--bg-sidebar)',
        borderRight: '1px solid var(--border-color)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <SidebarToolbar showHidden={showHidden} onToggleHidden={() => setShowHidden(!showHidden)} />
      <SearchBox value={search} onChange={setSearch} />

      {/* 串口列表区域 */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        {/* 分组列表 */}
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
            />
          );
        })}

        {/* 未分组的串口 */}
        {ungroupedPorts.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <div style={{
              padding: '3px 10px',
              fontSize: 11,
              color: 'var(--text-secondary)',
              background: 'var(--bg-tertiary)',
            }}>
              未分组
            </div>
            {ungroupedPorts.map(port => (
              <PortItem
                key={port.id}
                port={port}
                isConnected={port.status === 'connected'}
                onOpenTab={handleOpenTab}
                onToggleConnect={handleToggleConnect}
              />
            ))}
          </div>
        )}

        {/* 隐藏的串口区域 */}
        {showHidden && ports.filter(p => p.isHidden).length > 0 && (
          <div style={{ marginTop: 4 }}>
            <div style={{
              padding: '3px 10px',
              fontSize: 11,
              color: 'var(--text-secondary)',
              background: 'var(--bg-tertiary)',
            }}>
              已隐藏
            </div>
            {ports.filter(p => p.isHidden).map(port => (
              <PortItem
                key={port.id}
                port={port}
                isConnected={port.status === 'connected'}
                onOpenTab={handleOpenTab}
                onToggleConnect={handleToggleConnect}
              />
            ))}
          </div>
        )}

        {/* 新建分组按钮 */}
        <div style={{ padding: '8px 10px' }}>
          <button className="btn" style={{ width: '100%', fontSize: 12 }}>
            + 新建分组
          </button>
        </div>
      </div>
    </div>
  );
};

export default Sidebar;
