// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HelpDocument, getHelpArticle, getHelpImageUrl, helpCatalog, helpManifest, loadHelpArticle, searchHelp } from './index';
import type { HelpArticle, HelpBlock } from '../../types/help';

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment; });

function articleWith(blocks: HelpBlock[]): HelpArticle {
  return { ...helpManifest.articles[0], blocks };
}

describe('built-in help catalog', () => {
  it('loads all static articles without fetch or IPC', async () => {
    expect(helpCatalog.articles).toHaveLength(12);
    expect(helpCatalog.homeId).toBe('home');
    expect(await loadHelpArticle('quick-start')).toBe(getHelpArticle('quick-start'));
    expect(await loadHelpArticle('../../secret')).toBeUndefined();
    expect(getHelpImageUrl('images/overview.png')).toBeTypeOf('string');
    expect(getHelpImageUrl('https://example.com/image.png')).toBeUndefined();
    expect(getHelpImageUrl('../images/overview.png')).toBeUndefined();
  });
  it('searches actual rendered text with title priority and useful snippets', () => {
    expect(searchHelp('   ')).toEqual([]);
    expect(searchHelp('串口管理')[0].articleId).toBe('ports');
    expect(searchHelp('绝对不会存在的随机内容')).toEqual([]);
    const result = searchHelp('HEX 偶数')[0];
    expect(result.excerpt).toBeTruthy();
    expect(result.article.searchText).toContain('HEX');
    expect(result.article.searchText).toContain('偶数');
    expect(helpCatalog.resolveLink('home', '快速入门.md')).toEqual({ kind: 'internal', articleId: 'quick-start' });
    expect(helpCatalog.resolveLink('missing', 'README.md').kind).toBe('blocked');
  });
});

describe('closed help document renderer', () => {
  it('renders GFM structures and escaped raw HTML without executable elements', () => {
    const article = articleWith([
      { type: 'heading', id: 'intro', level: 2, children: [{ type: 'text', text: '标题' }] },
      { type: 'paragraph', children: [{ type: 'text', text: '<script>alert(1)</script>' }] },
      { type: 'code', language: 'html', text: '<img onerror=alert(1)>' },
      { type: 'table', align: ['left'], header: [[{ type: 'text', text: '列' }]], rows: [[[{ type: 'text', text: '值' }]]] },
      { type: 'list', ordered: true, start: 3, items: [{ children: [{ type: 'paragraph', children: [{ type: 'code', text: 'Ctrl+L' }] }] }] },
    ]);
    const html = renderToStaticMarkup(<HelpDocument article={article} onNavigate={() => {}} />);
    expect(html).toContain('id="help-heading-intro"');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<table>');
    expect(html).toContain('<ol start="3">');
  });
  it('does not render attacker-supplied executable URL or non-catalog image sources', () => {
    const article = articleWith([{ type: 'paragraph', children: [
      { type: 'link', target: { kind: 'external', url: 'javascript:alert(1)' }, children: [{ type: 'text', text: 'blocked' }] },
      { type: 'image', path: 'data:image/svg+xml,<svg onload=alert(1)>', alt: 'blocked image' },
    ] }]);
    const html = renderToStaticMarkup(<HelpDocument article={article} onNavigate={() => {}} />);
    expect(html).not.toContain('href=');
    expect(html).not.toContain('<img');
    expect(html).toContain('blocked image');
  });
  it('owns link clicks without navigating the host and exposes local screenshot metadata', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container), onNavigate = vi.fn(), onExternalLink = vi.fn(), onImage = vi.fn();
    const article = articleWith([{ type: 'paragraph', children: [
      { type: 'link', target: { kind: 'internal', articleId: 'quick-start', anchor: 'intro' }, children: [{ type: 'text', text: 'internal' }] },
      { type: 'link', target: { kind: 'external', url: 'https://example.com/help' }, children: [{ type: 'text', text: 'external' }] },
      { type: 'image', path: 'images/overview.png', alt: 'Screenshot' },
    ] }]);
    act(() => root.render(<HelpDocument article={article} onNavigate={onNavigate} onExternalLink={onExternalLink} onImage={onImage} />));
    const links = container.querySelectorAll('a');
    const internalEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => { links[0].dispatchEvent(internalEvent); links[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); container.querySelector('button')!.click(); });
    expect(internalEvent.defaultPrevented).toBe(true);
    expect(onNavigate).toHaveBeenCalledWith({ articleId: 'quick-start', anchor: 'intro' });
    expect(onExternalLink).toHaveBeenCalledWith('https://example.com/help');
    expect(onImage).toHaveBeenCalledWith(expect.objectContaining({ path: 'images/overview.png', alt: 'Screenshot', url: expect.any(String) }));
    act(() => root.unmount());
    container.remove();
  });
});
