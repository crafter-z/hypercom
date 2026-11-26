import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, BookOpen, ChevronRight, Home, List, Search, X } from 'lucide-react';
import { emit, listen } from '@tauri-apps/api/event';
import i18n from '../../i18n';
import { helpCatalog, HelpDocument } from '../../utils/help';
import { popoutEventService } from '../../services/tauri';
import { applyUiScale } from '../../utils/uiScale';
import type { HelpArticle, HelpLocation, HelpSearchResult } from '../../types/help';

interface HelpCenterProps {
  /** Initial target supplied by PopoutShell's validated URL parameters. */
  initialArticleId?: string | null;
  initialAnchor?: string | null;
}

interface HistoryEntry extends HelpLocation {
  searchQuery?: string;
}

const ARTICLE_IDS = [
  'quick-start', 'ports', 'terminal', 'transmission', 'logging', 'timeline',
  'rules', 'tools', 'settings', 'plugins', 'shortcuts',
] as const;

type HistoryLocation = HistoryEntry;

function getArticle(articleId: string): HelpArticle | undefined {
  return helpCatalog.getArticle(articleId);
}

function normalizeExternalUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.protocol !== 'mailto:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Read-only UserWiki UI. The catalog owns document parsing/rendering; this
 * component owns navigation, search and presentation state only.
 */
