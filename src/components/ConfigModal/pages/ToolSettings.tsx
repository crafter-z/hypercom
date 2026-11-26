import React, { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, Wrench } from 'lucide-react';
import { useAppStore } from '../../../stores/useAppStore';
import type { PortToolConfig } from '../../../types';
import { previewPortToolCommand } from '../../../services/tool';
import RuleSetAccordion from '../RuleSetAccordion';
import { useEntityPage } from '../hooks/useEntityPage';
import '../../../styles/rule-preview.css';

/**
 * 外部工具配置页：管理端口号 → 命令行工具的映射关系。
 * 独立于串口存在——端口不在列表中也可以预配置。
 * 数据随 config.json 持久化（`portToolConfigs` 实体数组）。
 */
const ToolSettings: React.FC = () => {
  const { t } = useTranslation();
  const portListId = useId();
  const ports = useAppStore((s) => s.ports);
  const portMeta = useAppStore((s) => s.config.portMeta);
  const page = useEntityPage<PortToolConfig>({ kind: 'portToolConfigs' });
  const updateConfig = page.update;

  const portSuggestions = useMemo(() => {
    const map = new Map<string, string>();
    for (const port of ports) {
      map.set(port.id, port.alias ? `${port.id} (${port.alias})` : port.name);
    }
    for (const meta of portMeta) {
      if (!map.has(meta.portId)) {
        map.set(meta.portId, meta.alias ? `${meta.portId} (${meta.alias})` : meta.portId);
      }
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [ports, portMeta]);

  const handleAdd = (beforeId?: string) => {
    page.create({ id: crypto.randomUUID(), name: t('toolSettings.newConfig'), portId: '', command: '', workdir: '' }, beforeId);
  };

  const handleDuplicate = (config: PortToolConfig) => {
    const index = page.items.findIndex(item => item.id === config.id);
    page.create({
      ...config,
      id: crypto.randomUUID(),
      name: t('ruleSetAccordion.duplicateName', { name: config.name }),
      portId: '',
    }, page.items[index + 1]?.id);
  };

  const handleBrowseWorkdir = async (configId: string) => {
    const selected = await open({ directory: true, multiple: false })
      .catch((e) => { console.debug('[ToolSettings] directory dialog failed:', e); return null; });
    if (typeof selected === 'string' && selected) {
      updateConfig(configId, { workdir: selected });
    }
  };

  return (
    <>
      <datalist id={portListId}>
        {portSuggestions.map(([id, label]) => (
          <option key={id} value={id}>{label}</option>
        ))}
      </datalist>
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
        onDuplicate={handleDuplicate}
        isNonEmpty={(config) => Boolean(config.portId.trim() || config.command.trim() || config.workdir.trim())}
        matchesFilter={(config, q) =>
          [config.name, config.portId, config.command, config.workdir]
            .some(value => value.toLocaleLowerCase().includes(q))}
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
        renderEditor={(config) => {
          const trimmedPortId = config.portId.trim();
          const isEmptyPort = trimmedPortId.length === 0;
          const isDuplicatePort = !isEmptyPort && page.items.some(
            item => item.id !== config.id && item.portId.trim() === trimmedPortId,
          );
          const portError = isEmptyPort
            ? t('toolSettings.validation.emptyPort')
            : isDuplicatePort
              ? t('toolSettings.validation.duplicatePort')
              : null;
          return (
            <div className="rule-settings-editor tool-settings-editor">
              <div className="rule-settings-row">
                <label className="rule-settings-label" htmlFor={`tool-port-${config.id}`}>{t('toolSettings.portLabel')}</label>
                <input
                  id={`tool-port-${config.id}`}
                  list={portListId}
                  className={`input rule-settings-field rule-settings-terminal${portError ? ' is-invalid' : ''}`}
                  aria-invalid={Boolean(portError)}
                  value={config.portId}
                  placeholder="COM5"
                  onChange={e => updateConfig(config.id, { portId: e.target.value })}
                />
              </div>
              {portError && (
                <div className="editor-inline-error" role="alert">{portError}</div>
              )}
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
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={page.saving}
                  onClick={() => void handleBrowseWorkdir(config.id)}
                  title={t('logSettings.browseButton')}
                >
                  <FolderOpen size={13} aria-hidden="true" />
                  {t('logSettings.browseButton')}
                </button>
              </div>
              {config.command && config.portId && (
                <div className="rule-settings-note">
                  <Wrench size={11} aria-hidden="true" />
                  <span>{t('toolSettings.previewLabel')}: <code className="rule-settings-terminal">{previewPortToolCommand(config.command, config.portId)}</code></span>
                </div>
              )}
            </div>
          );
        }}
      />
    </>
  );
};

export default ToolSettings;
