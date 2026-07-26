import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../stores/useAppStore';
import { notifySuccess } from '../../../stores/useToastStore';
import { Terminal } from 'lucide-react';

/**
 * 外部工具配置页：为每个串口配置命令行工具（烧录等）。
 * 命令模板中 {port} 在执行时替换为实际端口名。
 * 配置存储在 port.toolCommand（随 session snapshot 持久化）。
 */
const ToolSettings: React.FC = () => {
  const { t } = useTranslation();
  const ports = useAppStore((s) => s.ports);
  const updatePort = useAppStore((s) => s.updatePort);

  // Local draft state so edits don't trigger store re-renders on every keystroke
  const [drafts, setDrafts] = useState<Record<string, { command: string; workdir: string }>>(() => {
    const init: Record<string, { command: string; workdir: string }> = {};
    for (const p of ports) {
      init[p.id] = { command: p.toolCommand ?? '', workdir: '' };
    }
    return init;
  });

  const handleSave = () => {
    for (const p of ports) {
      const draft = drafts[p.id];
      if (draft) {
        updatePort(p.id, { toolCommand: draft.command.trim() || undefined });
      }
    }
    notifySuccess(t('toolSettings.saved'));
  };

  if (ports.length === 0) {
    return <div className="config-empty">{t('toolSettings.noPorts')}</div>;
  }

  return (
    <div className="config-section">
      <div className="config-section-header">
        <Terminal size={14} />
        <span>{t('toolSettings.title')}</span>
      </div>
      <p className="config-section-desc">{t('toolSettings.description')}</p>

      <div className="tool-settings-list">
        {ports.map((port) => {
          const draft = drafts[port.id] ?? { command: '', workdir: '' };
          const preview = draft.command.replace(/\{port\}/g, port.id);
          return (
            <div key={port.id} className="tool-settings-item">
              <div className="tool-settings-port">
                <span className="tool-settings-port-name">{port.id}</span>
                {port.alias && <span className="tool-settings-port-alias">{port.alias}</span>}
              </div>
              <div className="tool-settings-fields">
                <label className="config-label">{t('toolSettings.commandLabel')}</label>
                <input
                  className="input tool-settings-input"
                  value={draft.command}
                  placeholder={t('toolSettings.commandPlaceholder')}
                  onChange={(e) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [port.id]: { ...prev[port.id], command: e.target.value },
                    }))
                  }
                />
                <label className="config-label">{t('toolSettings.workdirLabel')}</label>
                <input
                  className="input tool-settings-input"
                  value={draft.workdir}
                  placeholder={t('toolSettings.workdirPlaceholder')}
                  onChange={(e) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [port.id]: { ...prev[port.id], workdir: e.target.value },
                    }))
                  }
                />
                {draft.command && (
                  <div className="tool-settings-preview">
                    <span className="config-label">{t('toolSettings.previewLabel')}</span>
                    <code className="tool-settings-preview-code">{preview}</code>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="config-section-actions">
        <button className="btn btn-primary" onClick={handleSave}>
          {t('toolSettings.save')}
        </button>
      </div>
    </div>
  );
};

export default ToolSettings;
