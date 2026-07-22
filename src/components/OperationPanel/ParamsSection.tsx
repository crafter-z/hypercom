import React, { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useOperationStore } from '../../stores/useOperationStore';
import { useTranslation } from 'react-i18next';
import { Save, Trash2 } from 'lucide-react';
import type { DataBits, Parity, StopBits, Handshake } from '../../types';
import { portPresetService } from '../../services/tauri';
import type { PortPresetInfo } from '../../services/tauri';
import { notifyError, notifySuccess } from '../../stores/useToastStore';

export interface ParamsSectionProps {
  isConnected: boolean;
}

const ParamsSection: React.FC<ParamsSectionProps> = ({ isConnected }) => {
  const { t } = useTranslation();
  const baudRate = useOperationStore(s => s.baudRate);
  const dataBits = useOperationStore(s => s.dataBits);
  const parity = useOperationStore(s => s.parity);
  const stopBits = useOperationStore(s => s.stopBits);
  const handshake = useOperationStore(s => s.handshake);
  const dtr = useOperationStore(s => s.dtr);
  const rts = useOperationStore(s => s.rts);
  const ignoreEmptyChars = useOperationStore(s => s.ignoreEmptyChars);
  const config = useAppStore(s => s.config);
  const setOpState = useOperationStore(s => s.setOpState);

  const [isCustomBaud, setIsCustomBaud] = useState(!config.defaultBaudRates.includes(baudRate));
  const [presets, setPresets] = useState<PortPresetInfo[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState('');

  useEffect(() => {
    setIsCustomBaud(!config.defaultBaudRates.includes(baudRate));
  }, [baudRate, config.defaultBaudRates]);

  const loadPresets = useCallback(async () => {
    try {
      const list = await portPresetService.loadPortPresets();
      setPresets(list);
    } catch (e) {
      console.debug('[ParamsSection] loadPortPresets failed:', e);
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
      baudRate: preset.baud_rate,
      dataBits: preset.data_bits as DataBits,
      parity: preset.parity as Parity,
      stopBits: preset.stop_bits as StopBits,
      handshake: preset.handshake as Handshake,
      dtr: preset.dtr !== 0,
      rts: preset.rts !== 0,
    });
  };

  const handleSavePreset = async () => {
    const name = window.prompt(t('paramsSection.preset.namePrompt'));
    if (!name || !name.trim()) return;
    try {
      await portPresetService.savePortPreset({
        name: name.trim(),
        baud_rate: baudRate,
        data_bits: dataBits,
        parity,
        stop_bits: stopBits,
        handshake,
        dtr,
        rts,
      });
      await loadPresets();
      notifySuccess('paramsSection.preset.saved');
    } catch (e) {
      notifyError(e);
    }
  };

  const handleDeletePreset = async () => {
    if (!selectedPresetId) return;
    try {
      await portPresetService.deletePortPreset(selectedPresetId);
      setSelectedPresetId('');
      await loadPresets();
      notifySuccess('paramsSection.preset.deleted');
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <div className="op-section op-section-params">
      <div className="panel-card-title">{t('paramsSection.cardTitle')}</div>

      <div className="op-params-grid">
        <div className="op-param-item" style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 4 }}>
          <span className="op-label">{t('paramsSection.preset.label')}</span>
          <select className="select op-param-select" value={selectedPresetId}
            onChange={e => handleSelectPreset(e.target.value)} style={{ flex: 1 }}>
            <option value="">{t('paramsSection.preset.selectPlaceholder')}</option>
            {presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button className="btn btn-icon btn-sm" title={t('paramsSection.preset.saveTooltip')} onClick={handleSavePreset}>
            <Save size={13} />
          </button>
          <button className="btn btn-icon btn-sm" title={t('paramsSection.preset.deleteTooltip')} onClick={handleDeletePreset} disabled={!selectedPresetId}>
            <Trash2 size={13} />
          </button>
        </div>
        <div className="op-param-item">
          <span className="op-label">{t('paramsSection.baudRateLabel')}</span>
          <select className="select op-param-select" disabled={!isConnected} value={isCustomBaud ? '__custom__' : baudRate}
            onChange={e => {
              if (e.target.value === '__custom__') { setIsCustomBaud(true); }
              else { setIsCustomBaud(false); setOpState({ baudRate: Number(e.target.value) }); }
            }}>
            {config.defaultBaudRates.map(rate => <option key={rate} value={rate}>{rate}</option>)}
            <option value="__custom__">{t('paramsSection.baudRate.custom')}</option>
          </select>
          {isCustomBaud && (
            <input className="input" type="number" disabled={!isConnected} style={{ width: 80, marginLeft: 4 }}
              value={baudRate} onChange={e => setOpState({ baudRate: Number(e.target.value) || 9600 })}
              min={50} max={4000000} step={100} />
          )}
        </div>
        <div className="op-param-item">
          <span className="op-label">{t('paramsSection.dataBitsLabel')}</span>
          <select className="select op-param-select" disabled={!isConnected} value={dataBits} onChange={e => setOpState({ dataBits: Number(e.target.value) as DataBits })}>
            <option value={5}>5</option><option value={6}>6</option><option value={7}>7</option><option value={8}>8</option>
          </select>
        </div>
        <div className="op-param-item">
          <span className="op-label">{t('paramsSection.parityLabel')}</span>
          <select className="select op-param-select" disabled={!isConnected} value={parity} onChange={e => setOpState({ parity: e.target.value as Parity })}>
            <option>None</option><option>Even</option><option>Odd</option><option>Mark</option><option>Space</option>
          </select>
        </div>
        <div className="op-param-item">
          <span className="op-label">{t('paramsSection.stopBitsLabel')}</span>
          <select className="select op-param-select" disabled={!isConnected} value={stopBits} onChange={e => setOpState({ stopBits: e.target.value as StopBits })}>
            <option value="One">1</option><option value="OnePointFive">1.5</option><option value="Two">2</option>
          </select>
        </div>
        <div className="op-param-item" style={{ gridColumn: '1 / -1' }}>
          <span className="op-label">{t('paramsSection.handshakeLabel')}</span>
          <select className="select op-param-select" disabled={!isConnected} value={handshake} onChange={e => setOpState({ handshake: e.target.value as Handshake })}>
            <option value="None">None</option><option value="XonXoff">Xon/Xoff</option>
            <option value="RequestToSend">RTS/CTS</option><option value="RequestToSendXonXoff">RTS/CTS+Xon/Xoff</option>
          </select>
        </div>
      </div>

      <div className="op-checkbox-row" style={{ marginTop: 4 }}>
        <label className="checkbox-wrapper"><input type="checkbox" disabled={!isConnected} checked={dtr} onChange={e => setOpState({ dtr: e.target.checked })} /> {t('paramsSection.dtr')}</label>
        <label className="checkbox-wrapper"><input type="checkbox" disabled={!isConnected} checked={rts} onChange={e => setOpState({ rts: e.target.checked })} /> {t('paramsSection.rts')}</label>
        <label className="checkbox-wrapper" style={{ fontSize: 11 }}><input type="checkbox" disabled={!isConnected} checked={ignoreEmptyChars} onChange={e => setOpState({ ignoreEmptyChars: e.target.checked })} /> {t('paramsSection.ignoreEmptyChars')}</label>
      </div>
    </div>
  );
};

export default ParamsSection;
