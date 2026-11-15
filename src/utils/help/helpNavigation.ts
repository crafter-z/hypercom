import { popoutService } from '../../services/tauri';
import { useSystemStore } from '../../stores/useSystemStore';

/** A stable location in the bundled UserWiki catalog. */
export interface HelpLocation {
  articleId: string;
  anchor?: string;
}

type HelpPopoutService = typeof popoutService & {
  /** Added by the popout integration. Kept optional for dev/test doubles. */
  openHelp?: (articleId?: string, anchor?: string) => Promise<void>;
};

/**
 * Open or focus the singleton Help Center without changing the serial workspace.
 *
 * The optional method keeps older test doubles and development builds usable while
 * task-2's Rust-backed openHelp implementation is being rolled out. Once present,
 * it owns query-string/deep-link transport to the independent Help webview.
 */
export async function openHelpCenter(location: HelpLocation = { articleId: 'home' }): Promise<void> {
  const articleId = location.articleId || 'home';
  useSystemStore.getState().setUIState({ isHelpOpen: true, helpArticleId: articleId });

  const service = popoutService as HelpPopoutService;
  if (typeof service.openHelp === 'function') {
    await service.openHelp(articleId, location.anchor);
    return;
  }
  // Compatibility fallback for local test harnesses before task-2 is merged.
  await service.openPopout('help');
}

export function rememberHelpClosed(): void {
  useSystemStore.getState().setUIState({ isHelpOpen: false });
}

export default openHelpCenter;
