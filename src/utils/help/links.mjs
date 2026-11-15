/** Shared by the Node compiler and WebView: never return unchecked navigation. */
export const externalHelpDocuments = ['docs/plugin-development.md', 'docs/architecture/plugins.md', 'docs/architecture/plugin-views.md', 'examples/plugin-views-demo/README.md', 'examples/plugin-marketplace/README.md'];
const externalDocuments = new Set(externalHelpDocuments);
function normalizeRelative(source, relative) {
  const parts = source.split('/');
  parts.pop();
  for (const part of relative.split('/')) {
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}
export function resolveHelpLink(sourcePath, href, articles, repositoryRef = 'main') {
  if (typeof href !== 'string' || !href || /[\u0000-\u0020\u007f\\]/u.test(href) || href.startsWith('//')) return { kind: 'blocked', reason: 'Unsafe or empty URL' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    try {
      const url = new URL(href);
      if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) return { kind: 'blocked', reason: 'Unsupported URL protocol or credentials' };
      return { kind: 'external', url: url.href };
    } catch { return { kind: 'blocked', reason: 'Malformed external URL' }; }
  }
  const hashIndex = href.indexOf('#'), rawPath = hashIndex < 0 ? href : href.slice(0, hashIndex);
  let decoded, anchor;
  try { decoded = decodeURIComponent(rawPath); anchor = hashIndex < 0 ? undefined : decodeURIComponent(href.slice(hashIndex + 1)); }
  catch { return { kind: 'blocked', reason: 'Malformed URL encoding' }; }
  if (/[\u0000-\u001f\u007f\\?#%]/u.test(decoded) || decoded.startsWith('/') || (anchor !== undefined && /[\u0000-\u001f\u007f]/u.test(anchor))) return { kind: 'blocked', reason: 'Unsafe relative path' };
  const targetPath = decoded ? normalizeRelative(sourcePath, decoded) : sourcePath;
  const article = articles.find(item => item.sourcePath === targetPath);
  if (article) {
    if (anchor && !article.headings.some(heading => heading.id === anchor)) return { kind: 'blocked', reason: `Unknown anchor: ${anchor}` };
    return { kind: 'internal', articleId: article.id, ...(anchor ? { anchor } : {}) };
  }
  if (externalDocuments.has(targetPath)) return { kind: 'external', url: `https://github.com/crafter-z/hypercom/blob/${encodeURIComponent(repositoryRef)}/${targetPath.split('/').map(encodeURIComponent).join('/')}${anchor ? `#${encodeURIComponent(anchor)}` : ''}` };
  return { kind: 'blocked', reason: `Unknown help document: ${targetPath}` };
}
export function headingSlug(text) {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
}
