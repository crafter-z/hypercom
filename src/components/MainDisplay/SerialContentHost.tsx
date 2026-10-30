import React, { useSyncExternalStore } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { getTabContentPlacements, subscribeTabContentPlacement } from '../../utils/tabContentPlacement';
import TerminalView from './TerminalView';
import TtyView from './TtyView';
import ReplayView from './ReplayView';

/** Own stock source instances outside the changing pane tree. */
const SerialContentHost: React.FC = () => {
  const tabs = useAppStore(state => state.tabs);
  const ports = useAppStore(state => state.ports);
  const placements = useSyncExternalStore(subscribeTabContentPlacement, getTabContentPlacements);
  return <div className="serial-content-host">
    {tabs.map(tab => {
      if (tab.kind === 'plugin' || (tab.kind === 'serial' && tab.poppedOut)) return null;
      const placement = placements[tab.id];
      const visible = placement?.visible === true && placement.stockVisible;
      const rect = placement?.rect ?? { x: 0, y: 0, width: 0, height: 0 };
      const portId = tab.kind === 'serial' ? tab.portId : undefined;
      const tty = ports.find(port => port.id === portId)?.mode === 'tty';
      return <div key={tab.id} className="serial-content-layer" data-port-id={portId} data-tab-id={tab.id} style={{
        left: rect.x, top: rect.y, width: rect.width, height: rect.height,
        display: visible ? 'flex' : 'none',
      }} onPointerDown={() => useAppStore.getState().setActiveTab(tab.id)}>
        {tab.kind === 'replay' ? <ReplayView tab={tab} hidden={!visible} />
          : tty ? <TtyView portId={tab.portId} hidden={!visible} />
          : <TerminalView tabId={tab.id} portId={tab.portId} timelineEnabled={placement?.stockVisible !== false} hidden={!visible} />}
      </div>;
    })}
  </div>;
};
export default SerialContentHost;
