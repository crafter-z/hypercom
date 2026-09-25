import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { Plus } from 'lucide-react';
import {
  useSerialPorts, useSerialConnection, useSimulation, usePortToolActions, useGitBashSim,
} from '../../hooks';
import { DEV_FEATURES_ENABLED } from '../../utils/devMode';
import { runSequential } from '../../utils/sequential';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import AliasDialog from './AliasDialog';
import GuideCard from './GuideCard';
import SearchBox from './SearchBox';
import SidebarToolbar from './SidebarToolbar';
import SortablePortItem from './SortablePortItem';
import GroupItem from './GroupItem';
import { SidebarActionsProvider, type SidebarActions } from './SidebarActions';
import GroupToolDialog from '../shared/GroupToolDialog';
import { createEmptyGroup, createGroupWithPort } from './groupActions';
import { usePortDragEnd } from './hooks/usePortDragEnd';

/**
 * 串口机架（侧边栏）。容器只做三件事：编排 store/hook 的数据、把动作交给
 * `SidebarActionsProvider`（取代原先逐层透传的 10 个回调）、把列表切成
 * 「分组 / 未分组 / 隐藏」三段。工具栏、搜索框、端口行、组头各自成文件。
 */
const Sidebar: React.FC = () => {
  const { t } = useTranslation();
  const ports = useAppStore((s) => s.ports);
  const groups = useAppStore((s) => s.groups);
  const openTab = useAppStore((s) => s.openTab);
  const updatePort = useAppStore((s) => s.updatePort);
  const updateGroup = useAppStore((s) => s.updateGroup);

  const { refreshPorts } = useSerialPorts(3000);
  const { toggleConnection } = useSerialConnection();
  const { simulationMode, toggleSimulation } = useSimulation();
  const { gitBashMode, toggleGitBashSim } = useGitBashSim();
  const {
    runTool, killTool, configTool, runToolForGroup,
    toolDialog, closeToolDialog, runToolDialogConfigured, configureToolFromDialog,
  } = usePortToolActions();

  const [showHidden, setShowHidden] = useState(false);
  const [search, setSearch] = useState('');
  const [aliasDialog, setAliasDialog] = useState<{ portId: string; currentAlias: string } | null>(null);

  const handleOpenTab = useCallback((portId: string) => {
    if (useAppStore.getState().activeTabId === portId) return;
    // Defer openTab to next microtask to decouple from @dnd-kit event processing.
    queueMicrotask(() => openTab(portId));
  }, [openTab]);

  const handleToggleExpand = useCallback((groupId: string) => {
    const group = useAppStore.getState().groups.find(g => g.id === groupId);
    if (group) updateGroup(groupId, { isExpanded: !group.isExpanded });
  }, [updateGroup]);

  const handleSetAlias = useCallback((portId: string) => {
    const port = useAppStore.getState().ports.find(p => p.id === portId);
    if (port) setAliasDialog({ portId, currentAlias: port.alias || '' });
  }, []);

  const handleHidePort = useCallback((portId: string) => { updatePort(portId, { isHidden: true }); }, [updatePort]);
  const handleShowPort = useCallback((portId: string) => { updatePort(portId, { isHidden: false }); }, [updatePort]);

  const handleSaveAlias = useCallback((alias: string) => {
    if (aliasDialog) {
      updatePort(aliasDialog.portId, { alias: alias || undefined });
      setAliasDialog(null);
    }
  }, [aliasDialog, updatePort]);

  const handleAddGroup = useCallback(() => {
    createEmptyGroup(t('sidebar.addGroup.defaultName'));
  }, [t]);

  const handleRenameGroup = useCallback((groupId: string, name: string) => {
    updateGroup(groupId, { name });
  }, [updateGroup]);

  const handleRemoveGroup = useCallback((groupId: string) => {
    useAppStore.getState().removeGroup(groupId);
  }, []);

  const actions = useMemo<SidebarActions>(() => ({
    openTab: handleOpenTab,
    toggleConnect: toggleConnection,
    setAlias: handleSetAlias,
    hidePort: handleHidePort,
    showPort: handleShowPort,
    runTool,
    killTool,
    configTool,
    runToolForGroup,
    movePortToGroup: (portId, groupId) => useAppStore.getState().movePortToGroup(portId, groupId),
    createGroupWithPort: (portId) => createGroupWithPort(portId, t('sidebar.addGroup.defaultName')),
    toggleGroupExpand: handleToggleExpand,
    renameGroup: handleRenameGroup,
    removeGroup: handleRemoveGroup,
  }), [
    handleOpenTab, toggleConnection, handleSetAlias, handleHidePort, handleShowPort,
    runTool, killTool, configTool, runToolForGroup, handleToggleExpand, handleRenameGroup,
    handleRemoveGroup, t,
  ]);

  const filteredPorts = useMemo(() => {
    if (!search) return ports;
    const searchLower = search.toLowerCase();
    return ports.filter(p => p.id.toLowerCase().includes(searchLower) || (p.alias?.toLowerCase().includes(searchLower)));
  }, [ports, search]);

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

  // 排序是一次性动作：直接重排 store 的 ports 数组（含组内顺序），排序后拖拽/分组
  // 照常可用；3s 轮询的 mergePorts 按 existing 顺序合并，不会冲掉排序结果。
  const handleSortByPort = useCallback(() => {
    useAppStore.getState().sortPortsByNumber();
  }, []);

  // 批量开/关：串行 + 100ms 间隔，避免并发 open/close 在后端抢串口句柄。
  const handleOpenAll = useCallback(() => {
    const pending = useAppStore.getState().ports.filter(p => p.status !== 'connected');
    void runSequential(pending, (p) => toggleConnection(p.id));
  }, [toggleConnection]);

  const handleCloseAll = useCallback(() => {
    const connected = useAppStore.getState().ports.filter(p => p.status === 'connected');
    void runSequential(connected, (p) => toggleConnection(p.id));
  }, [toggleConnection]);

  const handleDragEnd = usePortDragEnd();

  return (
    <SidebarActionsProvider actions={actions}>
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
          onOpenAll={handleOpenAll}
          onCloseAll={handleCloseAll}
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
              const groupPorts = filteredPorts.filter(p => group.portIds.includes(p.id) && !p.isHidden);
              if (groupPorts.length === 0 && search) return null;
              return (
                <GroupItem
                  key={group.id}
                  group={group}
                  ports={filteredPorts}
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
        {toolDialog && (
          <GroupToolDialog
            group={toolDialog.group}
            configured={toolDialog.configured}
            unconfigured={toolDialog.unconfigured}
            onRun={runToolDialogConfigured}
            onConfigure={configureToolFromDialog}
            onClose={closeToolDialog}
          />
        )}
      </div>
    </SidebarActionsProvider>
  );
};

export default Sidebar;
