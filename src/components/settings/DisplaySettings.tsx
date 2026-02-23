import { useSettingsStore } from '../../stores';
import type { DisplaySettings } from '../../types';

type DisplayFormat = DisplaySettings['displayFormat'];

const FORMAT_OPTIONS: { value: DisplayFormat; label: string; description: string }[] = [
  { value: 'hex', label: 'HEX', description: '十六进制格式 (48 65 6C 6C 6F)' },
  { value: 'ascii', label: 'ASCII', description: 'ASCII 文本格式 (Hello)' },
  { value: 'mixed', label: '混合', description: '同时显示 HEX 和 ASCII' },
];

export function DisplaySettings() {
  const { settings, updateDisplay } = useSettingsStore();
  const { displayFormat, showTimestamp, showDirection } = settings.display;

  return (
    <div className="space-y-4">
      <h4 className="text-sm font-medium">显示设置</h4>

      {/* 显示格式 */}
      <div className="space-y-2">
        <label className="text-xs text-muted-foreground">数据格式</label>
        <div className="grid grid-cols-3 gap-2">
          {FORMAT_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => updateDisplay({ displayFormat: option.value })}
              className={`flex flex-col items-center p-2 rounded-lg border transition-all ${
                displayFormat === option.value
                  ? 'border-primary bg-primary/10'
                  : 'border-border hover:border-primary/50'
              }`}
            >
              <span className="text-sm font-medium">{option.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 显示选项 */}
      <div className="space-y-3">
        <label className="text-xs text-muted-foreground">显示选项</label>

        <label className="flex items-center justify-between cursor-pointer">
          <span className="text-sm">显示时间戳</span>
          <input
            type="checkbox"
            checked={showTimestamp}
            onChange={(e) => updateDisplay({ showTimestamp: e.target.checked })}
            className="w-4 h-4 rounded border accent-primary"
          />
        </label>

        <label className="flex items-center justify-between cursor-pointer">
          <span className="text-sm">显示数据方向 (RX/TX)</span>
          <input
            type="checkbox"
            checked={showDirection}
            onChange={(e) => updateDisplay({ showDirection: e.target.checked })}
            className="w-4 h-4 rounded border accent-primary"
          />
        </label>
      </div>

      {/* 预览 */}
      <div className="space-y-2">
        <label className="text-xs text-muted-foreground">预览</label>
        <div className="p-3 rounded-lg border bg-muted/30 font-mono text-sm">
          {showTimestamp && (
            <span className="text-muted-foreground">[2024-01-15 10:30:45.123] </span>
          )}
          {showDirection && (
            <span className="text-primary">RX </span>
          )}
          {displayFormat === 'hex' && (
            <span className="text-green-500">48 65 6C 6C 6F</span>
          )}
          {displayFormat === 'ascii' && (
            <span className="text-green-500">Hello</span>
          )}
          {displayFormat === 'mixed' && (
            <>
              <span className="text-green-500">48 65 6C 6C 6F</span>
              <span className="text-muted-foreground"> | </span>
              <span className="text-blue-500">Hello</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
