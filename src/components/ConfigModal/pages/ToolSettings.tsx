import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useRuleStore } from '../../../stores/useRuleStore';
import { portToolConfigService } from '../../../services/tauri';
import { notifyError, notifySuccess } from '../../../stores/useToastStore';
import { Plus, Check, Trash2, ChevronRight, Wrench } from 'lucide-react';

/**
 * 外部工具配置页：管理端口号 → 命令行工具的映射关系。
 * 独立于串口存在——端口不在列表中也可以预配置。
 * 数据通过 SQLite 持久化（port_tool_configs 表）。
 */
const ToolSettings: React.FC = () => {
  const { t } = useTranslation();
  const configs = useRuleStore((s) => s.portToolConfigs);
  const addConfig = useRuleStore((s) => s.addPortToolConfig);
  const updateConfig = useRuleStore((s) => s.updatePortToolConfig);
  const removeConfig = useRuleStore((s) => s.removePortToolConfig);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    portToolConfigService.loadPortToolConfigs().then(rows => {
      if (rows.length > 0) {
        useRuleStore.getState().setPortToolConfigs(rows.map(r => ({
          id: r.id,
          name: r.name,
          portId: r.port_id,
          command: r.command,
          workdir: r.workdir,
        })));
      }
    }).catch((e) => console.debug('[ToolSettings] load failed:', e));
  }, []);

  const handleAdd = () => {
    const id = `tool-${Date.now()}`;
    addConfig({ id, name: t('toolSettings.newConfig'), portId: '', command: '', workdir: '' });
    setExpandedId(id);
  };

  const handleDelete = async (id: string) => {
    removeConfig(id);
    try { await portToolConfigService.deletePortToolConfig(id); } catch (e) { notifyError(e); }
  };

  const handleSave = async (id: string) => {
    const config = useRuleStore.getState().portToolConfigs.find(c => c.id === id);
    if (!config) return;
    try {
      await portToolConfigService.savePortToolConfig({
        id: config.id,
        name: config.name,
        port_id: config.portId,
        command: config.command,
        workdir: config.workdir,
      });
      notifySuccess(t('toolSettings.saved'));
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <div className="config-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 className="config-page-title" style={{ marginBottom: 0 }}>{t('toolSettings.title')}</h3>
        <button className="btn btn-sm" onClick={handleAdd}><Plus size={14} /> {t('toolSettings.addLabel')}</button>
      </div>
      <p className="config-page-desc">{t('toolSettings.description')}</p>

      {configs.length === 0 && <div className="config-placeholder">{t('toolSettings.emptyText')}</div>}

      {configs.map(config => (
        <div key={config.id} style={{ border: '1px solid var(--border-color)', borderRadius: 6, marginBottom: 10, overflow: 'hidden' }}>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--bg-secondary)', cursor: 'pointer' }}
            onClick={() => setExpandedId(expandedId === config.id ? null : config.id)}
          >
            <ChevronRight size={12} style={{ transform: expandedId === config.id ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }} />
            <input
              className="input"
              value={config.name}
              onChange={e => updateConfig(config.id, { name: e.target.value })}
              onClick={e => e.stopPropagation()}
              style={{ border: 'none', background: 'transparent', fontWeight: 600, flex: 1, minWidth: 0 }}
            />
            {config.portId && (
              <span style={{ fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'var(--font-terminal)', flexShrink: 0 }}>
                {config.portId}
              </span>
            )}
            <button className="btn btn-icon btn-sm" title={t('ruleSetAccordion.saveToDb')} onClick={e => { e.stopPropagation(); handleSave(config.id); }}>
              <Check size={14} />
            </button>
            <button className="btn btn-icon btn-sm" title={t('ruleSetAccordion.delete')} onClick={e => { e.stopPropagation(); handleDelete(config.id); }}>
              <Trash2 size={14} />
            </button>
          </div>

          {expandedId === config.id && (
            <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="config-row">
                <label>{t('toolSettings.portLabel')}</label>
                <input
                  className="input"
                  value={config.portId}
                  placeholder="COM5"
                  onChange={e => updateConfig(config.id, { portId: e.target.value })}
                  style={{ flex: 1, fontFamily: 'var(--font-terminal)' }}
                />
              </div>
              <div className="config-row">
                <label>{t('toolSettings.commandLabel')}</label>
                <input
                  className="input"
                  value={config.command}
                  placeholder={t('toolSettings.commandPlaceholder')}
                  onChange={e => updateConfig(config.id, { command: e.target.value })}
                  style={{ flex: 1, fontFamily: 'var(--font-terminal)' }}
                />
              </div>
              <div className="config-row">
                <label>{t('toolSettings.workdirLabel')}</label>
                <input
                  className="input"
                  value={config.workdir}
                  placeholder={t('toolSettings.workdirPlaceholder')}
                  onChange={e => updateConfig(config.id, { workdir: e.target.value })}
                  style={{ flex: 1, fontFamily: 'var(--font-terminal)' }}
                />
              </div>
              {config.command && config.portId && (
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  <Wrench size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                  {t('toolSettings.previewLabel')}:{' '}
                  <code style={{ fontFamily: 'var(--font-terminal)' }}>
                    {config.command.replace(/\{port\}/g, config.portId)}
                  </code>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

export default ToolSettings;
