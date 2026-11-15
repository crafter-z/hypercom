import type { HelpArticle, HelpLink } from '../../types/help';
export const externalHelpDocuments: string[];
export function resolveHelpLink(sourcePath: string, href: string, articles: Pick<HelpArticle, 'id' | 'sourcePath' | 'headings'>[], repositoryRef?: string): HelpLink;
export function headingSlug(text: string): string;
