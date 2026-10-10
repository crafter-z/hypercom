import React, { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { getAvailablePluginViews, openPluginTabForUser } from '../../utils/pluginViewRuntime';
import { getPluginViews, subscribePluginViews } from '../../utils/pluginConfigSnapshot';
import { notifyError } from '../../stores/useToastStore';

const PluginTabLauncher: React.FC = () => {
  const { t } = useTranslation();
  useSyncExternalStore(subscribePluginViews, getPluginViews);
  const choices = getAvailablePluginViews(null, 'workspace-tab');
  if (!choices.length) return null;
  return <select className="plugin-tab-launcher" aria-label={t('pluginViews.openTool')} value="" onChange={event => {
    const choice = choices.find(item => `${item.preference.pluginId}/${item.preference.viewId}` === event.target.value);
    if (!choice) return;
    try { openPluginTabForUser(choice.preference, null); } catch (error) { notifyError(error); }
  }}>
    <option value="">{t('pluginViews.openTool')}</option>
    {choices.map(item => <option key={`${item.preference.pluginId}/${item.preference.viewId}`} value={`${item.preference.pluginId}/${item.preference.viewId}`}>
      {item.pluginName}: {item.declaration.label}
    </option>)}
  </select>;
};
export default PluginTabLauncher;
