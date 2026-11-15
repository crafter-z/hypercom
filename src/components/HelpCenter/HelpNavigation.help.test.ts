import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openHelpCenter, rememberHelpClosed } from '../../utils/help/helpNavigation';
import { useSystemStore } from '../../stores/useSystemStore';
import { resetStoresForTests } from '../../stores/resetStores';

const openHelp = vi.hoisted(() => vi.fn(async () => undefined));
const openPopout = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../services/tauri', () => ({
  popoutService: { openHelp, openPopout },
}));

describe('Help popout navigation contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoresForTests();
  });

  it('records the requested article and forwards the anchor to the singleton native window', async () => {
    await openHelpCenter({ articleId: 'ports', anchor: '端口分组' });
    expect(useSystemStore.getState().ui.isHelpOpen).toBe(true);
    expect(useSystemStore.getState().ui.helpArticleId).toBe('ports');
    expect(openHelp).toHaveBeenCalledOnce();
    expect(openHelp).toHaveBeenCalledWith('ports', '端口分组');
    expect(openPopout).not.toHaveBeenCalled();
  });

  it('retains compatibility with a legacy popout double without losing UI intent', async () => {
    const service = (await import('../../services/tauri')).popoutService as unknown as { openHelp?: unknown; openPopout: typeof openPopout };
    service.openHelp = undefined;
    await openHelpCenter({ articleId: 'quick-start' });
    expect(openPopout).toHaveBeenCalledWith('help');
    expect(useSystemStore.getState().ui.helpArticleId).toBe('quick-start');
  });

  it('clears requested state when the help window reports it closed', () => {
    useSystemStore.getState().setUIState({ isHelpOpen: true, helpArticleId: 'settings' });
    rememberHelpClosed();
    expect(useSystemStore.getState().ui.isHelpOpen).toBe(false);
  });
});
