import React from 'react';
import { useTranslation } from 'react-i18next';
import { useRuleStore } from '../../../stores/useRuleStore';
import { storageService } from '../../../services/tauri';
import type { PortToolConfig } from '../../../types';
import RuleSetAccordion from '../RuleSetAccordion';
import { useEntityPage } from '../hooks/useEntityPage';
import { Wrench } from 'lucide-react';

/**
 * 外部工具配置页：管理端口号 → 命令行工具的映射关系。
 * 独立于串口存在——端口不在列表中也可以预配置。
 * 数据随 config.json 持久化（`portToolConfigs` 实体数组）。
 */
const ToolSettings: React.FC = () => {
  const { t } = useTranslation();
  const configs = useRuleStore((s) => s.portToolConfigs);
  const updateConfig = useRuleStore((s) => s.updatePortToolConfig);

  const page = useEntityPage<PortToolConfig>({
    items: configs,
    label: 'ToolSettings',
    ops: {
      load: () => storageService.loadPortToolConfigs(),
      read: () => useRuleStore.getState().portToolConfigs,
      replace: (items) => useRuleStore.getState().setPortToolConfigs(items),
      add: (config) => useRuleStore.getState().addPortToolConfig(config),
      drop: (id) => useRuleStore.getState().removePortToolConfig(id),
      persist: (config) => storageService.savePortToolConfig(config),
      remove: (id) => storageService.deletePortToolConfig(id),
    },
  });

  const handleAdd = () => {
    page.create({ id: `tool-${Date.now()}`, name: t('toolSettings.newConfig'), portId: '', command: '', workdir: '' });
  };

  return (
    <RuleSetAccordion<PortToolConfig>
      title={t('toolSettings.title')}
      description={t('toolSettings.description')}
      addLabel={t('toolSettings.addLabel')}
      emptyText={t('toolSettings.emptyText')}
      items={configs}
      selectedId={page.expandedId}
      onSelect={page.toggleExpanded}
      onAdd={handleAdd}
      onDelete={page.remove}
      onSave={page.save}
      onRename={(id, name) => updateConfig(id, { name })}
      renderHeaderExtra={(config) => config.portId ? (
        <span style={{ fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'var(--font-terminal)', flexShrink: 0 }}>
          {config.portId}
        </span>
      ) : null}
      renderEditor={(config) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
    />
  );
};

export default ToolSettings;
