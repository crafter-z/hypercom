import { readFile, writeFile, readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Lexer } from 'marked';
import { decodeHTML } from 'entities';
import { externalHelpDocuments, resolveHelpLink, headingSlug } from '../src/utils/help/links.mjs';
export { resolveHelpLink, headingSlug } from '../src/utils/help/links.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const ARTICLE_SOURCES = [
  ['home', 'README.md'], ['quick-start', '快速入门.md'], ['ports', '串口管理.md'],
  ['terminal', '终端显示.md'], ['transmission', '数据收发.md'], ['logging', '日志记录.md'],
  ['timeline', '时间联动.md'], ['rules', '规则与协议.md'], ['tools', '外部工具.md'],
  ['settings', '设置.md'], ['plugins', '插件.md'], ['shortcuts', '快捷键.md'],
];
const EXTERNAL_DOCS = new Set(externalHelpDocuments);
const WIKI = 'docs/userwiki/';
const SAFE_IMAGE = /^images\/[a-zA-Z0-9_-]+\.(png|jpe?g|gif|webp)$/i;

function tokenText(tokens = []) {
  return tokens.map(token => token.tokens ? tokenText(token.tokens) : token.type === 'codespan' ? token.text : decodeHTML(token.text ?? (token.type === 'br' ? '\n' : ''))).join('');
}
function collectHeadings(tokens) {
  const used = new Set(), headings = [];
  const visit = items => {
    for (const token of items) {
      if (token.type === 'heading') {
        const text = tokenText(token.tokens), base = headingSlug(text);
        let id = base, suffix = 0;
        while (used.has(id)) id = `${base}-${++suffix}`;
        used.add(id);
        headings.push({ id, text, level: token.depth });
      } else if (token.type === 'blockquote') visit(token.tokens);
      else if (token.type === 'list') for (const item of token.items) visit(item.tokens);
    }
  };
  visit(tokens);
  return headings;
}
function requireLink(sourcePath, href, articles, ref) {
  const target = resolveHelpLink(sourcePath, href, articles, ref);
  if (target.kind === 'blocked') throw new Error(`${sourcePath}: ${target.reason} (${href})`);
  return target;
}
function inline(tokens, context) {
  return (tokens ?? []).flatMap(token => {
    switch (token.type) {
      case 'text': case 'escape': return token.tokens ? inline(token.tokens, context) : [{ type: 'text', text: decodeHTML(token.text) }];
      case 'html': return [{ type: 'text', text: token.raw }]; // Never interpret raw HTML.
      case 'codespan': return [{ type: 'code', text: token.text }];
      case 'br': return [{ type: 'break' }];
      case 'strong': case 'em': case 'del': return [{ type: token.type === 'em' ? 'emphasis' : token.type === 'del' ? 'delete' : 'strong', children: inline(token.tokens, context) }];
      case 'link': return [{ type: 'link', target: requireLink(context.sourcePath, decodeHTML(token.href), context.articles, context.ref), children: inline(token.tokens, context) }];
      case 'image': {
        let imagePath;
        try { imagePath = decodeURIComponent(token.href); } catch { throw new Error(`${context.sourcePath}: invalid image encoding`); }
        if (!SAFE_IMAGE.test(imagePath) || !context.images.has(imagePath)) throw new Error(`${context.sourcePath}: missing or unsafe image (${token.href})`);
        return [{ type: 'image', path: imagePath, alt: token.text ?? '', ...(token.title ? { title: token.title } : {}) }];
      }
      default: throw new Error(`${context.sourcePath}: unsupported inline Markdown token ${token.type}`);
    }
  });
}
function blocks(tokens, context) {
  return tokens.flatMap(token => {
    switch (token.type) {
      case 'space': case 'checkbox': return []; // Task state is carried by its owning list item.
      case 'heading': {
        const heading = context.headings[context.headingIndex++];
        return [{ type: 'heading', id: heading.id, level: token.depth, children: inline(token.tokens, context) }];
      }
      case 'paragraph': case 'text': return [{ type: 'paragraph', children: token.tokens ? inline(token.tokens, context) : [{ type: 'text', text: token.text }] }];
      case 'html': return [{ type: 'paragraph', children: [{ type: 'text', text: token.raw }] }];
      case 'code': return [{ type: 'code', text: token.text, language: (token.lang ?? '').split(/\s/)[0] }];
      case 'hr': return [{ type: 'rule' }];
      case 'blockquote': return [{ type: 'quote', children: blocks(token.tokens, context) }];
      case 'list': return [{ type: 'list', ordered: token.ordered, start: token.ordered ? Number(token.start) || 1 : 1, items: token.items.map(item => ({ ...(item.task ? { checked: Boolean(item.checked) } : {}), children: blocks(item.tokens, context) })) }];
      case 'table': return [{ type: 'table', align: token.align, header: token.header.map(cell => inline(cell.tokens, context)), rows: token.rows.map(row => row.map(cell => inline(cell.tokens, context))) }];
      default: throw new Error(`${context.sourcePath}: unsupported block Markdown token ${token.type}`);
    }
  });
}
function plainBlocks(items) {
  const text = nodes => nodes.map(item => item.text ?? (item.type === 'image' ? item.alt : item.children ? text(item.children) : '')).join('');
  return items.map(item => {
    if (item.type === 'table') return [item.header, ...item.rows].map(row => row.map(text).join(' ')).join('\n');
    if (item.type === 'list') return item.items.map(entry => plainBlocks(entry.children)).join('\n');
    if (item.type === 'quote') return plainBlocks(item.children);
    return item.text ?? (item.children ? text(item.children) : '');
  }).join('\n');
}

