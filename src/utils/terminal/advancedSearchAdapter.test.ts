import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalViewportManager } from './viewportManager';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { DEFAULT_SEARCH_SPEC, type SearchHit, type SearchSpec } from './search/searchTypes';
import type { TerminalLine } from '../../types';

const line = (text: string, direction: TerminalLine['direction'] = 'RX'): TerminalLine => ({
  timestamp: 10, direction, rawData: new TextEncoder().encode(text), isHex: false,
});
const managers: TerminalViewportManager[] = [];
function manager(limit = 10) { const vm = new TerminalViewportManager('adapter', { maxLines: limit }); managers.push(vm); return vm; }
function spec(patch: Partial<SearchSpec> = {}): SearchSpec { return { ...DEFAULT_SEARCH_SPEC, ...patch }; }
function hit(vm: TerminalViewportManager, startSeq = 0, endSeq = startSeq): SearchHit {
  return { sourceId: 'adapter', generation: vm.createSearchSource().getState().generation,
    startSeq, endSeq, spans: [{ seq: startSeq, start: 0, end: 1 }], timestamp: 10, direction: 'RX' };
}
beforeEach(() => useTerminalStore.setState({ terminals: {} }));
afterEach(() => { managers.splice(0).forEach(vm => vm.dispose()); vi.unstubAllGlobals(); });

describe('advanced search source adapter', () => {
  it('reads lazily without taking a full history snapshot and retains true seq gaps', () => {
    const vm = manager(); vm.appendLines([line('first'), line('hidden', 'TX'), line('last')]);
    const snapshot = vi.spyOn(vm.buffer, 'snapshot');
    const source = vm.createSearchSource('global-adapter');
    expect(source.id).toBe('global-adapter');
    expect(source.readRecord(0, spec({ directions: ['RX'] }))?.text).toBe('first');
    expect(source.readRecord(1, spec({ directions: ['RX'] }))).toBeNull();
    expect(source.readRecord(2, spec({ directions: ['RX'] }))?.seq).toBe(2);
    expect(snapshot).not.toHaveBeenCalled();
  });
  it('separates buffer/visible scope and invalidates results on filter changes', () => {
    const vm = manager(); vm.appendLines([line('first'), line('other')]); const old = hit(vm);
    vm.setFilter('all', 'other'); const source = vm.createSearchSource();
    expect(source.readRecord(0, spec())?.text).toBe('first');
    expect(source.readRecord(0, spec({ scope: 'visible' }))).toBeNull();
    expect(vm.isSearchHitValid(old)).toBe(false);
  });
  it('temporarily reveals hits outside filters without copying or losing the saved filter', () => {
    const vm = manager(); vm.appendLines([line('target'), line('other')]);
    vm.setFilter('all', 'other'); vm.setSearch(true, 'target', false);
    expect(vm.getVisibleCount()).toBe(1);
    expect(vm.jumpToMatch(0)).toBe(true);
    expect(vm.revealingOutsideFilter).toBe(true);
    expect(vm.getVisibleCount()).toBe(2);
    vm.restoreSearchFilter();
    expect(vm.getVisibleCount()).toBe(1);
    expect(vm.revealingOutsideFilter).toBe(false);
  });
  it('caps pause, expires cross-line trim and never reuses manager generations', () => {
    const vm = manager(3); vm.appendLines([line('a'), line('b')]); vm.setPaused(true);
    const old = hit(vm, 0, 1); vm.appendLine(line('c'));
    expect(vm.createSearchSource().getState().lastSeq).toBe(1);
    expect(vm.createSearchSource().readRecord(2, spec())).toBeNull();
    expect(vm.isSearchHitValid(old)).toBe(true);
    vm.appendLine(line('d')); expect(vm.isSearchHitValid(old)).toBe(false);
    const replacement = manager(); replacement.appendLine(line('fresh'));
    expect(replacement.isSearchHitValid(old)).toBe(false);
    vm.clear(); expect(vm.revealSearchHit(old)).toBe(false);
  });
  it('uses raw bytes for HEX without transferring ownership and keeps encoding generation', () => {
    const vm = manager(); vm.appendLine(line('AB')); const old = hit(vm);
    expect(Array.from(vm.createSearchSource().readRecord(0, spec({ mode: 'hex' }))!.rawData!)).toEqual([0x41, 0x42]);
    expect(vm.previewSearchHit(old, spec({ mode: 'hex' }))).toBe('41 42');
    expect(vm.buffer.getBySeq(0)?.rawData?.byteLength).toBe(2);
    useTerminalStore.getState().ensureTerminal('adapter');
    useTerminalStore.getState().setTerminalEncoding('adapter', 'GBK'); vm.updateConfig({ encoding: 'GBK' });
    expect(vm.isSearchHitValid(old)).toBe(false);
  });
  it('does not run fuzzy/regex matching in RX when Workers are unavailable', () => {
    vi.stubGlobal('Worker', undefined);
    const vm = manager(); vm.setSearch(true, 'e.*r', false, spec({ mode: 'regex' }));
    vm.appendLines([line('error'), line('error')]);
    expect(vm.buffer.length).toBe(2);
    expect(vm.getMatchCount()).toBe(0);
    expect(vm.getSearchSnapshot()?.status).toBe('error');
    vm.setSearch(false, '', false); expect(vm.getSearchSnapshot()).toBeNull();
  });
});
