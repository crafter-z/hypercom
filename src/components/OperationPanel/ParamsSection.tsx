import React, { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useOperationStore } from '../../stores/useOperationStore';
import { clearTerminal, releaseViewportManager } from '../../utils/terminal/viewportManager';
import { useTranslation } from 'react-i18next';
import type { DataBits, Parity, StopBits, Handshake, PortPreset, PortMode } from '../../types';
import { storageService } from '../../services/tauri';
import { notifySuccess, notifyError } from '../../stores/useToastStore';
import { getRxPipeline } from '../../utils/rxPipeline';
import { ttyService } from '../../utils/ttyService';
import { Save, Trash2 } from 'lucide-react';

export interface ParamsSectionProps {
  /** True when a port tab is selected (params editable pre-connect so the
   * initial connection baud can be chosen; backend sync stays gated on
   * isConnected inside OperationPanel). */
  isPortActive: boolean;
}

const ParamsSection: React.FC<ParamsSectionProps> = ({ isPortActive }) => {
  const { t } = useTranslation();
  const baudRate = useOperationStore(s => s.baudRate);
  const dataBits = useOperationStore(s => s.dataBits);
  const parity = useOperationStore(s => s.parity);
  const stopBits = useOperationStore(s => s.stopBits);
  const handshake = useOperationStore(s => s.handshake);
  const dtr = useOperationStore(s => s.dtr);
  const rts = useOperationStore(s => s.rts);
  const ignoreEmptyChars = useOperationStore(s => s.ignoreEmptyChars);
  // 拆原语选择器：整包 `config` 订阅 + `ports.find(...)?.mode ?? 'trx'` 都返回
  // 新引用，随 3s 端口轮询无条件重渲染参数区。defaultBaudRates 只在挂载时用
  // 一次（getState 现取），常驻订阅只留模式态。
  const defaultBaudRates = useAppStore(s => s.config.defaultBaudRates);
  const setOpState = useOperationStore(s => s.setOpState);
  // issue #11：端口工作模式切换（trx=传统收发 | tty=终端模式）
  const activeTabId = useAppStore(s => s.activeTabId);
  const setPortMode = useAppStore(s => s.setPortMode);
  const portMode = useAppStore((s) => {
    const port = s.activeTabId ? s.ports.find((p) => p.id === s.activeTabId) : undefined;
    return port?.mode ?? 'trx';
  });

  // isCustomBaud 是显式用户意图：只由 select 的 onChange 写入（选「其他...」→ true，
  // 选预设 → false）。绝不从 baudRate 自动派生——否则键入到预设值瞬间输入框被卸载。
  // 挂载时按初始 store 值恢复一次自定义态（应用会话恢复的自定义波特率）。
  const [isCustomBaud, setIsCustomBaud] = useState(!defaultBaudRates.includes(baudRate));
  // 自定义波特率输入框的本地 draft：键入只改 draft 字符串，blur 时才解析提交，
  // 避免每个键都 setOpState（后端重配 + 整个面板重渲染导致卡顿/回弹）。
  const [customBaudInput, setCustomBaudInput] = useState(String(baudRate));
  const [presets, setPresets] = useState<PortPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState('');

  // 外部改 store baudRate（选预设/应用预设）时 draft 跟随；键入期间 baudRate 不变，
  // 此 effect 不会触发，与用户输入天然无冲突。
  useEffect(() => {
    setCustomBaudInput(String(baudRate));
  }, [baudRate]);

  const loadPresets = useCallback(async () => {
    try {
      const list = await storageService.loadPortPresets();
      setPresets(list);
      // P0-1：预设只经 storageService 单条落盘，从不回写 useAppStore.config.portPresets。
      // 全量保存（ConfigModal 保存 / 诊断日志开关 / 更新「不再提醒」）用 store.config
      // 快照整体覆盖 config.json——若不回写，新建/删除的预设会被启动快照静默回滚，
      // 重启后丢失（issue #5-2 陷阱在 portPresets 上的残留）。这里在每次加载后同步
      // store.config，使全量保存快照与磁盘一致。
      useAppStore.getState().setConfig({ portPresets: list });
    } catch (e) {
      console.warn('[ParamsSection] loadPortPresets failed:', e);
    }
  }, []);

  useEffect(() => {
    loadPresets();
  }, [loadPresets]);

  const handleSelectPreset = (id: string) => {
    setSelectedPresetId(id);
    const preset = presets.find(p => p.id === id);
    if (!preset) return;
    setOpState({
      baudRate: preset.baudRate,
      dataBits: preset.dataBits as DataBits,
      parity: preset.parity as Parity,
      stopBits: preset.stopBits as StopBits,
      handshake: preset.handshake as Handshake,
      dtr: preset.dtr,
      rts: preset.rts,
    });
  };

  /** Auto-generate a preset name from current params: "9600-8N1" style. */
  const autoPresetName = useCallback(() => {
    const op = useOperationStore.getState();
    const parityChar = (op.parity ?? 'None')[0].toUpperCase();
    const stopShort = op.stopBits === 'One' ? '1' : op.stopBits === 'OnePointFive' ? '1.5' : '2';
    return `${op.baudRate}-${op.dataBits}${parityChar}${stopShort}`;
  }, []);

  const handleSavePreset = useCallback(async () => {
    try {
      const op = useOperationStore.getState();
      await storageService.savePortPreset({
        id: `preset-${Date.now()}`,
        name: autoPresetName(),
        baudRate: op.baudRate,
        dataBits: op.dataBits,
        parity: op.parity,
        stopBits: op.stopBits,
        handshake: op.handshake,
        dtr: op.dtr,
        rts: op.rts,
      });
      await loadPresets();
      notifySuccess('paramsSection.preset.saved');
    } catch (e) {
      notifyError(e);
    }
  }, [autoPresetName, loadPresets]);

  const handleDeletePreset = useCallback(async () => {
    if (!selectedPresetId) return;
    try {
      await storageService.deletePortPreset(selectedPresetId);
      setSelectedPresetId('');
      await loadPresets();
      notifySuccess('paramsSection.preset.deleted');
    } catch (e) {
      notifyError(e);
    }
  }, [selectedPresetId, loadPresets]);

  // issue #11：切换工作模式 → 落 store + 清屏 + 冲刷 RX 管线残留字节，
  // 避免旧模式 buffered 的数据混入新模式首屏。TRX 侧清 viewport buffer + 冲刷
  // RxPipeline（切 TTY 时销毁 TRX 缓冲）；TTY 侧清 ttyService 屏幕（若已挂 TTY 视图）。
  const handleModeChange = useCallback((mode: PortMode) => {
    if (!activeTabId) return;
    setPortMode(activeTabId, mode);
    clearTerminal(activeTabId);
    if (mode === 'tty') {
      // TRX 缓冲销毁；切回 TRX 时 TerminalView 挂载会重建 manager
      releaseViewportManager(activeTabId);
    }
    getRxPipeline().flushAndReset(activeTabId);
    ttyService.clear(activeTabId);
  }, [activeTabId, setPortMode]);

  return (
    <div className="op-section op-section-params">
      <div className="panel-card-title eyebrow">{t('paramsSection.cardTitle')}</div>

      <div className="op-params-grid">
        {/* issue #11：工作模式切换（trx=传统收发 | tty=终端模式），样式复刻
            TerminalFilterBar 的 HEX/Text 分段控件（.segmented + .btn.btn-sm + active）。 */}
        <div className="op-param-item">
          <span className="op-label">{t('params.mode')}</span>
          <div className="segmented" role="group">
            <button type="button"
              className={`btn btn-sm${portMode === 'trx' ? ' active' : ''}`}
              disabled={!isPortActive}
              onClick={() => handleModeChange('trx')}
              aria-pressed={portMode === 'trx'}>
              {t('params.mode.trx')}
            </button>
            <button type="button"
              className={`btn btn-sm${portMode === 'tty' ? ' active' : ''}`}
              disabled={!isPortActive}
              onClick={() => handleModeChange('tty')}
              aria-pressed={portMode === 'tty'}>
              {t('params.mode.tty')}
            </button>
          </div>
        </div>
        <div className="op-param-item op-param-item-wide">
          <span className="op-label">{t('paramsSection.preset.label')}</span>
          <select className="select op-param-select" value={selectedPresetId}
            onChange={e => handleSelectPreset(e.target.value)}>
            <option value="">{t('paramsSection.preset.selectPlaceholder')}</option>
            {presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button className="icon-btn" title={t('paramsSection.preset.save')} onClick={handleSavePreset}>
            <Save size={14} />
          </button>
          {selectedPresetId && (
            <button className="icon-btn" title={t('paramsSection.preset.delete')} onClick={handleDeletePreset}>
              <Trash2 size={14} />
            </button>
          )}
        </div>
        <div className="op-param-item">
          <span className="op-label">{t('paramsSection.baudRateLabel')}</span>
          <select className="select op-param-select" disabled={!isPortActive} value={isCustomBaud ? '__custom__' : baudRate}
            onChange={e => {
              if (e.target.value === '__custom__') { setIsCustomBaud(true); }
              else { setIsCustomBaud(false); setOpState({ baudRate: Number(e.target.value) }); }
            }}>
            {defaultBaudRates.map(rate => <option key={rate} value={rate}>{rate}</option>)}
            <option value="__custom__">{t('paramsSection.baudRate.custom')}</option>
          </select>
          {isCustomBaud && (
            <input className="input op-baud-custom-input" type="number" disabled={!isPortActive}
              value={customBaudInput}
              onChange={e => setCustomBaudInput(e.target.value)}
              onBlur={() => {
                const parsed = Number(customBaudInput);
                if (Number.isFinite(parsed) && parsed > 0 && parsed <= 4000000) {
                  setOpState({ baudRate: parsed });
                } else {
                  setCustomBaudInput(String(baudRate));
                }
              }}
              min={1} max={4000000} />
          )}
        </div>
        <div className="op-param-item">
          <span className="op-label">{t('paramsSection.dataBitsLabel')}</span>
          <select className="select op-param-select" disabled={!isPortActive} value={dataBits} onChange={e => setOpState({ dataBits: Number(e.target.value) as DataBits })}>
            <option value={5}>5</option><option value={6}>6</option><option value={7}>7</option><option value={8}>8</option>
          </select>
        </div>
        <div className="op-param-item">
          <span className="op-label">{t('paramsSection.parityLabel')}</span>
          <select className="select op-param-select" disabled={!isPortActive} value={parity} onChange={e => setOpState({ parity: e.target.value as Parity })}>
            <option>None</option><option>Even</option><option>Odd</option><option>Mark</option><option>Space</option>
          </select>
        </div>
        <div className="op-param-item">
          <span className="op-label">{t('paramsSection.stopBitsLabel')}</span>
          <select className="select op-param-select" disabled={!isPortActive} value={stopBits} onChange={e => setOpState({ stopBits: e.target.value as StopBits })}>
            <option value="One">1</option><option value="OnePointFive">1.5</option><option value="Two">2</option>
          </select>
        </div>
        <div className="op-param-item op-param-item-wide">
          <span className="op-label">{t('paramsSection.handshakeLabel')}</span>
          <select className="select op-param-select" disabled={!isPortActive} value={handshake} onChange={e => setOpState({ handshake: e.target.value as Handshake })}>
            <option value="None">None</option><option value="XonXoff">Xon/Xoff</option>
            <option value="RequestToSend">RTS/CTS</option><option value="RequestToSendXonXoff">RTS/CTS+Xon/Xoff</option>
          </select>
        </div>
      </div>

      <div className="op-checkbox-row">
        <label className="checkbox-wrapper"><input type="checkbox" disabled={!isPortActive} checked={dtr} onChange={e => setOpState({ dtr: e.target.checked })} /> {t('paramsSection.dtr')}</label>
        <label className="checkbox-wrapper"><input type="checkbox" disabled={!isPortActive} checked={rts} onChange={e => setOpState({ rts: e.target.checked })} /> {t('paramsSection.rts')}</label>
        <label className="checkbox-wrapper op-checkbox-compact"><input type="checkbox" disabled={!isPortActive} checked={ignoreEmptyChars} onChange={e => setOpState({ ignoreEmptyChars: e.target.checked })} /> {t('paramsSection.ignoreEmptyChars')}</label>
      </div>
    </div>
  );
};

export default ParamsSection;
