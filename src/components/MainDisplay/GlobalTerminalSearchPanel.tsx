import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X, ChevronLeft, ChevronRight, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import Modal from '../shared/Modal';
import { usePluginViewOverlay } from '../shared/usePluginViewOverlay';
import SearchAdvancedOptions from './SearchAdvancedOptions';
import { createGlobalSearchSources, getGlobalTerminalSearchSources, subscribeGlobalTerminalSearch, type TerminalSearchRegistration } from './globalTerminalSearch';
import { DEFAULT_SEARCH_SPEC, type SearchHit, type SearchSpec, type SearchSnapshot } from '../../utils/terminal/search/searchTypes';
import { validateSearchSpec } from '../../utils/terminal/search/searchMatcher';
import { TerminalSearchSession } from '../../utils/terminal/search/searchSession';
import { useAppStore } from '../../stores/useAppStore';
import '../../styles/terminal-global-search.css';

const PAGE_SIZE = 50;
const EMPTY_SNAPSHOT: SearchSnapshot = { status: 'ready', hits: [], scanned: 0, truncated: false, incomplete: false };
interface Props { open: boolean; onClose: () => void; initialQuery?: string }

/** Highlight start-record match spans inside the lazy preview snippet. */
function renderHighlightedPreview(preview: string, hit: SearchHit): React.ReactNode {
  if (!preview || !hit.spans.length) return preview;
  const startSpans = hit.spans
    .filter(span => span.seq === hit.startSeq && span.end > span.start)
    .sort((a, b) => a.start - b.start);
  if (!startSpans.length) return preview;

  // Match viewportManager.previewSearchHit's leading ellipsis offset (`start - 40`).
  const expectedOffset = Math.max(0, startSpans[0].start - 40);
  const usesOffset = expectedOffset > 0 && preview.startsWith('…');
  const offset = usesOffset ? expectedOffset : 0;
  const prefixLen = usesOffset ? 1 : 0;
  const maxEnd = hit.endSeq > hit.startSeq && preview.endsWith(' ↵ …') ? preview.length - 4 : preview.length;

  const merged: Array<{ start: number; end: number }> = [];
  for (const span of startSpans) {
    const start = Math.max(prefixLen, span.start - offset + prefixLen);
    const end = Math.min(maxEnd, span.end - offset + prefixLen);
    if (end <= start) continue;
    const prev = merged[merged.length - 1];
    if (prev && start <= prev.end) prev.end = Math.max(prev.end, end);
    else merged.push({ start, end });
  }
  if (!merged.length) return preview;

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < merged.length; i++) {
    const { start, end } = merged[i];
    if (start > cursor) nodes.push(preview.slice(cursor, start));
    nodes.push(<mark key={i} className="terminal-search-mark">{preview.slice(start, end)}</mark>);
    cursor = end;
  }
  if (cursor < preview.length) nodes.push(preview.slice(cursor));
  return nodes;
}

