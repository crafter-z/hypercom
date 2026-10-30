import { describe, expect, it, vi } from 'vitest';
import source from '../../examples/plugin-views-demo/main.js?raw';

interface DemoRow { id: string; at: number | null; device: string; temperature: number; voltage: number }
interface Snapshot { rows: DemoRow[]; gaps: number; rejected: number }
function parser() {
  let open!: (view: object) => Promise<void>;
  let input!: (batch: Array<{ bytes: Uint8Array; ts: number }>) => Promise<void>;
  let discontinuity!: () => void;
  let message!: (message: { type: string }) => Promise<void>;
  const snapshots: Snapshot[] = [];
  const plugin = { views: { onOpen: (cb: typeof open) => { open = cb; }, onClose: vi.fn() }, on: vi.fn() };
  new Function('self', source)({ plugin });
  const view = {
    context: { viewId: 'table', viewInstanceId: 'instance', boundPortId: 'COM3' },
    onInput: (cb: typeof input) => { input = cb; }, onDiscontinuity: (cb: typeof discontinuity) => { discontinuity = cb; }, onStatus: vi.fn(), onMessage: (cb: typeof message) => { message = cb; },
    publish: async (snapshot: Snapshot) => { snapshots.push(structuredClone(snapshot)); },
  };
  return { start: () => open(view), feed: (text: string, ts: number) => input([{ bytes: new TextEncoder().encode(text), ts }]), discontinuity: () => discontinuity(), clear: () => message({ type: 'clear' }), last: () => snapshots[snapshots.length - 1] };
}
describe('timeline demo input timestamp contract', () => {
  it('preserves completing input ts across delayed parsing, fragmented frames and same-ms records', async () => {
    const p = parser(); await p.start();
    await p.feed('[SIM] Heart', 1000); await p.feed('beat #1\n[SIM] Heartbeat #2\n', 1234);
    expect(p.last().rows.map(r => r.at)).toEqual([1234, 1234]);
    expect(p.last().rows.map(r => r.id)).toEqual(['1', '2']);
    await p.feed('S,probe,25.0,3.3*22\n', 4567);
    expect(p.last().rows[2]).toMatchObject({ device: 'probe', at: 4567, id: '3' });
    await p.clear(); await p.feed('[SIM] Heartbeat #3\n', 5000);
    expect(p.last().rows).toEqual([expect.objectContaining({ at: 5000, id: '4' })]);
  });
  it('keeps unknown time unknown, drops partial frames across discontinuity, and retains only 200 bounded records', async () => {
    const p = parser(); await p.start(); await p.feed('[SIM] Heartbeat #1\n', NaN);
    expect(p.last().rows[0].at).toBeNull();
    await p.feed('[SIM] Heart', 1); p.discontinuity(); await p.feed('beat #9\n', 2);
    expect(p.last().rows).toHaveLength(1); expect(p.last().gaps).toBe(1);
    for (let i = 0; i < 205; i++) await p.feed(`[SIM] Heartbeat #${i}\n`, i + 100);
    expect(p.last().rows).toHaveLength(200); expect(p.last().rows[0].at).toBe(105); expect(p.last().rows[199].at).toBe(304);
  });
});
