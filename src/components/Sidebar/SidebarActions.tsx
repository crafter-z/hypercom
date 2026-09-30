import React, { createContext, useContext } from 'react';
import type { PortGroup } from '../../types';

/**
 * Port/group actions the sidebar rows can trigger.
 *
 * Port rows live two levels down (`Sidebar` → `GroupItem` → `SortablePortItem`),
 * which used to mean ten callbacks threaded through every level — and each new
 * action meant touching three prop interfaces. The rows are rendered by this
 * module's container, so a context carries the actions instead of the props.
 *
 * Group membership rules live here too (`movePortToGroup` /
 * `createGroupWithPort`) so `groupActions.ts` stays the single implementation of
 * "how a group is created".
 */
export interface SidebarActions {
  openTab: (portId: string) => void;
  /** Resolves when the connect/disconnect op settled — batch loops in the
   *  toolbar and the group header `await` it to stay serial (concurrent
   *  open/close races for the same OS handle). */
  toggleConnect: (portId: string) => Promise<void>;
  setAlias: (portId: string) => void;
  hidePort: (portId: string) => void;
  showPort: (portId: string) => void;
  runTool: (portId: string) => void;
  killTool: (portId: string) => void;
  configTool: () => void;
  runToolForGroup: (group: PortGroup) => void;
  movePortToGroup: (portId: string, groupId: string | undefined) => void;
  createGroupWithPort: (portId: string) => void;
  toggleGroupExpand: (groupId: string) => void;
  renameGroup: (groupId: string, name: string) => void;
  removeGroup: (groupId: string) => void;
}

const SidebarActionsContext = createContext<SidebarActions | null>(null);

export const SidebarActionsProvider: React.FC<{
  actions: SidebarActions;
  children: React.ReactNode;
}> = ({ actions, children }) => (
  <SidebarActionsContext.Provider value={actions}>{children}</SidebarActionsContext.Provider>
);

export function useSidebarActions(): SidebarActions {
  const actions = useContext(SidebarActionsContext);
  if (!actions) throw new Error('useSidebarActions must be used inside SidebarActionsProvider');
  return actions;
}
