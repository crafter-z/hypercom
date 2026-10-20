import { fileService } from '../services/tauri';
import { acquirePluginDialog } from './pluginDialogBudget';

/** Export a plugin's bounded output through an explicit user-chosen destination. */
export async function exportPluginPanel(pluginId: string, text: string, beforeSend?: () => void): Promise<void> {
  const releaseDialog = acquirePluginDialog(pluginId);
  try {
    beforeSend?.();
    await fileService.pickTextFileAndWrite(text, {
      defaultFileName: `${pluginId}.txt`,
      filters: [{ name: 'Text', extensions: ['txt'] }],
    });
  } finally {
    releaseDialog();
  }
}
