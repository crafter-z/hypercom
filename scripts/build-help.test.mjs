import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHelp, compileHelpContent, headingSlug, resolveHelpLink, ARTICLE_SOURCES } from './build-help.mjs';

const source = (markdown, id = 'home', file = 'README.md') => ({ id, sourcePath: `docs/userwiki/${file}`, markdown });
const compile = markdown => compileHelpContent([source(markdown)], ['images/test.png']);

test('repository help is generated deterministically and has all stable article IDs', async () => {
  const manifest = await buildHelp(undefined, true);
  assert.equal(manifest.locale, 'zh-CN');
  assert.equal(manifest.homeId, 'home');
  assert.deepEqual(manifest.articles.map(article => article.id), ARTICLE_SOURCES.map(([id]) => id));
  assert.equal(manifest.articles.length, 12);
  for (const article of manifest.articles) {
    assert.ok(article.title && article.description && article.searchText);
    assert.equal(new Set(article.headings.map(item => item.id)).size, article.headings.length);
  }
});

test('compiles GFM table, ordered/nested lists, tasks, images, quote and fenced code to closed nodes', () => {
  const manifest = compile('# Intro\n\n**Bold** and *italic* ~~removed~~ `code` &amp; text\n\n|A|B|\n|:-|--:|\n|one|two|\n\n1. first\n   - nested\n\n- [x] done\n\n> quote\n\n```js\nalert("<unsafe>");\n```\n\n![Screenshot](images/test.png)');
  const article = manifest.articles[0];
  assert.ok(article.blocks.some(block => block.type === 'table'));
  assert.ok(article.blocks.some(block => block.type === 'list' && block.ordered));
  assert.ok(article.blocks.some(block => block.type === 'list' && block.items.some(item => item.checked === true)));
  assert.ok(article.blocks.some(block => block.type === 'quote'));
  assert.ok(article.blocks.some(block => block.type === 'code' && block.language === 'js'));
  assert.match(article.searchText, /Bold and italic removed code & text/);
});

test('raw HTML is text, never an executable node', () => {
  const article = compile('# Safe\n\n<script>alert(1)</script>\n\nText <img src=x onerror=alert(1)>').articles[0];
  assert.match(article.searchText, /<script>alert\(1\)<\/script>/);
  assert.ok(!JSON.stringify(article.blocks).includes('"type":"html"'));
});

test('internal cross-page, Chinese encoded paths and anchors resolve before rendering', () => {
  const manifest = compileHelpContent([
    source('# Home\n\n[中文](%E5%BF%AB%E9%80%9F%E5%85%A5%E9%97%A8.md#start)'),
    source('# Start\n\n## Details', 'quick-start', '快速入门.md'),
  ], []);
  const link = manifest.articles[0].blocks[1].children[0];
  assert.deepEqual(link.target, { kind: 'internal', articleId: 'quick-start', anchor: 'start' });
  assert.deepEqual(resolveHelpLink('docs/userwiki/快速入门.md', '#details', manifest.articles), { kind: 'internal', articleId: 'quick-start', anchor: 'details' });
});

test('validates links, local images, unknown pages, and missing anchors strictly', () => {
  for (const markdown of [
    '# Broken\n\n[missing](missing.md)', '# Broken\n\n[missing](#missing)',
    '# Broken\n\n![missing](images/missing.png)', '# Broken\n\n![remote](https://example.com/image.png)',
    '# Broken\n\n![svg](images/test.svg)', '# Broken\n\n[unsafe](javascript:alert(1))',
    '# Broken\n\n[unsafe](java&#x73;cript:alert(1))',
  ]) assert.throws(() => compile(markdown), /missing|unsafe|Unknown|Unsupported/i);
});

test('runtime URL boundary blocks schemes, protocol-relative, traversal, controls and double encoding', () => {
  const articles = compile('# Home').articles;
  for (const href of ['javascript:alert(1)', 'data:text/html,x', 'file:///C:/secret', '//evil.test/a', 'https://user:password@example.com', '..\\secret.md', '../../../secret.md', '%2f%2fevil.test/a', '%252e%252e/README.md', '#bad%00anchor', 'https://example.com\n/path', '%zz']) {
    assert.equal(resolveHelpLink(articles[0].sourcePath, href, articles).kind, 'blocked', href);
  }
  assert.equal(resolveHelpLink(articles[0].sourcePath, 'https://example.com/help', articles).kind, 'external');
  assert.equal(resolveHelpLink(articles[0].sourcePath, 'mailto:help@example.com', articles).kind, 'external');
  const developer = resolveHelpLink(articles[0].sourcePath, '../plugin-development.md', articles, 'v1.1.3');
  assert.equal(developer.kind, 'external');
  assert.match(developer.url, /github\.com\/crafter-z\/hypercom\/blob\/v1\.1\.3\/docs\/plugin-development\.md$/);
});

test('heading slugs are stable, unique even on suffix collisions, and include nested headings', () => {
  const headings = compile('# A\n\n## A\n\n## A-1\n\n> ### A\n\n## 中文标题').articles[0].headings;
  assert.deepEqual(headings.map(item => item.id), ['a', 'a-1', 'a-1-1', 'a-2', '中文标题']);
  assert.equal(headingSlug('**中文**  Heading!'), '中文-heading');
});

test('duplicate stable IDs, duplicate source paths and missing H1 fail compilation', () => {
  assert.throws(() => compileHelpContent([source('# A'), source('# B')], []), /duplicate/);
  assert.throws(() => compile('Paragraph before heading\n\n# Title'), /H1/);
  assert.throws(() => compile('## Missing H1'), /H1/);
});
