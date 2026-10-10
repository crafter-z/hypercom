import React, { useSyncExternalStore } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { getTabContentPlacements, subscribeTabContentPlacement } from '../../utils/tabContentPlacement';
import TerminalView from './TerminalView';
import TtyView from './TtyView';

/** Own serial component instances outside the changing pane tree. */
const SerialContentHost: React.FC = () => {
  const tabs = useAppStore(state => state.tabs);
  const ports = useAppStore(state => state.ports);
  const placements = useSyncExternalStore(subscribeTabContentPlacement, getTabContentPlacements);
  return <div className="serial-content-host">
    {tabs.filter(tab => tab.kind === 'serial' && !tab.poppedOut).map(tab => {
      if (tab.kind !== 'serial') return null;
      const placement = placements[tab.id];
      const visible = placement?.visible === true && placement.stockVisible;
      const rect = placement?.rect ?? { x: 0, y: 0, width: 0, height: 0 };
      const tty = ports.find(port => port.id === tab.portId)?.mode === 'tty';
      return <div key={tab.id} className="serial-content-layer" data-port-id={tab.portId} data-tab-id={tab.id} style={{
        left: rect.x, top: rect.y, width: rect.width, height: rect.height,
        display: visible ? 'flex' : 'none',
      }} onPointerDown={() => useAppStore.getState().setActiveTab(tab.id)}>
        {tty ? <TtyView portId={tab.portId} hidden={!visible} /> : <TerminalView portId={tab.portId} hidden={!visible} />}
      </div>;
    })}
  </div>;
};
export default SerialContentHost;
