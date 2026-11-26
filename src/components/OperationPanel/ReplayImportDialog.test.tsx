// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReplayImportDialog, { formatUtcOffset } from './ReplayImportDialog';
import type { ReplayPickedSources } from '../../services/file';
import type { ReplayTrackPlan } from '../../utils/replay/replayRuntime';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../shared/usePluginViewOverlay', () => ({ usePluginViewOverlay: () => true }));
vi.mock('../../stores/useToastStore', () => ({ notifyError: vi.fn() }));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const singlePicked: ReplayPickedSources = {
  grantId: 'g1',
  sources: [{ sourceId: 's1', name: 'session.log', path: 'C:/session.log', size: 2048, fingerprint: 'a'.repeat(64) }],
};

const multiPicked: ReplayPickedSources = {
  grantId: 'g2',
  sources: [
    { sourceId: 's1', name: 'a.log', path: 'C:/a.log', size: 2048, fingerprint: 'a'.repeat(64) },
    { sourceId: 's2', name: 'b.log', path: 'C:/b.log', size: 4096, fingerprint: 'b'.repeat(64) },
  ],
};

describe('ReplayImportDialog single-file simplification and timezone formatting', () => {
  it('formats UTC offsets as UTC±HH:MM', () => {
    expect(formatUtcOffset(480)).toBe('UTC+08:00');
    expect(formatUtcOffset(0)).toBe('UTC+00:00');
    expect(formatUtcOffset(-300)).toBe('UTC-05:00');
    expect(formatUtcOffset(330)).toBe('UTC+05:30');
  });

  it('hides track/order columns and confirmation checkbox for single-file import', async () => {
    const onConfirm = vi.fn<(plans: ReplayTrackPlan[]) => Promise<void>>(async () => {});
    await act(async () => {
      root.render(<ReplayImportDialog picked={singlePicked} busy={false} onConfirm={onConfirm} onCancel={vi.fn()} />);
    });
    const dialog = document.querySelector('.replay-import-dialog')!;
    const headers = [...dialog.querySelectorAll('th')].map(th => th.textContent);
    expect(headers).toEqual(['replay.file', 'replay.format']);
    expect(dialog.querySelector('input[type="checkbox"]')).toBeNull();
    const tzSelect = dialog.querySelector<HTMLSelectElement>('.replay-import-tz-select')!;
    expect(tzSelect.value).toBe(String(-new Date().getTimezoneOffset()));
    const submitBtn = dialog.querySelector<HTMLButtonElement>('.btn-primary')!;
    expect(submitBtn.disabled).toBe(false);
    await act(async () => submitBtn.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]?.[0]?.[0]?.options.timezoneOffsetMinutes).toBe(-new Date().getTimezoneOffset());
  });

  it('retains track/order columns and confirmation checkbox gate for multi-file imports', async () => {
    const onConfirm = vi.fn(async () => {});
    await act(async () => {
      root.render(<ReplayImportDialog picked={multiPicked} busy={false} onConfirm={onConfirm} onCancel={vi.fn()} />);
    });
    const dialog = document.querySelector('.replay-import-dialog')!;
    const headers = [...dialog.querySelectorAll('th')].map(th => th.textContent);
    expect(headers).toEqual(['replay.file', 'replay.track', 'replay.order', 'replay.format']);
    const checkbox = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const submitBtn = dialog.querySelector<HTMLButtonElement>('.btn-primary')!;
    expect(submitBtn.disabled).toBe(true);
    await act(async () => checkbox.click());
    expect(submitBtn.disabled).toBe(false);
  });
});
