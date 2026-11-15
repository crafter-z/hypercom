// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HelpCenter from '../Help/HelpCenter';
import { getHelpArticle } from '../../utils/help';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent?.includes(text));
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

describe('Help Center integration', () => {
  it('opens a deep-linked article and navigates back and forward without changing app stores', async () => {
    const ports = getHelpArticle('ports')!;
    const home = getHelpArticle('home')!;
    await act(async () => root.render(<HelpCenter initialArticleId="ports" />));
    expect(host.querySelector('.help-article-header h1')?.textContent).toBe(ports.title);

    await act(async () => buttonWithText('help.home').click());
    expect(host.querySelector('.help-article-header h1')?.textContent).toBe(home.title);
    const back = host.querySelector<HTMLButtonElement>('button[aria-label="help.back"]')!;
    expect(back.disabled).toBe(false);
    await act(async () => back.click());
    expect(host.querySelector('.help-article-header h1')?.textContent).toBe(ports.title);
    const forward = host.querySelector<HTMLButtonElement>('button[aria-label="help.forward"]')!;
    await act(async () => forward.click());
    expect(host.querySelector('.help-article-header h1')?.textContent).toBe(home.title);
  });

  it('resets the article scroll container when navigating without an anchor', async () => {
    await act(async () => root.render(<HelpCenter initialArticleId="ports" />));
    const main = host.querySelector<HTMLElement>('.help-main')!;
    main.scrollTop = 240;
    await act(async () => buttonWithText('help.home').click());
    expect(main.scrollTop).toBe(0);
  });

  it('searches the compiled catalog and opens a matching result', async () => {
    await act(async () => root.render(<HelpCenter />));
    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, '日志');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelector('.help-search-results')).not.toBeNull();
    const result = host.querySelector<HTMLButtonElement>('.help-result');
    expect(result).not.toBeNull();
    await act(async () => result!.click());
    expect(host.querySelector('.help-article-header h1')?.textContent).toBe(getHelpArticle('logging')!.title);
  });

  it('follows a compiled internal article link through the safe document renderer', async () => {
    await act(async () => root.render(<HelpCenter />));
    const link = Array.from(host.querySelectorAll<HTMLAnchorElement>('.help-document a')).find(item => item.textContent?.includes('快速入门'));
    expect(link).not.toBeUndefined();
    await act(async () => link!.click());
    expect(host.querySelector('.help-article-header h1')?.textContent).toBe(getHelpArticle('quick-start')!.title);
  });
});
