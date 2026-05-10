/**
 * HyperCom 主应用入口
 * 整体布局：标题栏 + (侧边栏 + 主显示区 + 操作区) + 状态栏
 */

import React from 'react';
import TitleBar from './components/TitleBar/TitleBar';
import Sidebar from './components/Sidebar/Sidebar';
import MainDisplay from './components/MainDisplay/MainDisplay';
import OperationPanel from './components/OperationPanel/OperationPanel';
import StatusBar from './components/StatusBar/StatusBar';
import ConfigModal from './components/ConfigModal/ConfigModal';

const App: React.FC = () => {
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
      {/* 标题栏 */}
      <TitleBar />

      {/* 主体内容区 */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minWidth: 0 }}>
        {/* 左侧串口管理边栏 */}
        <Sidebar />

        {/* 中间主区域 */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 400 }}>
          {/* 主显示窗口 */}
          <MainDisplay />

          {/* 底部操作面板 */}
          <OperationPanel />
        </div>
      </div>

      {/* 底部状态栏 */}
      <StatusBar />

      {/* 配置弹窗 */}
      <ConfigModal />
    </div>
  );
};

export default App;
