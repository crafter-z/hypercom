import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeClipboardText } from './clipboard';

const nativeWrite = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: nativeWrite }));

const webWrite = vi.fn();
beforeEach(() => {
  nativeWrite.mockReset().mockResolvedValue(undefined);
  webWrite.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText: webWrite } });
});
afterEach(() => vi.unstubAllGlobals());

describe('writeClipboardText', () => {
  it('prefers the existing native plugin and does not duplicate successful writes', async () => {
    await writeClipboardText('串口 RX\nTX');
    expect(nativeWrite).toHaveBeenCalledExactlyOnceWith('串口 RX\nTX');
    expect(webWrite).not.toHaveBeenCalled();
  });

  it('writes empty strings and large text unchanged', async () => {
    await writeClipboardText('');
    expect(nativeWrite).toHaveBeenLastCalledWith('');
    const text = 'x'.repeat(1024 * 1024 + 1);
    await writeClipboardText(text);
    expect(nativeWrite).toHaveBeenLastCalledWith(text);
  });

  it('falls back to the browser API when native writing rejects', async () => {
    nativeWrite.mockRejectedValue(new Error('native unavailable'));
    await expect(writeClipboardText('browser')).resolves.toBeUndefined();
    expect(webWrite).toHaveBeenCalledExactlyOnceWith('browser');
  });

  it('also falls back when the native API throws synchronously', async () => {
    nativeWrite.mockImplementation(() => { throw new Error('no Tauri runtime'); });
    await writeClipboardText('preview');
    expect(webWrite).toHaveBeenCalledExactlyOnceWith('preview');
  });

  it('rejects rather than reporting false success when both backends fail', async () => {
    nativeWrite.mockRejectedValue(new Error('native failed'));
    const denied = new Error('browser permission denied');
    webWrite.mockRejectedValue(denied);
    await expect(writeClipboardText('must not cut')).rejects.toBe(denied);
  });

  it('preserves the native failure when the browser clipboard is unavailable', async () => {
    const failed = new Error('native failed');
    nativeWrite.mockRejectedValue(failed);
    vi.stubGlobal('navigator', {});
    await expect(writeClipboardText('text')).rejects.toBe(failed);
    vi.stubGlobal('navigator', undefined);
    await expect(writeClipboardText('text')).rejects.toBe(failed);
  });
});
