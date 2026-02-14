import { useEffect, useState } from 'react';
import { Settings, RefreshCw, Usb, AlertCircle, X } from 'lucide-react';
import { useSerialStore, useSettingsStore } from '../../stores';
import { cn } from '../../utils';

export function Header() {
  const { ports, status, error, refreshPorts, config, connect, disconnect, setError } = useSerialStore();
  const { settings, setTheme } = useSettingsStore();
  const [showError, setShowError] = useState(false);

  useEffect(() => {
    refreshPorts();
  }, [refreshPorts]);

  useEffect(() => {
    if (error) {
      setShowError(true);
    }
  }, [error]);

  const handleConnect = async () => {
    if (status === 'open') {
      await disconnect();
    } else {
      await connect(config);
    }
  };

  const handleDismissError = () => {
    setShowError(false);
    setError(null);
  };

  return (
    <header className="h-14 border-b border-border bg-background px-4 flex items-center justify-between">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold text-primary flex items-center gap-2">
          <Usb className="w-5 h-5" />
          HyperCom
        </h1>
        
        {/* 串口选择 */}
        <div className="flex items-center gap-2">
          <select
            title="选择串口"
            className="h-8 px-2 rounded-md border border-input bg-background text-sm"
            value={config.portName}
            onChange={(e) => useSerialStore.getState().setConfig({ portName: e.target.value })}
          >
            <option value="">选择串口</option>
            {ports.map((port) => (
              <option key={port.name} value={port.name}>
                {port.name} {port.manufacturer ? `(${port.manufacturer})` : ''}
              </option>
            ))}
          </select>
          
          <button
            title="刷新串口列表"
            onClick={refreshPorts}
            className="h-8 w-8 flex items-center justify-center rounded-md border border-input hover:bg-accent"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {/* 连接按钮 */}
        <button
          onClick={handleConnect}
          className={cn(
            "h-8 px-4 rounded-md text-sm font-medium transition-colors",
            status === 'open'
              ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
              : "bg-primary text-primary-foreground hover:bg-primary/90"
          )}
        >
          {status === 'open' ? '断开' : '连接'}
        </button>

        {/* 状态指示 */}
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "w-2 h-2 rounded-full",
              status === 'open' ? "bg-green-500" : status === 'error' ? "bg-red-500" : "bg-gray-400"
            )}
          />
          <span className="text-sm text-muted-foreground">
            {status === 'open' ? '已连接' : status === 'error' ? '错误' : '未连接'}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {/* 主题切换 */}
        <select
          title="主题选择"
          className="h-8 px-2 rounded-md border border-input bg-background text-sm"
          value={settings.display.theme}
          onChange={(e) => setTheme(e.target.value as 'light' | 'dark' | 'system')}
        >
          <option value="light">浅色</option>
          <option value="dark">深色</option>
          <option value="system">跟随系统</option>
        </select>

        {/* 设置按钮 */}
        <button title="设置" className="h-8 w-8 flex items-center justify-center rounded-md border border-input hover:bg-accent">
          <Settings className="w-4 h-4" />
        </button>
      </div>

      {/* 错误提示弹窗 */}
      {showError && error && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 max-w-md w-full px-4">
          <div className="bg-destructive text-destructive-foreground rounded-lg shadow-lg p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium">连接错误</p>
              <p className="text-sm mt-1 opacity-90">{error}</p>
            </div>
            <button
              title="关闭"
              onClick={handleDismissError}
              className="shrink-0 hover:opacity-70"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
