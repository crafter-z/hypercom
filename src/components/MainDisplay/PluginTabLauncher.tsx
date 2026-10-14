import React, { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { getAvailablePluginViews, openPluginTabForUser } from '../../utils/pluginViewRuntime';
import { getPluginViews, subscribePluginViews } from '../../utils/pluginConfigSnapshot';
import { notifyError } from '../../stores/useToastStore';
import PluginViewPicker from '../shared/PluginViewPicker';

const PluginTabLauncher: React.FC = () => {
  const { t } = useTranslation();
  useSyncExternalStore(subscribePluginViews, getPluginViews);
  const choices = getAvailablePluginViews(null, 'workspace-tab');
  if (!choices.length) return null;

  return (
    <div className="plugin-tab-launcher">
      <PluginViewPicker
        choices={choices}
        variant="launcher"
        showCount
        triggerLabel={t('pluginViews.openToolShort')}
        title={t('pluginViews.openTool')}
        ariaLabel={t('pluginViews.openTool')}
        onSelect={choice => {
          if (!choice) return;
          try { openPluginTabForUser(choice.preference, null); } catch (error) { notifyError(error); }
        }}
      />
    </div>
  );
};

export default PluginTabLauncher;
