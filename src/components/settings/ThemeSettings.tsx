import { Sun, Moon, Monitor } from 'lucide-react';
import { useSettingsStore } from '../../stores';
import type { DisplaySettings } from '../../types';

type Theme = DisplaySettings['theme'];

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: '亮色', icon: Sun },
  { value: 'dark', label: '暗色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
];

export function ThemeSettings() {
  const { settings, setTheme } = useSettingsStore();
  const { theme } = settings.display;

  return (
    <div className="space-y-4">
      <h4 className="text-sm font-medium">主题设置</h4>
      
      <div className="grid grid-cols-3 gap-3">
        {THEME_OPTIONS.map((option) => {
          const Icon = option.icon;
          const isSelected = theme === option.value;
          
          return (
            <button
              key={option.value}
              onClick={() => setTheme(option.value)}
              className={`flex flex-col items-center gap-2 p-4 rounded-lg border transition-all ${
                isSelected
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border hover:border-primary/50 hover:bg-accent/50'
              }`}
            >
              <Icon size={24} />
              <span className="text-xs font-medium">{option.label}</span>
            </button>
          );
        })}
      </div>

      {/* 主题预览 */}
      <div className="mt-4 space-y-2">
        <label className="text-xs text-muted-foreground">预览</label>
        <div className="p-3 rounded-lg border bg-muted/30">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-3 h-3 rounded-full bg-red-500" />
            <div className="w-3 h-3 rounded-full bg-yellow-500" />
            <div className="w-3 h-3 rounded-full bg-green-500" />
          </div>
          <div className="space-y-1 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-primary">●</span>
              <span>串口已连接</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-green-500">●</span>
              <span>数据接收中...</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