const HelpCenter: React.FC<HelpCenterProps> = ({ initialArticleId, initialAnchor }) => {
  const { t } = useTranslation();
  const searchRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const [articleId, setArticleId] = useState(() => getArticle(initialArticleId || 'home') ? (initialArticleId || 'home') : 'home');
  const [anchor, setAnchor] = useState<string | undefined>(initialAnchor || undefined);
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState<HistoryLocation[]>([{ articleId: initialArticleId || 'home', anchor: initialAnchor || undefined }]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchAnnouncement, setSearchAnnouncement] = useState('');

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ language?: unknown; theme?: unknown; uiScalePercent?: unknown }>('help:settings', event => {
      if (disposed) return;
      const { language, theme } = event.payload;
      if (language === 'zh-CN' || language === 'en-US') {
        void i18n.changeLanguage(language).catch(error => console.debug('[HelpCenter] language sync failed:', error));
      }
      if (theme === 'dark' || theme === 'light') {
        document.documentElement.setAttribute('data-theme', theme);
      } else if (theme === 'system') {
        const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
      }
      if (typeof event.payload.uiScalePercent === 'number' && Number.isFinite(event.payload.uiScalePercent)) {
        void applyUiScale(event.payload.uiScalePercent);
      }
    }).then(stop => {
      if (disposed) stop();
      else unlisten = stop;
      if (!disposed) void emit('help:settings-request').catch(error => console.debug('[HelpCenter] settings request failed:', error));
    }).catch(error => console.debug('[HelpCenter] settings listener failed:', error));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const article = getArticle(articleId) ?? getArticle('home');
  const results = useMemo<HelpSearchResult[]>(() => {
    const value = query.trim();
    if (!value) return [];
    try {
      return helpCatalog.search(value);
    } catch (error) {
      console.debug('[HelpCenter] search failed:', error);
      return [];
    }
  }, [query]);

  useEffect(() => {
    if (!query.trim()) {
      setSearchAnnouncement('');
      return;
    }
    setSearchAnnouncement(t('help.search.results', { count: results.length }));
  }, [query, results.length, t]);

  const scrollToAnchor = useCallback((nextAnchor?: string) => {
    if (!nextAnchor) {
      const main = mainRef.current;
      if (main) {
        if (typeof main.scrollTo === 'function') main.scrollTo({ top: 0, left: 0, behavior: 'auto' });
        else main.scrollTop = 0;
      }
      articleRef.current?.focus({ preventScroll: true });
      return;
    }
    window.requestAnimationFrame(() => {
      const heading = document.getElementById(`help-heading-${nextAnchor}`);
      if (heading) {
        if (typeof heading.scrollIntoView === 'function') heading.scrollIntoView({ block: 'start' });
        (heading as HTMLElement).tabIndex = -1;
        (heading as HTMLElement).focus({ preventScroll: true });
      }
    });
  }, []);

  useEffect(() => {
    scrollToAnchor(anchor);
  }, [articleId, anchor, scrollToAnchor]);

  const navigate = useCallback((location: HelpLocation, replace = false, fromSearchQuery?: string) => {
    const nextId = location.articleId || 'home';
    if (!getArticle(nextId)) return;
    const next: HistoryLocation = { articleId: nextId, anchor: location.anchor };
    setArticleId(nextId);
    setAnchor(location.anchor);
    setQuery('');
    if (replace) {
      setHistory(current => current.map((item, index) => index === historyIndex ? next : item));
      return;
    }
    setHistory(current => {
      const base = current.slice(0, historyIndex + 1);
      if (fromSearchQuery && base.length > 0) {
        base[base.length - 1] = { ...base[base.length - 1], searchQuery: fromSearchQuery };
      }
      return [...base, next];
    });
    setHistoryIndex(index => index + 1);
  }, [historyIndex]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void popoutEventService.onHelpOpen(payload => {
      if (disposed || !payload.articleId) return;
      navigate({
        articleId: payload.articleId,
        anchor: payload.anchor ?? undefined,
      });
    }).then(stop => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(error => console.debug('[HelpCenter] help-open listener failed:', error));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [navigate]);

  const goBack = useCallback(() => {
    if (historyIndex <= 0) return;
    const nextIndex = historyIndex - 1;
    const location = history[nextIndex];
    setHistoryIndex(nextIndex);
    setArticleId(location.articleId);
    setAnchor(location.anchor);
    setQuery(location.searchQuery ?? '');
  }, [history, historyIndex]);

  const goForward = useCallback(() => {
    if (historyIndex >= history.length - 1) return;
    const nextIndex = historyIndex + 1;
    const location = history[nextIndex];
    setHistoryIndex(nextIndex);
    setArticleId(location.articleId);
    setAnchor(location.anchor);
    setQuery('');
  }, [history, historyIndex]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (event.key === '/' && document.activeElement !== searchRef.current && !(event.target instanceof HTMLInputElement)) {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        goBack();
      } else if (event.altKey && event.key === 'ArrowRight') {
        event.preventDefault();
        goForward();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goBack, goForward]);

  const openExternal = (url: string) => {
    const safeUrl = normalizeExternalUrl(url);
    if (!safeUrl) return;
    void emit('help:external-link', { url: safeUrl }).catch(error => console.debug('[HelpCenter] external link relay failed:', error));
  };

  const articleTitle = article?.title || t('help.title');
  const sectionLabel = articleId === 'home' ? t('help.home') : t(`help.section.${articleId}`, { defaultValue: articleTitle });

  return (
    <div className="help-center" aria-label={t('help.title')}>
      <a className="help-skip-link" href="#help-article">{t('help.skipToArticle')}</a>
      <header className="help-toolbar">
        <div className="help-toolbar-nav" role="group" aria-label={t('help.history')}>
          <button type="button" className="icon-btn" onClick={goBack} disabled={historyIndex <= 0} title={t('help.back')} aria-label={t('help.back')}>
            <ArrowLeft size={15} />
          </button>
          <button type="button" className="icon-btn" onClick={goForward} disabled={historyIndex >= history.length - 1} title={t('help.forward')} aria-label={t('help.forward')}>
            <ArrowRight size={15} />
          </button>
          <button type="button" className="icon-btn" onClick={() => navigate({ articleId: 'home' })} title={t('help.home')} aria-label={t('help.home')}>
            <Home size={15} />
          </button>
        </div>
        <div className="help-search-wrap">
          <Search size={15} aria-hidden="true" />
          <input
            ref={searchRef}
            className="help-search"
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('help.search.placeholder')}
            aria-label={t('help.search.label')}
            aria-controls="help-search-results"
            aria-describedby="help-search-status"
          />
          {query && <button type="button" className="icon-btn help-search-clear" onClick={() => setQuery('')} title={t('help.search.clear')} aria-label={t('help.search.clear')}><X size={13} /></button>}
          <span id="help-search-status" className="sr-only" aria-live="polite">{searchAnnouncement}</span>
        </div>
        <button type="button" className="icon-btn help-sidebar-toggle" onClick={() => setSidebarOpen(value => !value)} aria-expanded={sidebarOpen} title={t('help.toggleNavigation')} aria-label={t('help.toggleNavigation')}>
          <List size={15} />
        </button>
      </header>

      <div className="help-body">
        {sidebarOpen && (
          <nav className="help-sidebar" aria-label={t('help.navigation')}>
            <button type="button" className={`help-home-link${articleId === 'home' ? ' active' : ''}`} onClick={() => navigate({ articleId: 'home' })} aria-current={articleId === 'home' ? 'page' : undefined}>
              <BookOpen size={15} />
              <span>{t('help.home')}</span>
            </button>
            <div className="help-nav-section-title">{t('help.topics')}</div>
            <ul className="help-nav-list">
              {ARTICLE_IDS.map(id => {
                const navArticle = getArticle(id);
                if (!navArticle) return null;
                const active = articleId === id;
                return (
                  <li key={id}>
                    <button type="button" className={`help-nav-item${active ? ' active' : ''}`} onClick={() => navigate({ articleId: id })} aria-current={active ? 'page' : undefined}>
                      <span>{navArticle.title || t(`help.section.${id}`, { defaultValue: id })}</span>
                      {active && <ChevronRight size={13} aria-hidden="true" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}

        <main ref={mainRef} className="help-main" id="help-article" tabIndex={-1}>
          {query.trim() ? (
            <section className="help-search-results" id="help-search-results" aria-labelledby="help-search-results-title">
              <div className="help-breadcrumb"><span>{t('help.search.label')}</span></div>
              <h1 id="help-search-results-title">{t('help.search.resultsTitle')}</h1>
              {results.length === 0 ? (
                <div className="help-empty-state" role="status">{t('help.search.noResults', { query })}</div>
              ) : (
                <div className="help-results-list">
                  {results.map(result => (
                    <button type="button" className="help-result" key={`${result.articleId}:${result.anchor || ''}`} onClick={() => navigate({ articleId: result.articleId, anchor: result.anchor }, false, query)}>
                      <span className="help-result-title">{result.title}</span>
                      <span className="help-result-excerpt">{result.excerpt}</span>
                      <span className="help-result-path">{result.article.title}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          ) : (
            <>
              <div className="help-breadcrumb" aria-label={t('help.breadcrumb')}>
                <button type="button" onClick={() => navigate({ articleId: 'home' })}>{t('help.home')}</button>
                {articleId !== 'home' && <><ChevronRight size={13} aria-hidden="true" /><span aria-current="page">{sectionLabel}</span></>}
              </div>
              {article ? (
                <article ref={articleRef} className="help-article" tabIndex={-1} aria-labelledby="help-article-title">
                  <header className="help-article-header">
                    <h1 id="help-article-title">{article.title}</h1>
                    {article.description && <p className="help-article-description">{article.description}</p>}
                  </header>
                  <HelpDocument
                    article={article}
                    onNavigate={location => navigate(location)}
                    onExternalLink={openExternal}
                  />
                </article>
              ) : (
                <div className="help-empty-state" role="status">{t('help.articleUnavailable')}</div>
              )}
            </>
          )}
        </main>

        {!query.trim() && article && article.headings.length > 0 && (
          <aside className="help-toc" aria-label={t('help.onThisPage')}>
            <div className="help-toc-title">{t('help.onThisPage')}</div>
            <ul>
              {article.headings.map(heading => (
                <li key={heading.id} className={`help-toc-level-${Math.max(1, Math.min(6, heading.level))}`}>
                  <button type="button" onClick={() => navigate({ articleId, anchor: heading.id }, true)}>{heading.text}</button>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>
    </div>
  );
};

export default HelpCenter;
