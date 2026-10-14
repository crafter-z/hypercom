const MAX_LIVE_PLUGIN_DIALOGS = 8;

const activeDialogs = new Map<string, number>();

/** Acquire a native dialog slot shared by all Worker generations of one plugin. */
export function acquirePluginDialog(pluginId: string): () => void {
  const active = activeDialogs.get(pluginId) ?? 0;
  if (active >= MAX_LIVE_PLUGIN_DIALOGS) {
    throw new Error('plugin dialog capacity exceeded');
  }
  activeDialogs.set(pluginId, active + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = activeDialogs.get(pluginId) ?? 0;
    if (current <= 1) activeDialogs.delete(pluginId);
    else activeDialogs.set(pluginId, current - 1);
  };
}

export function resetPluginDialogBudgetForTest(): void {
  activeDialogs.clear();
}
