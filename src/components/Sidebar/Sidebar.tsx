import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getActivePortId, findSerialTabByPortId, useAppStore } from '../../stores/useAppStore';
import { useSystemStore } from '../../stores/useSystemStore';
import { Plus } from 'lucide-react';
import {
  useSerialPorts, useSerialConnection, useSimulation, usePortToolActions, useGitBashSim,
} from '../../hooks';
import { controlService } from '../../services/tauri';
import { useToolbarPluginButtons, dispatchPluginUiClick } from '../../hooks/usePluginUi';
import { DEV_FEATURES_ENABLED } from '../../utils/devMode';
import { runSequential } from '../../utils/sequential';
import { isRemotePort } from '../../utils/portCapabilities';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, useDroppable, type DragStartEvent, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import AliasDialog from './AliasDialog';
import GuideCard from './GuideCard';
import SearchBox from './SearchBox';
import SidebarToolbar from './SidebarToolbar';
import SortablePortItem from './SortablePortItem';
import GroupItem from './GroupItem';
import RemoteHostsSection from './RemoteHostsSection';
import { SidebarActionsProvider, type SidebarActions } from './SidebarActions';
import GroupToolDialog from '../shared/GroupToolDialog';
import ConfirmDialog from '../shared/ConfirmDialog';
import { notifyError, notifyInfo, notifySuccess } from '../../stores/useToastStore';
import { createEmptyGroup, createGroupWithPort } from './groupActions';
import { usePortDragEnd, UNGROUPED_DROPPABLE_ID } from './hooks/usePortDragEnd';
import type { SerialPort } from '../../types';

/**
 * Module-level droppable wrapper for the "Ungrouped" section. When all ports
 * belong to groups, stays mounted as a compact drop zone during a grouped-port
 * drag so users can drag ports back to ungrouped.
 */
const UngroupedSection: React.FC<{
  ports: SerialPort[];
  portIds: string[];
  activePortId: string | null;
  showEmptyDropHint: boolean;
}> = ({ ports, portIds, activePortId, showEmptyDropHint }) => {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: UNGROUPED_DROPPABLE_ID });

  return (
    <div
      ref={setNodeRef}
      className={`sidebar-section sidebar-ungrouped-section${isOver ? ' drop-active' : ''}`}
    >
      <div className="sidebar-section-header eyebrow">{t('sidebar.section.ungrouped')}</div>
      {ports.length > 0 ? (
        <SortableContext items={portIds} strategy={verticalListSortingStrategy}>
          {ports.map(port => (
            <SortablePortItem
              key={port.id}
              port={port}
              isActive={activePortId === port.id}
              isConnected={port.status === 'connected'}
            />
          ))}
        </SortableContext>
      ) : showEmptyDropHint ? (
        <div className="sidebar-ungrouped-drop-hint">{t('sidebar.ungrouped.dropHint')}</div>
      ) : null}
    </div>
  );
};

/**
 * 串口机架（侧边栏）。容器只做三件事：编排 store/hook 的数据、把动作交给
 * `SidebarActionsProvider`（取代原先逐层透传的 10 个回调）、把列表切成
 * 「分组 / 未分组 / 隐藏」三段。工具栏、搜索框、端口行、组头各自成文件。
 */