/** Results are bounded metadata only; previews are read lazily for one page. */
export default function GlobalTerminalSearchPanel({ open, onClose, initialQuery }: Props) {
  const { t } = useTranslation();
  const overlayReady = usePluginViewOverlay(open);
  const registrations = useSyncExternalStore(subscribeGlobalTerminalSearch, getGlobalTerminalSearchSources, getGlobalTerminalSearchSources);
  const tabs = useAppStore(state => state.tabs);
  const ports = useAppStore(state => state.ports);
  const [options, setOptions] = useState<SearchSpec>({ ...DEFAULT_SEARCH_SPEC });
  const [query, setQuery] = useState('');
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [sort, setSort] = useState<'source' | 'time' | 'score'>('source');
  const [snapshot, setSnapshot] = useState<SearchSnapshot>(EMPTY_SNAPSHOT);
  const [page, setPage] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [navigationError, setNavigationError] = useState('');
  const queryRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<TerminalSearchSession | null>(null);
  const epoch = useRef(0);
  const prevOpenRef = useRef(false);
  const chosen = useMemo(() => registrations.filter(entry => !excluded.has(entry.id)), [registrations, excluded]);
  const byId = useMemo(() => new Map(registrations.map(entry => [entry.id, entry])), [registrations]);
  const sourceLabel = (entry: TerminalSearchRegistration) => {
    const port = ports.find(item => item.id === entry.portId);
    return port ? `${port.alias || port.name} (${port.id})` : tabs.find(tab => tab.id === entry.tabId)?.title ?? entry.portId ?? entry.id;
  };
  const dispose = useCallback(() => {
    epoch.current++;
    const session = sessionRef.current;
    sessionRef.current = null;
    session?.dispose();
  }, []);

  // Seed initialQuery on open when provided and non-empty; preserve last query/page otherwise.
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (open && !wasOpen && initialQuery) {
      setCancelled(false);
      if (initialQuery !== query) {
        setQuery(initialQuery);
        setPage(0);
        setActiveIndex(0);
      }
    }
  }, [open, initialQuery, query]);

  useEffect(() => {
    dispose();
    if (!open || !overlayReady) { setSnapshot(EMPTY_SNAPSHOT); if (!open) setCancelled(false); return; }
    if (cancelled) return;
    setNavigationError('');
    const spec = { ...options, query };
    const error = query ? validateSearchSpec(spec) : null;
    if (!query || error || !chosen.length) {
      setSnapshot({ ...EMPTY_SNAPSHOT, status: error ? 'error' : 'ready', error: error ?? undefined });
      return;
    }
    setSnapshot({ ...EMPTY_SNAPSHOT, status: 'scanning' });
    const generation = epoch.current;
    const timer = window.setTimeout(() => {
      if (generation !== epoch.current) return;
      const session = new TerminalSearchSession(createGlobalSearchSources(chosen), spec, value => {
        if (generation === epoch.current) setSnapshot(value);
      });
      sessionRef.current = session;
      session.start();
    }, 200);
    return () => { window.clearTimeout(timer); dispose(); };
  }, [open, overlayReady, options, query, chosen, cancelled, dispose]);

  const change = (patch: Partial<SearchSpec>) => {
    setCancelled(false);
    setPage(0);
    setActiveIndex(0);
    if (patch.mode && patch.mode !== 'fuzzy' && sort === 'score') setSort('source');
    setOptions(previous => ({ ...previous, ...patch }));
  };
  const close = () => { dispose(); onClose(); };
  const cancel = () => {
    sessionRef.current?.cancel();
    dispose(); setCancelled(true); setSnapshot(previous => ({ ...previous, status: 'cancelled' }));
  };
  const toggleSource = (id: string) => {
    setExcluded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    setPage(0);
    setActiveIndex(0);
    setCancelled(false);
  };
  const reveal = (hit: SearchHit) => {
    const entry = byId.get(hit.sourceId);
    if (!entry?.manager.isSearchHitValid(hit)) { setNavigationError(t('globalSearch.stale')); return; }
    entry.onReveal(hit, { ...options, query });
    close();
  };
  const effectiveSort = options.mode !== 'fuzzy' && sort === 'score' ? 'source' : sort;
  // Sorting is triggered by bounded result snapshots, never by RX/store counters.
  const hits = useMemo(() => {
    if (effectiveSort === 'source') return snapshot.hits;
    return [...snapshot.hits].sort(effectiveSort === 'score'
      ? (a, b) => (b.score ?? 0) - (a.score ?? 0) || a.startSeq - b.startSeq
      : (a, b) => (Number.isFinite(a.timestamp) ? a.timestamp : Infinity) - (Number.isFinite(b.timestamp) ? b.timestamp : Infinity));
  }, [snapshot.hits, effectiveSort]);
  const pages = Math.max(1, Math.ceil(hits.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visibleHits = hits.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const clampedActive = visibleHits.length > 0 ? Math.min(activeIndex, visibleHits.length - 1) : -1;

  const scrollActiveResultIntoView = (index: number) => {
    const el = resultsRef.current?.querySelectorAll<HTMLElement>('.global-terminal-search-result')[index];
    el?.scrollIntoView?.({ block: 'nearest' });
  };

  const handleQueryKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' && visibleHits.length > 0 && !options.multiline) {
      event.preventDefault();
      const next = clampedActive < 0 ? 0 : (clampedActive + 1) % visibleHits.length;
      setActiveIndex(next);
      scrollActiveResultIntoView(next);
    } else if (event.key === 'ArrowUp' && visibleHits.length > 0 && !options.multiline) {
      event.preventDefault();
      const next = clampedActive <= 0 ? visibleHits.length - 1 : clampedActive - 1;
      setActiveIndex(next);
      scrollActiveResultIntoView(next);
    } else if (event.key === 'Enter' && clampedActive >= 0 && visibleHits[clampedActive]) {
      if (options.multiline && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      reveal(visibleHits[clampedActive]);
    }
  };

  const sortOptions: ReadonlyArray<'source' | 'time' | 'score'> = options.mode === 'fuzzy'
    ? ['source', 'time', 'score']
    : ['source', 'time'];
  const isError = snapshot.status === 'error' || !!snapshot.error;

  if (!overlayReady) return null;
  return <Modal open={open} onClose={close} onOverlayClick={close} labelledBy="global-terminal-search-title"
    overlayClassName="global-terminal-search-overlay" dialogClassName="global-terminal-search-dialog" initialFocusRef={queryRef}>
    <header className="global-terminal-search-header">
      <h2 id="global-terminal-search-title"><Search size={17} />{t('globalSearch.title')}</h2>
      <button type="button" className="icon-btn" onClick={close} aria-label={t('globalSearch.close')}><X size={16} /></button>
    </header>
    <div className="global-terminal-search-controls">
      <div className="global-terminal-search-query-row">
        {options.multiline
          ? <textarea ref={node => { queryRef.current = node; }} className="global-terminal-search-query" aria-label={t('globalSearch.query')}
            aria-invalid={isError || undefined}
            placeholder={t('globalSearch.placeholder')} value={query} rows={2}
            onKeyDown={handleQueryKeyDown}
            onChange={event => { setCancelled(false); setPage(0); setActiveIndex(0); setQuery(event.target.value); }} />
          : <input ref={node => { queryRef.current = node; }} className="global-terminal-search-query" aria-label={t('globalSearch.query')}
            aria-invalid={isError || undefined}
            placeholder={t('globalSearch.placeholder')} value={query}
            onKeyDown={handleQueryKeyDown}
            onChange={event => { setCancelled(false); setPage(0); setActiveIndex(0); setQuery(event.target.value); }} />}
        <SearchAdvancedOptions spec={options} onChange={next => change(next)}
          extraActiveCount={Number(chosen.length !== registrations.length)} onReset={() => {
            setExcluded(new Set()); setCancelled(false); setPage(0); setActiveIndex(0); setSort('source'); setOptions({ ...DEFAULT_SEARCH_SPEC });
          }}>
          <fieldset className="global-terminal-search-sources"><legend>{t('globalSearch.sources')}</legend>
            {registrations.map(entry => <label key={entry.id}><input type="checkbox" checked={!excluded.has(entry.id)}
              onChange={() => toggleSource(entry.id)} />{sourceLabel(entry)}</label>)}
            {!registrations.length && <span>{t('globalSearch.emptySources')}</span>}
          </fieldset>
        </SearchAdvancedOptions>
      </div>
      <div className="global-terminal-search-context">
        <button
          type="button"
          className={`global-terminal-search-source-toggle${sourcesOpen ? ' active' : ''}`}
          aria-expanded={sourcesOpen}
          onClick={() => setSourcesOpen(prev => !prev)}
        >
          <span>{t('globalSearch.sourceSummary', { selected: chosen.length, total: registrations.length })}</span>
          {sourcesOpen ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
        </button>
        <small>{t('globalSearch.bufferOnly')}</small>
      </div>
      {sourcesOpen && (
        <fieldset className="global-terminal-search-sources global-terminal-search-sources-inline">
          <legend className="sr-only">{t('globalSearch.sources')}</legend>
          {registrations.map(entry => (
            <label key={entry.id}>
              <input type="checkbox" checked={!excluded.has(entry.id)} onChange={() => toggleSource(entry.id)} />
              {sourceLabel(entry)}
            </label>
          ))}
          {!registrations.length && <span>{t('globalSearch.emptySources')}</span>}
        </fieldset>
      )}
    </div>
    <div className={`global-terminal-search-status${isError ? ' has-error' : ''}`} role="status" aria-live="polite">
      {snapshot.error ? (
        <span className="global-terminal-search-error">
          <AlertCircle size={13} aria-hidden="true" />
          {t(snapshot.error)}
        </span>
      ) : t(snapshot.status === 'scanning' ? 'globalSearch.scanning' : snapshot.status === 'cancelled' ? 'globalSearch.cancelled' : 'globalSearch.resultCount', { count: hits.length, scanned: snapshot.scanned })}
      {(snapshot.truncated || snapshot.incomplete) && <span className="global-terminal-search-warning">{t('globalSearch.incomplete')}</span>}
      {snapshot.status === 'scanning' && <button type="button" className="btn btn-sm global-terminal-search-cancel" onClick={cancel}>{t('globalSearch.cancel')}</button>}
    </div>
    {navigationError && <div className="global-terminal-search-stale" role="alert">{navigationError}</div>}
    <div ref={resultsRef} className="global-terminal-search-results" role="list" aria-label={t('globalSearch.results')}>
      {visibleHits.map((hit, index) => {
        const entry = byId.get(hit.sourceId);
        const valid = entry?.manager.isSearchHitValid(hit);
        const preview = valid ? entry!.manager.previewSearchHit(hit, options) : t('globalSearch.stale');
        const selected = index === clampedActive;
        return <button type="button" role="listitem"
          className={`global-terminal-search-result${selected ? ' selected' : ''}`}
          aria-current={selected ? 'true' : undefined}
          key={`${hit.sourceId}:${hit.generation}:${hit.startSeq}:${hit.endSeq}`}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => reveal(hit)}>
          <span className="global-terminal-search-result-meta"><strong>{entry ? sourceLabel(entry) : hit.sourceId}</strong>
            <time>{Number.isFinite(hit.timestamp) ? new Date(hit.timestamp).toLocaleString() : '—'}</time><span>{hit.direction}</span>
            <span>{hit.startSeq === hit.endSeq ? `#${hit.startSeq}` : `#${hit.startSeq}–${hit.endSeq}`}</span>
            {hit.score != null && <span>{hit.score.toFixed(2)}</span>}</span>
          <span className="global-terminal-search-result-preview">
            {valid ? renderHighlightedPreview(preview, hit) : preview}
          </span>
        </button>;
      })}
      {!hits.length && snapshot.status !== 'scanning' && <div className="global-terminal-search-empty">{t(query ? 'globalSearch.noResults' : 'globalSearch.enterQuery')}</div>}
    </div>
    <footer className="global-terminal-search-footer">
      <span>{t('globalSearch.page', { current: currentPage + 1, total: pages })}</span>
      <label className="global-terminal-search-sort">{t('globalSearch.sort')} <select className="select" value={effectiveSort}
        onChange={event => { setSort(event.target.value as typeof sort); setPage(0); setActiveIndex(0); }}>
        {sortOptions.map(value => <option key={value} value={value}>{t(`globalSearch.sort.${value}`)}</option>)}
      </select></label>
      <div><button type="button" className="icon-btn" disabled={!currentPage} onClick={() => { setPage(currentPage - 1); setActiveIndex(0); }} aria-label={t('globalSearch.previousPage')}><ChevronLeft size={15} /></button>
        <button type="button" className="icon-btn" disabled={currentPage >= pages - 1} onClick={() => { setPage(currentPage + 1); setActiveIndex(0); }} aria-label={t('globalSearch.nextPage')}><ChevronRight size={15} /></button></div>
    </footer>
  </Modal>;
}
