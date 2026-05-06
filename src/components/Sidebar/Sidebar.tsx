/**
 * 左侧串口管理边栏
 * 包含顶部工具栏、串口列表、分组管理、右键菜单
 * 支持拖拽排序、分组聚合、状态显示
 */

import React, { useState, useCallback } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import type { SerialPort, PortGroup, PortStatus } from '../../types';

// ==================== 模拟数据（后续从后端获取） ====================
const mockPorts: SerialPort[] = [
  { id: 'COM3', name: 'COM3', alias: 'STM32_TTY', status: 'connected', type: 'real', isHidden: false, groupId: 'group1', baudRate: 115200 },
  { id: 'COM4', name: 'COM4', alias: 'ESP32-DevKit', status: 'error', type: 'real', isHidden: false, groupId: 'group1' },
  { id: 'COM5', name: 'COM5', alias: 'JLink_VCOM', status: 'disconnected', type: 'real', isHidden: false, groupId: 'group2' },
  { id: 'COM7', name: 'COM7', alias: 'Temp_Sensor', status: 'connected', type: 'real', isHidden: false, groupId: 'group2' },
  { id: 'COM8', name: 'COM8', alias: 'IMU_Module', status: 'disconnected', type: 'real', isHidden: false, groupId: 'group2' },
  { id: 'COM9', name: 'COM9', alias: 'VSPort_1', status: 'disconnected', type: 'virtual', isHidden: false, groupId: 'group3' },
  { id: 'COM10', name: 'COM10', alias: 'VSPort_2', status: 'error', type: 'virtual', isHidden: false, groupId: 'group3' },
  { id: 'COM11', name: 'COM11', alias: 'Hidden_COM111', status: 'disconnected', type: 'real', isHidden: true },
];

const mockGroups: PortGroup[] = [
  { id: 'group1', name: '开发板组 (2)', isExpanded: true, portIds: ['COM3', 'COM4'], order: 0 },
  { id: 'group2', name: '传感器组 (3)', isExpanded: true, portIds: ['COM5', 'COM7', 'COM8'], order: 1 },
  { id: 'group3', name: '虚拟端口 (2)', isExpanded: true, portIds: ['COM9', 'COM10'], order: 2 },
];

// ==================== 子组件：顶部工具栏 ====================

const SidebarToolbar: React.FC = () => {
  const [showHidden, setShowHidden] = useState(false);

  return (
    <div className="toolbar" style={{ padding: '6px 8px', justifyContent: 'space-between' }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>串口管理</span>
      <div style={{ display: 'flex', gap: 2 }}>
        <button className="btn btn-icon btn-sm" title="一键打开全部">▶</button>
        <button className="btn btn-icon btn-sm" title="一键关闭全部">⏹</button>
        <button
          className="btn btn-icon btn-sm"
          title={showHidden ? '隐藏已隐藏串口' : '显示隐藏串口'}
          onClick={() => setShowHidden(!showHidden)}
          style={{ color: showHidden ? 'var(--text-link)' : undefined }}
        >
          👁
        </button>
        <button className="btn btn-icon btn-sm" title="排序">⇅</button>
        <button className="btn btn-icon btn-sm" title="保存布局">💾</button>
        <button className="btn btn-icon btn-sm" title="刷新">↻</button>
      </div>
    </div>
  );
};

// ==================== 子组件：搜索框 ====================

const SearchBox: React.FC = () => {
  return (
    <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border-color)' }}>
      <input
        className="input"
        style={{ width: '100%', fontSize: 12 }}
        placeholder="搜索串口或备注名..."
      />
    </div>
  );
};

// ==================== 子组件：串口项 ====================

interface PortItemProps {
  port: SerialPort;
  onOpenTab: (portId: string) => void;
  onToggleConnect: (portId: string) => void;
}

const PortItem: React.FC<PortItemProps> = ({ port, onOpenTab, onToggleConnect }) => {
  const statusColor = {
    disconnected: 'var(--status-disconnected)',
    error: 'var(--status-error)',
    connected: 'var(--status-connected)',
  }[port.status];

  const isConnected = port.status === 'connected';

  return (
    <div
      className="port-item"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        cursor: 'pointer',
        transition: 'background var(--transition-fast)',
        borderLeft: `3px solid ${statusColor}`,
      }}
      onDoubleClick={() => onOpenTab(port.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        // TODO: 显示右键菜单
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      {/* 状态指示 */}
      <div
        className="status-dot"
        style={{
          background: statusColor,
          boxShadow: `0 0 4px ${statusColor}`,
        }}
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
        style={{
          color: isConnected ? 'var(--status-connected)' : 'var(--status-disconnected)',
        }}
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

const GroupItem: React.FC<GroupItemProps> = ({
  group,
  ports,
  onOpenTab,
  onToggleConnect,
  onToggleExpand,
}) => {
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
          padding: '6px 10px',
          cursor: 'pointer',
          background: 'var(--bg-tertiary)',
          borderBottom: '1px solid var(--border-color)',
        }}
        onClick={() => onToggleExpand(group.id)}
      >
        <span style={{ fontSize: 10, transition: 'transform 0.2s', transform: group.isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
          ▶
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', flex: 1 }}>
          {group.name}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
          {connectedCount}/{groupPorts.length}
        </span>
        <button
          className="btn btn-icon btn-sm"
          title="一键开启整组"
          onClick={(e) => e.stopPropagation()}
        >
          ▶
        </button>
        <button
          className="btn btn-icon btn-sm"
          title="一键关闭整组"
          onClick={(e) => e.stopPropagation()}
        >
          ⏹
        </button>
      </div>

      {/* 分组内的串口 */}
      {group.isExpanded && (
        <div>
          {groupPorts.map(port => (
            <PortItem
              key={port.id}
              port={port}
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
  const openTab = useAppStore((state) => state.openTab);
  const [ports, setPorts] = useState<SerialPort[]>(mockPorts);
  const [groups, setGroups] = useState<PortGroup[]>(mockGroups);
  const [showHidden] = useState(false);

  const handleOpenTab = useCallback((portId: string) => {
    openTab(portId);
  }, [openTab]);

  const handleToggleConnect = useCallback((portId: string) => {
    setPorts(prev => prev.map(p => {
      if (p.id === portId) {
        const newStatus: PortStatus = p.status === 'connected' ? 'disconnected' : 'connected';
        return { ...p, status: newStatus };
      }
      return p;
    }));
  }, []);

  const handleToggleExpand = useCallback((groupId: string) => {
    setGroups(prev => prev.map(g =>
      g.id === groupId ? { ...g, isExpanded: !g.isExpanded } : g
    ));
  }, []);

  // 未分组的串口
  const ungroupedPorts = ports.filter(p => !p.groupId && (!p.isHidden || showHidden));

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
      <SidebarToolbar />
      <SearchBox />

      {/* 串口列表区域 */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        {/* 分组列表 */}
        {groups.map(group => (
          <GroupItem
            key={group.id}
            group={group}
            ports={ports}
            onOpenTab={handleOpenTab}
            onToggleConnect={handleToggleConnect}
            onToggleExpand={handleToggleExpand}
          />
        ))}

        {/* 未分组的串口 */}
        {ungroupedPorts.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <div style={{
              padding: '4px 10px',
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
              padding: '4px 10px',
              fontSize: 11,
              color: 'var(--text-secondary)',
              background: 'var(--bg-tertiary)',
            }}>
              隐藏的串口
            </div>
            {ports.filter(p => p.isHidden).map(port => (
              <PortItem
                key={port.id}
                port={port}
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