const Sidebar: React.FC = () => {
  const { t } = useTranslation();
  const ports = useAppStore((s) => s.ports);
  const portOrder = useAppStore((s) => s.portOrder);
  const groups = useAppStore((s) => s.groups);
  // Selection is an explicit active-tab derivation; it must not follow the
  // connected port or fall back to the last port in the rack.
  const activePortId = useAppStore((s) => getActivePortId(s));
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
  const [refreshing, setRefreshing] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [draggingGroupedPort, setDraggingGroupedPort] = useState(false);
  const [bulkConfirm, setBulkConfirm] = useState<{ mode: 'open' | 'close'; portIds: string[] } | null>(null);
  const pluginButtons = useToolbarPluginButtons();
  const [search, setSearch] = useState('');
  const [aliasDialog, setAliasDialog] = useState<{ portId: string; currentAlias: string } | null>(null);

  const handleOpenTab = useCallback((portId: string) => {
    const state = useAppStore.getState();
    if (findSerialTabByPortId(state, portId)?.id === state.activeTabId) return;
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
    const id = createEmptyGroup(t('sidebar.addGroup.defaultName'));
    setEditingGroupId(id);
  }, [t]);

  const handleRefresh = useCallback(() => {
    if (refreshing) return;
    setRefreshing(true);
    void Promise.resolve(refreshPorts()).finally(() => setRefreshing(false));
  }, [refreshPorts, refreshing]);

  const handleRenameGroup = useCallback((groupId: string, name: string) => {
    updateGroup(groupId, { name });
  }, [updateGroup]);

  const handleRemoveGroup = useCallback((groupId: string) => {
    useAppStore.getState().removeGroup(groupId);
  }, []);

  const handleOpenCollaboration = useCallback(() => {
    const sys = useSystemStore.getState();
    sys.setConfigActiveTab('collaboration');
    sys.toggleConfigModal(true);
  }, []);

  const handleReclaimLoan = useCallback(async (portId: string) => {
    try {
      const recovery = await controlService.reclaimPortLoan(portId);
      if (recovery.error) {
        notifyError(recovery.error);
      } else {
        notifySuccess('collaboration.loan.reclaimed');
      }
      void refreshPorts();
    } catch (err) {
      notifyError(err);
    }
  }, [refreshPorts]);

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
    reclaimLoan: handleReclaimLoan,
  }), [
    handleOpenTab, toggleConnection, handleSetAlias, handleHidePort, handleShowPort,
    runTool, killTool, configTool, runToolForGroup, handleToggleExpand, handleRenameGroup,
    handleRemoveGroup, handleReclaimLoan, t,
  ]);

  const filteredPorts = useMemo(() => {
    if (!search) return ports;
    const searchLower = search.toLowerCase();
    return ports.filter(p =>
      p.id.toLowerCase().includes(searchLower)
      || p.alias?.toLowerCase().includes(searchLower)
      || p.manufacturer?.toLowerCase().includes(searchLower)
      || p.product?.toLowerCase().includes(searchLower)
      || p.remotePortId?.toLowerCase().includes(searchLower)
      || p.hostLabel?.toLowerCase().includes(searchLower)
    );
  }, [ports, search]);

  const localPorts = useMemo(() => ports.filter(p => !isRemotePort(p)), [ports]);
  const filteredLocalPorts = useMemo(() => filteredPorts.filter(p => !isRemotePort(p)), [filteredPorts]);
  const filteredRemotePorts = useMemo(() => filteredPorts.filter(isRemotePort), [filteredPorts]);

  // Hidden ports never appear in their normal location (group / ungrouped);
  // they surface ONLY in the dedicated hidden section when toggled visible.
  // (Previously they double-rendered — once here and once in the hidden
  // section — producing duplicate @dnd-kit ids and broken dragging.)
  const ungroupedPorts = filteredLocalPorts.filter(p => !p.groupId && !p.isHidden);
  const ungroupedIds = useMemo(() => ungroupedPorts.map(p => p.id), [ungroupedPorts]);
  const hiddenPorts = useMemo(() => localPorts.filter(p => p.isHidden), [localPorts]);
  const filteredHiddenPorts = useMemo(() => filteredLocalPorts.filter(p => p.isHidden), [filteredLocalPorts]);
  const hiddenIds = useMemo(() => filteredHiddenPorts.map(p => p.id), [filteredHiddenPorts]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  // Numeric sorting is a one-shot action; polling preserves the selected order.
  const handleSortByPort = useCallback(() => {
    useAppStore.getState().sortPortsByNumber();
  }, []);

  const handleSortByAdded = useCallback(() => {
    // Commit the intent only after a successful refresh: switching to `added`
    // while enumeration fails would highlight "added order" while the list
    // still shows the manual arrangement.
    void refreshPorts().then((applied) => {
      if (applied) useAppStore.getState().setPortOrder('added');
    });
  }, [refreshPorts]);
  // 批量开/关：串行 + 100ms 间隔，避免并发 open/close 在后端抢串口句柄。
  // 范围只取当前搜索可见的本地端口（隐藏端口与远程端口不在“全部”批操作内）。
  const visiblePorts = useMemo(
    () => filteredLocalPorts.filter(port => !port.isHidden),
    [filteredLocalPorts],
  );

  const runBulk = useCallback((mode: 'open' | 'close', portIds: string[]) => {
    const targets = useAppStore.getState().ports.filter(port => portIds.includes(port.id));
    if (targets.length === 0) return;
    void runSequential(targets, (port) => toggleConnection(port.id)).then(() => {
      notifyInfo(t(mode === 'open' ? 'sidebar.bulk.openDone' : 'sidebar.bulk.closeDone', {
        count: targets.length,
      }));
    });
  }, [toggleConnection, t]);

  const handleOpenAll = useCallback(() => {
    const pending = visiblePorts.filter(p => p.status !== 'connected' && p.status !== 'connecting');
    if (pending.length === 0) return;
    setBulkConfirm({ mode: 'open', portIds: pending.map(p => p.id) });
  }, [visiblePorts]);

  const handleCloseAll = useCallback(() => {
    const connected = visiblePorts.filter(p => p.status === 'connected');
    if (connected.length === 0) return;
    setBulkConfirm({ mode: 'close', portIds: connected.map(p => p.id) });
  }, [visiblePorts]);

  const portDragEnd = usePortDragEnd();

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const activeId = String(event.active.id);
    const port = useAppStore.getState().ports.find(p => p.id === activeId);
    setDraggingGroupedPort(Boolean(port?.groupId));
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setDraggingGroupedPort(false);
    portDragEnd(event);
  }, [portDragEnd]);

  const handleDragCancel = useCallback(() => {
    setDraggingGroupedPort(false);
  }, []);

  const hiddenMatchedCount = search ? filteredHiddenPorts.length : 0;

  return (
    <SidebarActionsProvider actions={actions}>
      <div className="sidebar">
        <SidebarToolbar
          showHidden={showHidden}
          hiddenCount={hiddenPorts.length}
          onToggleHidden={() => setShowHidden(!showHidden)}
          refreshing={refreshing}
          onRefresh={handleRefresh}
          simulationMode={simulationMode}
          simulationAvailable={DEV_FEATURES_ENABLED}
          onToggleSimulation={toggleSimulation}
          gitBashMode={gitBashMode}
          gitBashAvailable={DEV_FEATURES_ENABLED}
          onToggleGitBash={toggleGitBashSim}
          onOpenAll={handleOpenAll}
          onCloseAll={handleCloseAll}
          canOpenAll={visiblePorts.some(port => port.status !== 'connected' && port.status !== 'connecting')}
          canCloseAll={visiblePorts.some(port => port.status === 'connected')}
          onSortByPort={handleSortByPort}
          onSortByAdded={handleSortByAdded}
          addedOrderActive={portOrder === 'added'}
          pluginButtons={pluginButtons}
          onPluginClick={(reg, buttonId) => dispatchPluginUiClick(reg, buttonId, { portId: getActivePortId(useAppStore.getState()) ?? undefined })}
          onOpenCollaboration={handleOpenCollaboration}
        />
        <SearchBox value={search} onChange={setSearch} />

        <div className="sidebar-list">
          {/* 空端口引导卡片：任意端口（真实/SIM）出现后条件不成立自动消失。
              位于 DndContext 之外，不影响端口拖拽排序。 */}
          {ports.length === 0 && !simulationMode && (
            <GuideCard onEnableSimulation={toggleSimulation} simulationAvailable={DEV_FEATURES_ENABLED} />
          )}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            {groups.map(group => {
              const groupPorts = filteredLocalPorts.filter(p => group.portIds.includes(p.id) && !p.isHidden);
              if (groupPorts.length === 0 && search) return null;
              return (
                <GroupItem
                  key={group.id}
                  group={group}
                  ports={filteredLocalPorts}
                  autoRename={editingGroupId === group.id}
                  onRenameEnd={() => setEditingGroupId((cur) => (cur === group.id ? null : cur))}
                />
              );
            })}

            {(ungroupedPorts.length > 0 || draggingGroupedPort) && (
              <UngroupedSection
                ports={ungroupedPorts}
                portIds={ungroupedIds}
                activePortId={activePortId}
                showEmptyDropHint={draggingGroupedPort && ungroupedPorts.length === 0}
              />
            )}

            {showHidden && filteredHiddenPorts.length > 0 && (
              <div className="sidebar-section">
                <div className="sidebar-section-header eyebrow">{t('sidebar.section.hidden')}</div>
                <SortableContext items={hiddenIds} strategy={verticalListSortingStrategy}>
                  {filteredHiddenPorts.map(port => (
                    <SortablePortItem
                      key={port.id}
                      port={port}
                      isActive={activePortId === port.id}
                      isConnected={port.status === 'connected'}
                    />
                  ))}
                </SortableContext>
              </div>
            )}
          </DndContext>

          <RemoteHostsSection
            remotePorts={filteredRemotePorts}
            activePortId={activePortId}
            searchActive={Boolean(search.trim())}
            onOpenManage={handleOpenCollaboration}
            onRefreshPorts={refreshPorts}
          />

          {search && visiblePorts.length === 0 && filteredRemotePorts.length === 0 && (!showHidden || hiddenMatchedCount === 0) && (
            <div className="sidebar-no-results" role="status">
              <span>
                {!showHidden && hiddenMatchedCount > 0
                  ? t('sidebar.search.hiddenMatches', { count: hiddenMatchedCount })
                  : t('sidebar.search.noResults')}
              </span>
              <div className="sidebar-no-results-actions">
                {!showHidden && hiddenMatchedCount > 0 && (
                  <button type="button" className="btn btn-sm" onClick={() => setShowHidden(true)}>
                    {t('sidebar.toolbar.showHidden')}
                  </button>
                )}
                <button type="button" className="btn btn-sm" onClick={() => setSearch('')}>
                  {t('sidebar.search.clear')}
                </button>
              </div>
            </div>
          )}

          <div className="sidebar-add-group">
            <button type="button" className="btn sidebar-add-group-btn" onClick={handleAddGroup}>
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
        <ConfirmDialog
          open={bulkConfirm !== null}
          title={t(bulkConfirm?.mode === 'open' ? 'sidebar.bulk.openAllTitle' : 'sidebar.bulk.closeAllTitle')}
          message={t(bulkConfirm?.mode === 'open' ? 'sidebar.bulk.openAllMessage' : 'sidebar.bulk.closeAllMessage', {
            count: bulkConfirm?.portIds.length ?? 0,
          })}
          confirmLabel={t('confirmDialog.confirm')}
          cancelLabel={t('confirmDialog.cancel')}
          danger={bulkConfirm?.mode === 'close'}
          onConfirm={() => {
            const pending = bulkConfirm;
            setBulkConfirm(null);
            if (pending) runBulk(pending.mode, pending.portIds);
          }}
          onCancel={() => setBulkConfirm(null)}
        />
      </div>
    </SidebarActionsProvider>
  );
};

export default Sidebar;
