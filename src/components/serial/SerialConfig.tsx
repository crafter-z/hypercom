import { useSerialStore } from '../../stores';
import { BAUD_RATES, DATA_BITS_OPTIONS, STOP_BITS_OPTIONS } from '../../types';

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
            title="波特率"
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
            title="数据位"
            className="h-8 px-2 rounded-md border border-input bg-background text-sm"
            value={config.dataBits}
            onChange={(e) => setConfig({ dataBits: e.target.value as 'five' | 'six' | 'seven' | 'eight' })}
          >
            {DATA_BITS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {/* 停止位 */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">停止位</label>
          <select
            title="停止位"
            className="h-8 px-2 rounded-md border border-input bg-background text-sm"
            value={config.stopBits}
            onChange={(e) => setConfig({ stopBits: e.target.value as 'one' | 'two' })}
          >
            {STOP_BITS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {/* 校验位 */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">校验位</label>
          <select
            title="校验位"
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
