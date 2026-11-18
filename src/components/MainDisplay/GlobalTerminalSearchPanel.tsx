import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X, ChevronLeft, ChevronRight } from 'lucide-react';
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
interface Props { open: boolean; onClose: () => void }

/** Results are bounded metadata only; previews are read lazily for one page. */
export default function GlobalTerminalSearchPanel({ open, onClose }: Props) {
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
  const [cancelled, setCancelled] = useState(false);
  const [navigationError, setNavigationError] = useState('');
  const queryRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const sessionRef = useRef<TerminalSearchSession | null>(null);
  const epoch = useRef(0);
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

  useEffect(() => {
    dispose();
    if (!open || !overlayReady) { setSnapshot(EMPTY_SNAPSHOT); if (!open) setCancelled(false); return; }
    if (cancelled) return;
    setPage(0); setNavigationError('');
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
    setOptions(previous => ({ ...previous, ...patch }));
  };
  const close = () => { dispose(); onClose(); };
  const cancel = () => {
    sessionRef.current?.cancel();
    dispose(); setCancelled(true); setSnapshot(previous => ({ ...previous, status: 'cancelled' }));
  };
  const toggleSource = (id: string) => {
    setExcluded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    setCancelled(false);
  };
  const reveal = (hit: SearchHit) => {
    const entry = byId.get(hit.sourceId);
    if (!entry?.manager.isSearchHitValid(hit)) { setNavigationError(t('globalSearch.stale')); return; }
    entry.onReveal(hit, { ...options, query });
    close();
  };
  // Sorting is triggered by bounded result snapshots, never by RX/store counters.
  const hits = useMemo(() => {
    if (sort === 'source') return snapshot.hits;
    return [...snapshot.hits].sort(sort === 'score'
      ? (a, b) => (b.score ?? 0) - (a.score ?? 0) || a.startSeq - b.startSeq
      : (a, b) => (Number.isFinite(a.timestamp) ? a.timestamp : Infinity) - (Number.isFinite(b.timestamp) ? b.timestamp : Infinity));
  }, [snapshot.hits, sort]);
  const pages = Math.max(1, Math.ceil(hits.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visibleHits = hits.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
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
            placeholder={t('globalSearch.placeholder')} value={query} rows={2} onChange={event => { setCancelled(false); setQuery(event.target.value); }} />
          : <input ref={node => { queryRef.current = node; }} className="global-terminal-search-query" aria-label={t('globalSearch.query')}
            placeholder={t('globalSearch.placeholder')} value={query} onChange={event => { setCancelled(false); setQuery(event.target.value); }} />}
        <SearchAdvancedOptions spec={options} onChange={next => change(next)}
          extraActiveCount={Number(chosen.length !== registrations.length)} onReset={() => {
            setExcluded(new Set()); setCancelled(false); setOptions({ ...DEFAULT_SEARCH_SPEC });
          }}>
          <fieldset className="global-terminal-search-sources"><legend>{t('globalSearch.sources')}</legend>
            {registrations.map(entry => <label key={entry.id}><input type="checkbox" checked={!excluded.has(entry.id)}
              onChange={() => toggleSource(entry.id)} />{sourceLabel(entry)}</label>)}
            {!registrations.length && <span>{t('globalSearch.emptySources')}</span>}
          </fieldset>
        </SearchAdvancedOptions>
      </div>
      <div className="global-terminal-search-context"><span>{t('globalSearch.sourceSummary', { selected: chosen.length, total: registrations.length })}</span>
        <small>{t('globalSearch.bufferOnly')}</small></div>
    </div>
    <div className="global-terminal-search-status" role="status" aria-live="polite">
      {snapshot.error ? t(snapshot.error) : t(snapshot.status === 'scanning' ? 'globalSearch.scanning' : snapshot.status === 'cancelled' ? 'globalSearch.cancelled' : 'globalSearch.resultCount', { count: hits.length, scanned: snapshot.scanned })}
      {(snapshot.truncated || snapshot.incomplete) && <span className="global-terminal-search-warning">{t('globalSearch.incomplete')}</span>}
      {snapshot.status === 'scanning' && <button type="button" className="btn btn-sm global-terminal-search-cancel" onClick={cancel}>{t('globalSearch.cancel')}</button>}
    </div>
    {navigationError && <div className="global-terminal-search-stale" role="alert">{navigationError}</div>}
    <div className="global-terminal-search-results" role="list" aria-label={t('globalSearch.results')}>
      {visibleHits.map(hit => {
        const entry = byId.get(hit.sourceId);
        const valid = entry?.manager.isSearchHitValid(hit);
        const preview = valid ? entry!.manager.previewSearchHit(hit, options) : t('globalSearch.stale');
        return <button type="button" role="listitem" className="global-terminal-search-result"
          key={`${hit.sourceId}:${hit.generation}:${hit.startSeq}:${hit.endSeq}`} onClick={() => reveal(hit)}>
          <span className="global-terminal-search-result-meta"><strong>{entry ? sourceLabel(entry) : hit.sourceId}</strong>
            <time>{Number.isFinite(hit.timestamp) ? new Date(hit.timestamp).toLocaleString() : '—'}</time><span>{hit.direction}</span>
            <span>{hit.startSeq === hit.endSeq ? `#${hit.startSeq}` : `#${hit.startSeq}–${hit.endSeq}`}</span>
            {hit.score != null && <span>{hit.score.toFixed(2)}</span>}</span>
          <span className="global-terminal-search-result-preview">{preview}</span>
        </button>;
      })}
      {!hits.length && snapshot.status !== 'scanning' && <div className="global-terminal-search-empty">{t(query ? 'globalSearch.noResults' : 'globalSearch.enterQuery')}</div>}
    </div>
    <footer className="global-terminal-search-footer">
      <span>{t('globalSearch.page', { current: currentPage + 1, total: pages })}</span>
      <label className="global-terminal-search-sort">{t('globalSearch.sort')} <select className="select" value={sort}
        onChange={event => { setSort(event.target.value as typeof sort); setPage(0); }}>
        {(['source', 'time', 'score'] as const).map(value => <option key={value} value={value}>{t(`globalSearch.sort.${value}`)}</option>)}
      </select></label>
      <div><button type="button" className="icon-btn" disabled={!currentPage} onClick={() => setPage(currentPage - 1)} aria-label={t('globalSearch.previousPage')}><ChevronLeft size={15} /></button>
        <button type="button" className="icon-btn" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)} aria-label={t('globalSearch.nextPage')}><ChevronRight size={15} /></button></div>
    </footer>
  </Modal>;
}
