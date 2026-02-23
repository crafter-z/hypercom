import { Minus, Plus } from 'lucide-react';
import { useSettingsStore } from '../../stores';

const FONT_FAMILIES = [
  { value: 'JetBrains Mono', label: 'JetBrains Mono' },
  { value: 'Fira Code', label: 'Fira Code' },
  { value: 'Consolas', label: 'Consolas' },
  { value: 'Monaco', label: 'Monaco' },
  { value: 'Source Code Pro', label: 'Source Code Pro' },
  { value: 'Courier New', label: 'Courier New' },
];

const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24];

export function FontSettings() {
  const { settings, setFontSize, updateDisplay } = useSettingsStore();
  const { fontSize, fontFamily } = settings.display;

  const handleFontSizeChange = (newSize: number) => {
    if (newSize >= 10 && newSize <= 24) {
      setFontSize(newSize);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h4 className="text-sm font-medium mb-3">字体设置</h4>
        
        {/* 字体大小 */}
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">字体大小</label>
          <div className="flex items-center gap-3">
            <button
              onClick={() => handleFontSizeChange(fontSize - 1)}
              disabled={fontSize <= 10}
              className="p-1.5 rounded border hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Minus size={14} />
            </button>
            
            <div className="flex-1 flex items-center gap-2">
              <input
                type="range"
                min={10}
                max={24}
                value={fontSize}
                onChange={(e) => handleFontSizeChange(Number(e.target.value))}
                className="flex-1 h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-primary"
              />
              <span className="w-12 text-center text-sm font-mono">{fontSize}px</span>
            </div>
            
            <button
              onClick={() => handleFontSizeChange(fontSize + 1)}
              disabled={fontSize >= 24}
              className="p-1.5 rounded border hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        {/* 字体家族 */}
        <div className="mt-4 space-y-2">
          <label className="text-xs text-muted-foreground">字体家族</label>
          <select
            value={fontFamily}
            onChange={(e) => updateDisplay({ fontFamily: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            {FONT_FAMILIES.map((font) => (
              <option key={font.value} value={font.value}>
                {font.label}
              </option>
            ))}
          </select>
        </div>

        {/* 预览 */}
        <div className="mt-4 space-y-2">
          <label className="text-xs text-muted-foreground">预览</label>
          <div
            className="p-3 rounded-lg border bg-muted/30 font-mono"
            style={{
              fontSize: `${fontSize}px`,
              fontFamily: fontFamily,
            }}
          >
            <div className="text-muted-foreground">/* 数据预览 */</div>
            <div>
              <span className="text-primary">RX</span> [2024-01-15 10:30:45.123]{' '}
              <span className="text-green-500">48 65 6C 6C 6F</span>
            </div>
            <div>
              <span className="text-orange-500">TX</span> [2024-01-15 10:30:45.456]{' '}
              <span className="text-green-500">57 6F 72 6C 64</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
