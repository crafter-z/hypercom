import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { SlidersHorizontal, X, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SegmentedControl } from '../shared/SegmentedControl';
import { useMenuPlacement } from '../shared/menuPlacement';
import { useOutsideDismiss } from '../shared/useOutsideDismiss';
import { usePluginViewOverlay } from '../shared/usePluginViewOverlay';
import { useDialogLifecycle } from '../shared/useDialogLifecycle';
import { DEFAULT_SEARCH_SPEC, type SearchSpec } from '../../utils/terminal/search/searchTypes';
import '../../styles/search-advanced-options.css';

const DIRECTIONS = ['RX', 'TX', 'TOOL', 'NOTE'] as const;
export function countAdvancedSearchOptions(spec: SearchSpec): number {
  return Number(spec.mode !== 'literal') + Number(spec.multiline && spec.mode !== 'hex') + Number(spec.caseSensitive && spec.mode !== 'hex') +
    Number(spec.wholeWord && spec.mode !== 'hex' && spec.mode !== 'fuzzy') + Number(spec.scope !== 'buffer') +
    Number(DIRECTIONS.some(direction => !spec.directions.includes(direction)));
}
interface Props {
  spec: SearchSpec;
  onChange: (spec: SearchSpec) => void;
  onReset?: () => void;
  extraActiveCount?: number;
  children?: ReactNode;
}
interface PanelProps extends Props {
  id: string;
  anchor: { x: number; y: number };
  triggerRef: RefObject<HTMLButtonElement>;
  onClose: () => void;
}

/** Mounted only while open. Matching remains owned by the existing sessions. */
function AdvancedOptionsPanel({ id, anchor, triggerRef, onClose, spec, onChange, onReset, children }: PanelProps) {
  const { t } = useTranslation();
  const { ref, pos } = useMenuPlacement(anchor.x, anchor.y);
  const ready = usePluginViewOverlay(true, ref);
  const focused = useRef(false);
  useOutsideDismiss(ref, onClose, true, triggerRef);
  useDialogLifecycle({ open: true, dialogRef: ref, onClose });
  useEffect(() => {
    if (!ready || focused.current) return;
    focused.current = true;
    ref.current?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.focus({ preventScroll: true });
  }, [ready, ref]);
  const change = (patch: Partial<SearchSpec>) => onChange({ ...spec, ...patch });
  const reset = () => onReset ? onReset() : onChange({ ...DEFAULT_SEARCH_SPEC, query: spec.query });
  return createPortal(<div ref={ref} id={id} role="dialog" aria-label={t('terminal.search.advanced')} tabIndex={-1}
    className="search-advanced-panel" style={{ left: pos.x, top: pos.y, visibility: ready ? 'visible' : 'hidden' }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
    <header className="search-advanced-header">
      <strong><SlidersHorizontal size={14} />{t('terminal.search.advanced')}</strong>
      <button type="button" className="icon-btn" onClick={onClose} title={t('terminal.search.closeAdvanced')}
        aria-label={t('terminal.search.closeAdvanced')}><X size={14} /></button>
    </header>
    <div className="search-advanced-body">
      <section className="search-advanced-section" aria-label={t('terminal.search.matchOptions')}>
        <h4>{t('terminal.search.mode')}</h4>
        <SegmentedControl<SearchSpec['mode']> value={spec.mode} aria-label={t('terminal.search.mode')}
          className="search-advanced-modes"
          options={(['literal', 'regex', 'fuzzy', 'hex'] as const).map(mode => ({ value: mode, label: t(`terminal.search.mode.${mode}`) }))}
          onChange={mode => change({ mode, ...(mode === 'hex' ? { multiline: false, wholeWord: false } : mode === 'fuzzy' ? { wholeWord: false } : {}) })} />
        <div className="search-advanced-checks">
          <label><input type="checkbox" checked={spec.caseSensitive} disabled={spec.mode === 'hex'} onChange={event => change({ caseSensitive: event.target.checked })} />{t('terminal.search.caseSensitive')}</label>
          <label><input type="checkbox" checked={spec.wholeWord} disabled={spec.mode === 'hex' || spec.mode === 'fuzzy'} onChange={event => change({ wholeWord: event.target.checked })} />{t('terminal.search.wholeWord')}</label>
          <label><input type="checkbox" checked={spec.multiline} disabled={spec.mode === 'hex'} onChange={event => change({ multiline: event.target.checked })} />{t('terminal.search.multiline')}</label>
        </div>
        {spec.mode === 'fuzzy' && <p className="search-advanced-help">{t('terminal.search.fuzzyHelp')}</p>}
        {spec.multiline && <p className="search-advanced-help">{t('terminal.search.multilineHelp')}</p>}
      </section>
      <section className="search-advanced-section" aria-label={t('terminal.search.rangeOptions')}>
        <label className="search-advanced-field"><span>{t('terminal.search.scope')}</span>
          <select className="select" value={spec.scope} onChange={event => change({ scope: event.target.value as SearchSpec['scope'] })}>
            <option value="buffer">{t('terminal.search.scope.buffer')}</option>
            <option value="visible">{t('terminal.search.scope.visible')}</option>
          </select>
        </label>
        <fieldset className="search-advanced-directions"><legend>{t('terminal.search.direction')}</legend>
          <div className="search-advanced-checks">{DIRECTIONS.map(direction => <label key={direction}>
            <input type="checkbox" checked={spec.directions.includes(direction)} onChange={() => change({ directions: spec.directions.includes(direction)
              ? spec.directions.filter(value => value !== direction) : [...spec.directions, direction] })} />{direction}
          </label>)}</div>
        </fieldset>
      </section>
      {children && <section className="search-advanced-section">{children}</section>}
    </div>
    <footer className="search-advanced-footer"><small>{t('terminal.search.advancedHint')}</small>
      <button type="button" className="btn btn-sm search-advanced-reset" onClick={reset}><RotateCcw size={12} />{t('terminal.search.resetOptions')}</button>
    </footer>
  </div>, document.body);
}

/** One secondary entry shared by terminal-local and multi-source searches. */
export default function SearchAdvancedOptions(props: Props) {
  const { t } = useTranslation();
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  const updateAnchor = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ x: Math.max(8, rect.right - 400), y: rect.bottom + 6 });
  }, []);
  useLayoutEffect(() => {
    if (!anchor) return;
    window.addEventListener('resize', updateAnchor);
    return () => window.removeEventListener('resize', updateAnchor);
  }, [!!anchor, updateAnchor]);
  const count = countAdvancedSearchOptions(props.spec) + (props.extraActiveCount ?? 0);
  return <>
    <button ref={triggerRef} type="button" className={`search-advanced-trigger${count ? ' active' : ''}`}
      aria-label={t('terminal.search.advanced')} aria-haspopup="dialog" aria-controls={anchor ? id : undefined} aria-expanded={!!anchor}
      title={count ? t('terminal.search.advancedActive', { count }) : t('terminal.search.advanced')}
      onClick={() => {
        if (anchor) close();
        else { triggerRef.current?.focus({ preventScroll: true }); updateAnchor(); }
      }}>
      <SlidersHorizontal size={14} /><span>{t('terminal.search.advanced')}</span>
      {count > 0 && <span className="search-advanced-count" aria-label={t('terminal.search.advancedActive', { count })}>{count}</span>}
    </button>
    {anchor && <AdvancedOptionsPanel {...props} id={id} anchor={anchor} triggerRef={triggerRef} onClose={close} />}
  </>;
}
