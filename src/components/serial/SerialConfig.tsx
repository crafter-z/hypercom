import { useSerialStore } from '../../stores';
import { BAUD_RATES } from '../../types';

export function SerialConfig() {
  const { config, setConfig } = useSerialStore();

  return (
    <div className="p-4 border-b border-border">
      <h3 className="text-sm font-medium mb-3">串口配置</h3>
      <div className="grid grid-cols-4 gap-4">
        {/* 波特率 */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">波特率</label>
          <select
            className="h-8 px-2 rounded-md border border-input bg-background text-sm"
            value={config.baudRate}
            onChange={(e) => setConfig({ baudRate: Number(e.target.value) })}
          >
            {BAUD_RATES.map((rate) => (
              <option key={rate} value={rate}>
                {rate}
              </option>
            ))}
          </select>
        </div>

        {/* 数据位 */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">数据位</label>
          <select
            className="h-8 px-2 rounded-md border border-input bg-background text-sm"
            value={config.dataBits}
            onChange={(e) => setConfig({ dataBits: Number(e.target.value) as 5 | 6 | 7 | 8 })}
          >
            <option value={5}>5</option>
            <option value={6}>6</option>
            <option value={7}>7</option>
            <option value={8}>8</option>
          </select>
        </div>

        {/* 停止位 */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">停止位</label>
          <select
            className="h-8 px-2 rounded-md border border-input bg-background text-sm"
            value={config.stopBits}
            onChange={(e) => setConfig({ stopBits: Number(e.target.value) as 1 | 1.5 | 2 })}
          >
            <option value={1}>1</option>
            <option value={1.5}>1.5</option>
            <option value={2}>2</option>
          </select>
        </div>

        {/* 校验位 */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">校验位</label>
          <select
            className="h-8 px-2 rounded-md border border-input bg-background text-sm"
            value={config.parity}
            onChange={(e) => setConfig({ parity: e.target.value as 'none' | 'odd' | 'even' })}
          >
            <option value="none">无</option>
            <option value="odd">奇校验</option>
            <option value="even">偶校验</option>
          </select>
        </div>
      </div>
    </div>
  );
}
