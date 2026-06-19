import React, { useEffect, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useOperationStore } from '../../stores/useOperationStore';
import { logService } from '../../services/tauri';
import { save } from '@tauri-apps/plugin-dialog';
import { Pin, Clock, FileText, FolderOpen, FileSearch } from 'lucide-react';
import type { DataBits, Parity, StopBits, Handshake } from '../../types';

export interface ParamsSectionProps {
  isPortActive: boolean;
  isConnected: boolean;
  activeTabId: string | null;
}

const ParamsSection: React.FC<ParamsSectionProps> = ({ isPortActive, isConnected, activeTabId }) => {
  const baudRate = useOperationStore(s => s.baudRate);
  const dataBits = useOperationStore(s => s.dataBits);
  const parity = useOperationStore(s => s.parity);
  const stopBits = useOperationStore(s => s.stopBits);
  const handshake = useOperationStore(s => s.handshake);
  const dtr = useOperationStore(s => s.dtr);
  const rts = useOperationStore(s => s.rts);
  const ignoreEmptyChars = useOperationStore(s => s.ignoreEmptyChars);
  const scrollLocked = useOperationStore(s => s.scrollLocked);
  const showTimestamp = useOperationStore(s => s.showTimestamp);
  const displayFormat = useOperationStore(s => s.displayFormat);
  const config = useAppStore(s => s.config);
  const setOpState = useOperationStore(s => s.setOpState);

  const [isCustomBaud, setIsCustomBaud] = useState(!config.defaultBaudRates.includes(baudRate));

  useEffect(() => {
    setIsCustomBaud(!config.defaultBaudRates.includes(baudRate));
  }, [baudRate, config.defaultBaudRates]);

  const handleSaveLogAs = async () => {
    if (!activeTabId) return;
    try {
      const filePath = await save({
        title: '另存日志',
        defaultPath: `${activeTabId}.log`,
        filters: [{ name: '日志文件', extensions: ['log', 'txt'] }],
      });
      if (filePath) await logService.saveLogAs(activeTabId, filePath);
    } catch (e) { console.error('Failed to save log:', e); }
  };

  const handleOpenLogFile = async () => {
    if (!activeTabId) return;
    try {
      const files = await logService.getLogFiles();
      const candidates = files.filter(f => f.port_id === activeTabId);
      const match = candidates.length > 0
        ? candidates.reduce((newest, f) => f.created_at > newest.created_at ? f : newest)
        : undefined;
      if (match) { await logService.openPath(match.path); }
    } catch (e) { console.error('Failed to open log file:', e); }
  };

  const handleOpenLogDir = async () => {
    try { await logService.openLogDirectory(); }
    catch (e) { console.error('Failed to open log dir:', e); }
  };

  return (
    <div className="op-section op-section-params">
      <div className="panel-card-title">视图 & 日志 & 参数</div>

      <div className="op-checkbox-row">
        <label className="checkbox-wrapper">
          <input type="checkbox" checked={scrollLocked} onChange={e => setOpState({ scrollLocked: e.target.checked })} />
          <Pin size={12} /> 滚动锁定
        </label>
        <label className="checkbox-wrapper">
          <input type="checkbox" checked={showTimestamp} onChange={e => setOpState({ showTimestamp: e.target.checked })} />
          <Clock size={12} /> 时间戳
        </label>
      </div>

      <div className="op-radio-row">
        <span className="op-label">显示:</span>
        <label className="checkbox-wrapper">
          <input type="radio" name="displayFormat" checked={displayFormat === 'hex'} onChange={() => setOpState({ displayFormat: 'hex' })} />
          HEX
        </label>
        <label className="checkbox-wrapper">
          <input type="radio" name="displayFormat" checked={displayFormat === 'string'} onChange={() => setOpState({ displayFormat: 'string' })} />
          文本
        </label>
      </div>

      <div className="op-btn-row">
        <button className="btn btn-sm" style={{ flex: 1 }} disabled={!isPortActive} onClick={handleSaveLogAs}><FileText size={12} /> 另存为</button>
        <button className="btn btn-sm" style={{ flex: 1 }} disabled={!isPortActive} onClick={handleOpenLogFile}><FolderOpen size={12} /> 打开文件</button>
        <button className="btn btn-sm" style={{ flex: 1 }} onClick={handleOpenLogDir}><FileSearch size={12} /> 目录</button>
      </div>

      <div className="divider-h" />

      <div className="op-params-grid">
        <div className="op-param-item">
          <span className="op-label">波特率:</span>
          <select className="select op-param-select" disabled={!isConnected} value={isCustomBaud ? '__custom__' : baudRate}
            onChange={e => {
              if (e.target.value === '__custom__') { setIsCustomBaud(true); }
              else { setIsCustomBaud(false); setOpState({ baudRate: Number(e.target.value) }); }
            }}>
            {config.defaultBaudRates.map(rate => <option key={rate} value={rate}>{rate}</option>)}
            <option value="__custom__">其他...</option>
          </select>
          {isCustomBaud && (
            <input className="input" type="number" disabled={!isConnected} style={{ width: 80, marginLeft: 4 }}
              value={baudRate} onChange={e => setOpState({ baudRate: Number(e.target.value) || 9600 })}
              min={50} max={4000000} step={100} />
          )}
        </div>
        <div className="op-param-item">
          <span className="op-label">数据位:</span>
          <select className="select op-param-select" disabled={!isConnected} value={dataBits} onChange={e => setOpState({ dataBits: Number(e.target.value) as DataBits })}>
            <option value={5}>5</option><option value={6}>6</option><option value={7}>7</option><option value={8}>8</option>
          </select>
        </div>
        <div className="op-param-item">
          <span className="op-label">校验:</span>
          <select className="select op-param-select" disabled={!isConnected} value={parity} onChange={e => setOpState({ parity: e.target.value as Parity })}>
            <option>None</option><option>Even</option><option>Odd</option><option>Mark</option><option>Space</option>
          </select>
        </div>
        <div className="op-param-item">
          <span className="op-label">停止位:</span>
          <select className="select op-param-select" disabled={!isConnected} value={stopBits} onChange={e => setOpState({ stopBits: e.target.value as StopBits })}>
            <option value="One">1</option><option value="OnePointFive">1.5</option><option value="Two">2</option>
          </select>
        </div>
        <div className="op-param-item" style={{ gridColumn: '1 / -1' }}>
          <span className="op-label">握手:</span>
          <select className="select op-param-select" disabled={!isConnected} value={handshake} onChange={e => setOpState({ handshake: e.target.value as Handshake })}>
            <option value="None">None</option><option value="XonXoff">Xon/Xoff</option>
            <option value="RequestToSend">RTS/CTS</option><option value="RequestToSendXonXoff">RTS/CTS+Xon/Xoff</option>
          </select>
        </div>
      </div>

      <div className="op-checkbox-row" style={{ marginTop: 4 }}>
        <label className="checkbox-wrapper"><input type="checkbox" disabled={!isConnected} checked={dtr} onChange={e => setOpState({ dtr: e.target.checked })} /> DTR</label>
        <label className="checkbox-wrapper"><input type="checkbox" disabled={!isConnected} checked={rts} onChange={e => setOpState({ rts: e.target.checked })} /> RTS</label>
        <label className="checkbox-wrapper" style={{ fontSize: 11 }}><input type="checkbox" disabled={!isConnected} checked={ignoreEmptyChars} onChange={e => setOpState({ ignoreEmptyChars: e.target.checked })} /> 忽略空字符</label>
      </div>
    </div>
  );
};

export default ParamsSection;
