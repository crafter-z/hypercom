const imageModules = import.meta.glob('../../../docs/userwiki/images/*.{png,jpg,jpeg,gif,webp}', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const imageUrls = new Map(Object.entries(imageModules).map(([key, url]) => [key.slice(key.indexOf('/images/') + 1), url]));
/** Only local images enumerated by Vite can become DOM sources. */
export function getHelpImageUrl(imagePath: string): string | undefined { return imageUrls.get(imagePath); }
