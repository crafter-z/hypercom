import { useEffect } from 'react';
import { Header } from './components/layout';
import { SerialConfig, DataDisplay, SendInput } from './components/serial';
import { useSettingsStore, initSerialEventListeners } from './stores';

function App() {
  const { loadSettings } = useSettingsStore();

  useEffect(() => {
    // 初始化设置
    loadSettings();
    // 初始化串口事件监听
    initSerialEventListeners();
  }, [loadSettings]);

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <Header />
      <main className="flex-1 flex flex-col min-h-0">
        <SerialConfig />
        <DataDisplay />
        <SendInput />
      </main>
    </div>
  );
}

export default App;
