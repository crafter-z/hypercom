import generated from './generated.json';
import { resolveHelpLink } from './links.mjs';
import type { HelpArticle, HelpLink, HelpManifest, HelpSearchResult } from '../../types/help';

export type { HelpArticle, HelpArticleId, HelpBlock, HelpHeading, HelpImage, HelpInline, HelpLink, HelpLocation, HelpManifest, HelpSearchResult } from '../../types/help';
export { HelpDocument, type HelpDocumentProps } from './HelpDocument';
export { headingSlug } from './links.mjs';

/** Local build artifact, not an HTTP endpoint or filesystem capability. */
export const helpManifest = generated as unknown as HelpManifest;
const byId = new Map(helpManifest.articles.map(article => [article.id as string, article]));
export function getHelpArticle(id: string): HelpArticle | undefined { return byId.get(id); }
export async function loadHelpArticle(id: string): Promise<HelpArticle | undefined> { return getHelpArticle(id); }

export { getHelpImageUrl } from './assets';

export function searchHelp(query: string): HelpSearchResult[] {
  const terms = query.trim().toLocaleLowerCase('zh-CN').split(/\s+/u).filter(Boolean);
  if (!terms.length) return [];
  return helpManifest.articles.flatMap(article => {
    const title = article.title.toLocaleLowerCase('zh-CN'), text = article.searchText.toLocaleLowerCase('zh-CN');
    if (!terms.every(term => text.includes(term) || title.includes(term))) return [];
    const score = terms.reduce((sum, term) => sum + (title.includes(term) ? 30 : 0) + article.headings.filter(heading => heading.text.toLocaleLowerCase('zh-CN').includes(term)).length * 5 + Math.min(10, text.split(term).length - 1), 0);
    const first = Math.max(0, Math.min(...terms.map(term => text.indexOf(term)).filter(index => index >= 0)) - 32);
    const start = Number.isFinite(first) ? first : 0;
    const excerpt = `${start ? '…' : ''}${article.searchText.slice(start, start + 140).replace(/\s+/g, ' ')}${start + 140 < article.searchText.length ? '…' : ''}`;
    const heading = article.headings.find(item => terms.some(term => item.text.toLocaleLowerCase('zh-CN').includes(term)));
    return [{ article, articleId: article.id, title: article.title, excerpt, score, ...(heading ? { anchor: heading.id } : {}) }];
  }).sort((left, right) => right.score - left.score);
}
export function resolveLink(articleId: string, href: string): HelpLink {
  const article = getHelpArticle(articleId);
  return article ? resolveHelpLink(article.sourcePath, href, helpManifest.articles, helpManifest.repositoryRef) : { kind: 'blocked', reason: 'Unknown help article' };
}
export const helpCatalog = {
  articles: helpManifest.articles,
  homeId: helpManifest.homeId,
  locale: helpManifest.locale,
  getArticle: getHelpArticle,
  loadArticle: loadHelpArticle,
  search: searchHelp,
  resolveLink,
};
