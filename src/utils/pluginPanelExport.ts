import { save } from '@tauri-apps/plugin-dialog';
import { fileService } from '../services/tauri';

/** Export a plugin's bounded output through an explicit user-chosen destination. */
export async function exportPluginPanel(pluginId: string, text: string): Promise<void> {
  const path = await save({
    defaultPath: `${pluginId}.txt`,
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  if (path === null) return;
  await fileService.writeTextFile(path, text);
}