/** Pure compiler, also used by the quality-gate tests. */
export function compileHelpContent(sources, imagePaths, repositoryRef = 'main') {
  if (!sources.length) throw new Error('Built-in help requires at least one article');
  const ids = new Set(), paths = new Set(), tokenSets = new Map();
  const articles = sources.map(source => {
    if (!/^[a-z][a-z0-9-]*$/.test(source.id) || ids.has(source.id)) throw new Error(`Invalid or duplicate help id: ${source.id}`);
    if (!/^docs\/userwiki\/[^/\\]+\.md$/u.test(source.sourcePath) || paths.has(source.sourcePath)) throw new Error(`Invalid or duplicate help source: ${source.sourcePath}`);
    ids.add(source.id); paths.add(source.sourcePath);
    const tokens = Lexer.lex(source.markdown, { gfm: true, breaks: false });
    tokenSets.set(source.id, tokens);
    const headings = collectHeadings(tokens);
    if (tokens.find(token => token.type !== 'space')?.type !== 'heading' || !headings.length || headings[0].level !== 1) throw new Error(`${source.sourcePath}: article must begin with an H1 heading`);
    return { id: source.id, title: headings[0].text, description: '', locale: 'zh-CN', sourcePath: source.sourcePath, headings, blocks: [], searchText: '' };
  });
  for (const article of articles) {
    article.blocks = blocks(tokenSets.get(article.id), { sourcePath: article.sourcePath, articles, images: new Set(imagePaths), headings: article.headings, headingIndex: 0, ref: repositoryRef });
    article.searchText = plainBlocks(article.blocks);
    const introduction = article.blocks.find(item => item.type === 'paragraph');
    article.description = introduction ? plainBlocks([introduction]).slice(0, 160) : article.title;
  }
  return { version: 1, locale: 'zh-CN', homeId: articles.some(item => item.id === 'home') ? 'home' : articles[0]?.id, repositoryRef, articles };
}

async function checkedFile(root, relative) {
  const absolute = path.resolve(root, relative), info = await lstat(absolute);
  const resolved = await realpath(absolute), realRoot = await realpath(root);
  if (!info.isFile() || info.isSymbolicLink() || !resolved.startsWith(`${realRoot}${path.sep}`)) throw new Error(`Help resources must be regular repository files: ${relative}`);
  return readFile(absolute);
}
export async function buildHelp(root = ROOT, check = false) {
  const files = await readdir(path.join(root, WIKI));
  const expected = new Set(ARTICLE_SOURCES.map(([, source]) => source));
  for (const file of files.filter(file => file.endsWith('.md'))) if (!expected.has(file)) throw new Error(`UserWiki page lacks a stable help id: ${file}`);
  const sources = await Promise.all(ARTICLE_SOURCES.map(async ([id, file]) => ({ id, sourcePath: `${WIKI}${file}`, markdown: (await checkedFile(root, `${WIKI}${file}`)).toString('utf8').replace(/\r\n?/g, '\n') })));
  const imagePaths = (await readdir(path.join(root, WIKI, 'images'))).map(name => `images/${name}`).filter(name => SAFE_IMAGE.test(name)).sort();
  const imageBytes = await Promise.all(imagePaths.map(name => checkedFile(root, `${WIKI}${name}`)));
  for (const relative of EXTERNAL_DOCS) await checkedFile(root, relative);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const manifest = compileHelpContent(sources, imagePaths, `v${pkg.version}`);
  const digest = createHash('sha256').update(JSON.stringify(sources)).update(imageBytes.map(bytes => createHash('sha256').update(bytes).digest('hex')).join('')).digest('hex');
  const content = `${JSON.stringify({ ...manifest, sourceDigest: digest }, null, 2)}\n`;
  const output = path.join(root, 'src/utils/help/generated.json');
  if (check) {
    const existing = await readFile(output, 'utf8').catch(() => '');
    if (existing.replace(/\r\n?/g, '\n') !== content) throw new Error('Built-in help is stale. Run npm run help:build and commit the generated manifest.');
  } else await writeFile(output, content, 'utf8');
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = await buildHelp(ROOT, process.argv.includes('--check'));
    console.log(`Built-in help ${process.argv.includes('--check') ? 'validated' : 'built'}: ${manifest.articles.length} articles (${manifest.locale}).`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
