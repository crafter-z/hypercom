import { save } from '@tauri-apps/plugin-dialog';
import { fileService } from '../services/tauri';
import { acquirePluginDialog } from './pluginDialogBudget';

/** Export a plugin's bounded output through an explicit user-chosen destination. */
export async function exportPluginPanel(pluginId: string, text: string, beforeSend?: () => void): Promise<void> {
  const releaseDialog = acquirePluginDialog(pluginId);
  try {
    const path = await save({
      defaultPath: `${pluginId}.txt`,
      filters: [{ name: 'Text', extensions: ['txt'] }],
    });
    beforeSend?.();
    if (path === null) return;
    await fileService.writeTextFile(path, text);
  } finally {
    releaseDialog();
  }
}
