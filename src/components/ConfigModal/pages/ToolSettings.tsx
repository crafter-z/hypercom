import React from 'react';
import { useTranslation } from 'react-i18next';
import type { PortToolConfig } from '../../../types';
import RuleSetAccordion from '../RuleSetAccordion';
import { useEntityPage } from '../hooks/useEntityPage';
import { Wrench } from 'lucide-react';
import '../../../styles/rule-preview.css';

/**
 * 外部工具配置页：管理端口号 → 命令行工具的映射关系。
 * 独立于串口存在——端口不在列表中也可以预配置。
 * 数据随 config.json 持久化（`portToolConfigs` 实体数组）。
 */
const ToolSettings: React.FC = () => {
  const { t } = useTranslation();
  const page = useEntityPage<PortToolConfig>({ kind: 'portToolConfigs' });
  const updateConfig = page.update;

  const handleAdd = (beforeId?: string) => {
    page.create({ id: crypto.randomUUID(), name: t('toolSettings.newConfig'), portId: '', command: '', workdir: '' }, beforeId);
  };

  return (
    <RuleSetAccordion<PortToolConfig>
      title={t('toolSettings.title')}
      description={t('toolSettings.description')}
      addLabel={t('toolSettings.addLabel')}
      emptyText={t('toolSettings.emptyText')}
      items={page.items}
      selectedId={page.expandedId}
      onSelect={page.toggleExpanded}
      onAdd={() => handleAdd()}
      onInsert={handleAdd}
      onReorder={page.reorder}
      onDiscard={page.discard}
      dirty={page.dirty}
      isDirty={page.isDirty}
      saving={page.saving}
      error={page.error}
      onDelete={page.remove}
      onSave={page.save}
      onRename={(id, name) => updateConfig(id, { name })}
      renderHeaderExtra={(config) => {
        const empty = t('toolSettings.summaryEmpty');
        const port = config.portId.trim() || empty;
        const command = config.command.trim() || empty;
        const summary = t('toolSettings.summary', { port, command });
        return <span className="rule-header-extra" title={summary} onClick={e => e.stopPropagation()}>{summary}</span>;
      }}
      renderEditor={(config) => (
        <div className="rule-settings-editor tool-settings-editor">
          <div className="rule-settings-row">
            <label className="rule-settings-label" htmlFor={`tool-port-${config.id}`}>{t('toolSettings.portLabel')}</label>
            <input
              id={`tool-port-${config.id}`}
              className="input rule-settings-field rule-settings-terminal"
              value={config.portId}
              placeholder="COM5"
              onChange={e => updateConfig(config.id, { portId: e.target.value })}
            />
          </div>
          <div className="rule-settings-row">
            <label className="rule-settings-label" htmlFor={`tool-command-${config.id}`}>{t('toolSettings.commandLabel')}</label>
            <input
              id={`tool-command-${config.id}`}
              className="input rule-settings-field rule-settings-terminal"
              value={config.command}
              placeholder={t('toolSettings.commandPlaceholder')}
              onChange={e => updateConfig(config.id, { command: e.target.value })}
            />
          </div>
          <div className="rule-settings-row">
            <label className="rule-settings-label" htmlFor={`tool-workdir-${config.id}`}>{t('toolSettings.workdirLabel')}</label>
            <input
              id={`tool-workdir-${config.id}`}
              className="input rule-settings-field rule-settings-terminal"
              value={config.workdir}
              placeholder={t('toolSettings.workdirPlaceholder')}
              onChange={e => updateConfig(config.id, { workdir: e.target.value })}
            />
          </div>
          {config.command && config.portId && (
            <div className="rule-settings-note">
              <Wrench size={11} aria-hidden="true" />
              <span>{t('toolSettings.previewLabel')}: <code className="rule-settings-terminal">{config.command.replace(/\{port\}/g, config.portId)}</code></span>
            </div>
          )}
        </div>
      )}
    />
  );
};

export default ToolSettings;
