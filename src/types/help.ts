/** Build-time Markdown is lowered to this closed, HTML-free document model. */
export type HelpArticleId = 'home' | 'quick-start' | 'ports' | 'terminal' | 'transmission' | 'logging' | 'timeline' | 'rules' | 'tools' | 'settings' | 'plugins' | 'shortcuts';
export interface HelpLocation { articleId: string; anchor?: string }
export type HelpLink =
  | { kind: 'internal'; articleId: string; anchor?: string }
  | { kind: 'external'; url: string }
  | { kind: 'blocked'; reason: string };
export type HelpInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'break' }
  | { type: 'strong' | 'emphasis' | 'delete'; children: HelpInline[] }
  | { type: 'link'; target: HelpLink; children: HelpInline[] }
  | { type: 'image'; path: string; alt: string; title?: string };
export type HelpBlock =
  | { type: 'paragraph'; children: HelpInline[] }
  | { type: 'heading'; id: string; level: number; children: HelpInline[] }
  | { type: 'code'; text: string; language: string }
  | { type: 'quote'; children: HelpBlock[] }
  | { type: 'list'; ordered: boolean; start: number; items: Array<{ checked?: boolean; children: HelpBlock[] }> }
  | { type: 'table'; align: Array<'left' | 'center' | 'right' | null>; header: HelpInline[][]; rows: HelpInline[][][] }
  | { type: 'rule' };
export interface HelpHeading { id: string; text: string; level: number }
export interface HelpArticle {
  id: HelpArticleId;
  title: string;
  description: string;
  locale: 'zh-CN';
  sourcePath: string;
  headings: HelpHeading[];
  blocks: HelpBlock[];
  searchText: string;
}
export interface HelpManifest { version: 1; locale: 'zh-CN'; homeId: HelpArticleId; repositoryRef: string; articles: HelpArticle[] }
export interface HelpSearchResult { article: HelpArticle; articleId: string; title: string; excerpt: string; score: number; anchor?: string }
export interface HelpImage { path: string; url: string; alt: string; title?: string }
