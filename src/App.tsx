import React from 'react';
import TitleBar from './components/TitleBar/TitleBar';
import Sidebar from './components/Sidebar/Sidebar';
import MainDisplay from './components/MainDisplay/MainDisplay';
import OperationPanel from './components/OperationPanel/OperationPanel';
import StatusBar from './components/StatusBar/StatusBar';
import ConfigModal from './components/ConfigModal/ConfigModal';
import { useAppInit } from './hooks/useTauri';

const App: React.FC = () => {
  useAppInit();

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        minWidth: 720,
        minHeight: 480,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--bg-primary)',
      }}
    >
      <TitleBar />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minWidth: 0 }}>
        <Sidebar />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 400 }}>
          <MainDisplay />
          <OperationPanel />
        </div>
      </div>

      <StatusBar />
      <ConfigModal />
    </div>
  );
};

export default App;