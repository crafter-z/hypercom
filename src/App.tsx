import { useEffect, useState } from 'react';
import { Header } from './components/layout';
import { SerialConfig, DataDisplay, SendInput } from './components/serial';
import { CommandSidebar } from './components/commands';
import { useSettingsStore, initSerialEventListeners } from './stores';

function App() {
  const { loadSettings } = useSettingsStore();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    // 初始化设置
    loadSettings();
    // 初始化串口事件监听
    initSerialEventListeners();
  }, [loadSettings]);

  return (
    <div className="h-screen flex bg-background text-foreground">
      {/* 命令组侧边栏 */}
      <CommandSidebar
        isCollapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
      />

      {/* 主内容区 */}
      <div className="flex-1 flex flex-col min-w-0">
        <Header />
        <main className="flex-1 flex flex-col min-h-0">
          <SerialConfig />
          <DataDisplay />
          <SendInput />
        </main>
      </div>
    </div>
  );
}

export default App;
