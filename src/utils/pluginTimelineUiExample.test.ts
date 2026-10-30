// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import tableSource from '../../examples/plugin-views-demo/ui/table.js?raw';
import waveSource from '../../examples/plugin-views-demo/ui/wave.js?raw';
import type { PluginTimelineResult } from '../types/pluginViews';

type Model = { portId: string; rows: Array<{ id: string; at: number | null; device: string; temperature: number; voltage: number }>; gaps: number; rejected: number; threshold: number; status: string };
function ui(source: string) {
  const doc = document.implementation.createHTMLDocument(); doc.body.innerHTML = '<div id="plugin-root"></div>';
  let state!: (value: Model) => void;
  let seek!: (request: { timeMs: number; signal: AbortSignal }) => Promise<PluginTimelineResult>;
  const end = vi.fn();
  const handle = { setAvailability: vi.fn(), updateCapabilities: vi.fn(), dispose: vi.fn(), beginNavigation: vi.fn(() => ({ update: vi.fn(), end, cancel: vi.fn() })) };
  const view = { timeline: { register: vi.fn((options: { onSeek: typeof seek }) => { seek = options.onSeek; return handle; }) }, onState: (cb: typeof state) => { state = cb; }, onEnvironment: vi.fn(), send: vi.fn() };
  new Function('document', 'view', 'addEventListener', 'requestAnimationFrame', 'getComputedStyle', source)(doc, view, vi.fn(), (callback: () => void) => callback(), () => ({ color: '#000' }));
  return { doc, state: (value: Model) => state(value), seek: (timeMs: number, signal = new AbortController().signal) => seek({ timeMs, signal }), handle, end };
}
const model: Model = { portId: 'COM3', status: 'connected', gaps: 0, rejected: 0, threshold: 30, rows: [
  { id: '1', at: 1000, device: 'A', temperature: 25, voltage: 3.3 },
  { id: '2', at: 2000, device: 'B', temperature: 35, voltage: 3.4 },
  { id: '3', at: 2000, device: 'B', temperature: 45, voltage: 3.5 },
] };
afterEach(() => { vi.restoreAllMocks(); delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView; });

describe('production bounded timeline UI examples', () => {
  it('table locates retained visible timestamps with stable duplicate keys and disables driving under value sorting', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const p = ui(tableSource); p.state(model);
    await expect(p.seek(1500)).resolves.toEqual({ status: 'nearest', actualTimeMs: 1000, recordKey: '1' });
    await expect(p.seek(2000)).resolves.toEqual({ status: 'exact', actualTimeMs: 2000, recordKey: '3' });
    const filter = p.doc.querySelector('input')!; filter.value = 'B'; filter.dispatchEvent(new Event('input'));
    await expect(p.seek(1500)).resolves.toEqual({ status: 'before-range', actualTimeMs: 2000, recordKey: '2' });
    filter.value = 'missing'; filter.dispatchEvent(new Event('input')); await expect(p.seek(1500)).resolves.toEqual({ status: 'filtered' });
    filter.value = ''; filter.dispatchEvent(new Event('input'));
    const sort = p.doc.querySelector('select')!; sort.value = 'temperature'; sort.dispatchEvent(new Event('change'));
    expect(p.handle.updateCapabilities).toHaveBeenLastCalledWith({ preview: 'bounded', canDrive: false });
    expect([...p.doc.querySelectorAll('tbody button')].every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    sort.value = 'at'; sort.dispatchEvent(new Event('change')); (p.doc.querySelector('tbody button') as HTMLButtonElement).click();
    expect(p.handle.beginNavigation).toHaveBeenCalledWith('align'); expect(p.end).toHaveBeenCalledWith({ timeMs: 2000, recordKey: '2' });
  });
  it('table preserves unknown time and protects selection, then re-enables current-target alignment on selection clear', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const p = ui(tableSource); p.state({ ...model, rows: [{ ...model.rows[0], at: null }] });
    expect(p.doc.querySelector('tbody td')?.textContent).toBe('—'); await expect(p.seek(0)).resolves.toEqual({ status: 'no-time' });
    p.state(model); const row = p.doc.querySelector('tbody tr');
    const selection = vi.spyOn(p.doc, 'getSelection').mockReturnValue({ isCollapsed: false } as Selection);
    await expect(p.seek(1000)).resolves.toEqual({ status: 'held' }); expect(p.doc.querySelector('tbody tr')).toBe(row);
    expect(p.handle.setAvailability).toHaveBeenLastCalledWith({ available: false });
    selection.mockReturnValue({ isCollapsed: true } as Selection); p.doc.dispatchEvent(new Event('selectionchange'));
    expect(p.handle.setAvailability).toHaveBeenLastCalledWith({ available: true, range: { startMs: 1000, endMs: 2000 } });
  });
  it('wave uses collection-time range and explicit input controls, not programmatic seek, to drive', async () => {
    const context = Object.fromEntries(['clearRect', 'fillText', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'setLineDash'].map(name => [name, vi.fn()]));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const p = ui(waveSource); p.state(model);
    const scrub = p.doc.querySelector('input')!; expect([scrub.min, scrub.max]).toEqual(['1000', '2000']);
    await expect(p.seek(1500)).resolves.toEqual({ status: 'nearest', actualTimeMs: 1000, recordKey: '1' });
    expect(p.handle.beginNavigation).not.toHaveBeenCalled();
    scrub.value = '2000'; scrub.dispatchEvent(new Event('input')); scrub.dispatchEvent(new Event('change'));
    expect(p.handle.beginNavigation).toHaveBeenCalledWith('scrub'); expect(p.end).toHaveBeenCalledWith({ timeMs: 2000 });
  });
});
