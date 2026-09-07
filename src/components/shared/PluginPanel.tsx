/**
 * PluginPanel — 插件输出面板（issue #17 能力补强）
 *
 * 插件经 `plugin.api.ui.panel.append/clear` 写入的结构化输出在此渲染。
 * worker 零 DOM——面板是宿主 React 组件，订阅 pluginPanelRegistry 快照。
 *
 * v1：一个可折叠底部面板，展示所有有输出的插件（各一格）。空面板不渲染
 * （零插件输出时零 DOM 开销）。面板是插件输出区，零权限。
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelBottomClose, PanelBottomOpen, X, Copy } from 'lucide-react';
import { usePluginPanel } from '../../hooks/usePluginPanel';
import { clearPluginPanel } from '../../utils/pluginPanelRegistry';
import { notifyInfo } from '../../stores/useToastStore';

const PluginPanel: React.FC = () => {
  const { t } = useTranslation();
  const panels = usePluginPanel();
  const [collapsed, setCollapsed] = useState(false);

  const activePlugins = Object.entries(panels).filter(([, p]) => p.buffer.length > 0);
  if (activePlugins.length === 0) return null;

  const copyAll = (pluginId: string) => {
    const text = panels[pluginId]?.buffer ?? '';
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => notifyInfo('plugins.panelCopied'));
  };

  return (
    <div className="plugin-panel">
      <div className="plugin-panel-header" onClick={() => setCollapsed((c) => !c)}>
        <span className="plugin-panel-title">
          {collapsed ? <PanelBottomOpen size={13} /> : <PanelBottomClose size={13} />}
          {t('plugins.panelTitle')}
        </span>
        <span className="plugin-panel-count">
          {t('plugins.panelPlugins', { count: activePlugins.length })}
        </span>
      </div>

      {!collapsed && (
        <div className="plugin-panel-body">
          {activePlugins.map(([pluginId, p]) => (
            <div key={pluginId} className="plugin-panel-block">
              <div className="plugin-panel-block-header">
                <strong>{pluginId}</strong>
                <div className="plugin-panel-block-actions">
                  <button
                    className="icon-btn"
                    title={t('plugins.panelCopy')}
                    onClick={() => copyAll(pluginId)}
                  >
                    <Copy size={13} />
                  </button>
                  <button
                    className="icon-btn"
                    title={t('plugins.panelClear')}
                    onClick={() => clearPluginPanel(pluginId)}
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>
              <pre className="plugin-panel-content">{p.buffer}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default PluginPanel;
