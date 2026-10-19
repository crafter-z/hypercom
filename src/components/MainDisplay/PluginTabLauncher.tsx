import React, { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { getAvailablePluginViews, openPluginTabForUser } from '../../utils/pluginViewRuntime';
import { getPluginViews, subscribePluginViews } from '../../utils/pluginConfigSnapshot';
import { notifyError } from '../../stores/useToastStore';
import PluginViewPicker from '../shared/PluginViewPicker';

interface Props { portId: string | null; }

const PluginTabLauncher: React.FC<Props> = ({ portId }) => {
  const { t } = useTranslation();
  useSyncExternalStore(subscribePluginViews, getPluginViews);
  const portChoices = portId ? getAvailablePluginViews(portId, 'workspace-tab') : [];
  const choices = [...getAvailablePluginViews(null, 'workspace-tab'), ...portChoices]
    .filter((choice, index, all) => all.findIndex(item =>
      `${item.preference.pluginId}/${item.preference.installGeneration}/${item.preference.viewId}` ===
      `${choice.preference.pluginId}/${choice.preference.installGeneration}/${choice.preference.viewId}`) === index)
    .sort((a, b) => `${a.pluginName}/${a.declaration.label}`.localeCompare(`${b.pluginName}/${b.declaration.label}`));
  if (!choices.length) return null;

  return (
    <PluginViewPicker
      choices={choices}
      variant="launcher"
      className="plugin-view-picker-compact"
      triggerIcon={<Plus size={14} />}
      triggerLabel={t('pluginViews.newToolTab')}
      title={t('pluginViews.openTool')}
      ariaLabel={t('pluginViews.newToolTab')}
      onSelect={choice => {
        if (!choice) return;
        const binding = choice.declaration.portBinding === 'none' ? null : portId;
        try { openPluginTabForUser(choice.preference, binding); } catch (error) { notifyError(error); }
      }}
    />
  );
};

export default PluginTabLauncher;
