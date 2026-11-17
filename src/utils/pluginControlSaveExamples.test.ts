import { describe, expect, it, vi } from 'vitest';
import guide from '../../docs/plugin-development.md?raw';

type Click = { buttonId: string; context?: { portId: string } };
function example(heading: string, api: Record<string, ReturnType<typeof vi.fn>>) {
  const section = guide.replace(/\r\n?/g, '\n').split(`### ${heading}\n`)[1];
  const source = section?.match(/```js\n([\s\S]*?)\n```/)?.[1];
  if (!source) throw new Error(`Missing guide example: ${heading}`);
  let click!: (event: Click) => Promise<void>;
  new Function('self', source)({ plugin: { api, on: (_name: string, callback: typeof click) => { click = callback; } } });
  return click;
}

describe('documented minimal control/save Worker examples', () => {
  it('exports lossless bytes through a picked grant and releases only that grant', async () => {
    const api = {
      'fs.openDirectoryDialog': vi.fn().mockResolvedValue({ directories: [{ grantId: 'picked', path: 'C:\\exports' }] }),
      'fs.exportFile': vi.fn().mockResolvedValue({ path: 'C:\\exports\\reports\\sample.bin', bytesWritten: 3 }),
      'fs.releaseDirectory': vi.fn().mockResolvedValue(null),
      'fs.saveFile': vi.fn(), 'ui.panel.append': vi.fn(),
    };
    const click = example('两种最小权限导出', api);
    await click({ buttonId: 'export-report' });
    expect(api['fs.exportFile']).toHaveBeenCalledExactlyOnceWith({ grantId: 'picked', rel: 'reports/sample.bin', bytes: new Uint8Array([0, 255, 128]) });
    expect(api['fs.releaseDirectory']).toHaveBeenCalledExactlyOnceWith({ grantId: 'picked' });
    expect(api['fs.saveFile']).not.toHaveBeenCalled();
  });
  it('invokes Save As on every user action and treats cancellation separately from a saved file', async () => {
    const api = {
      'fs.saveFile': vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ path: 'D:\\sample.bin', bytesWritten: 3 }),
      'ui.panel.append': vi.fn().mockResolvedValue(null),
    };
    const click = example('两种最小权限导出', api);
    await click({ buttonId: 'save-report' });
    expect(api['ui.panel.append']).not.toHaveBeenCalled();
    await click({ buttonId: 'save-report' });
    expect(api['fs.saveFile']).toHaveBeenCalledTimes(2);
    expect(api['fs.saveFile']).toHaveBeenLastCalledWith({ bytes: new Uint8Array([0, 255, 128]), options: {
      title: 'Save As', defaultFileName: 'sample.bin', filters: [{ name: 'Binary', extensions: ['bin'] }],
    } });
    expect(api['ui.panel.append']).toHaveBeenCalledExactlyOnceWith({ text: 'Saved 3 bytes\n' });
  });
  it('does not connect at initialization and closes only the generation returned by open', async () => {
    const api = {
      'serial.open': vi.fn().mockResolvedValue({ result: 'opened', connectionGeneration: 7 }),
      'serial.close': vi.fn().mockResolvedValue({ result: 'closed' }),
    };
    const click = example('打开与按代次关闭串口', api);
    expect(api['serial.open']).not.toHaveBeenCalled();
    await click({ buttonId: 'close-device', context: { portId: 'COM3' } });
    expect(api['serial.close']).not.toHaveBeenCalled();
    await click({ buttonId: 'open-device', context: { portId: 'COM3' } });
    expect(api['serial.open']).toHaveBeenCalledExactlyOnceWith({ portId: 'COM3', params: { baudRate: 115200 } });
    await click({ buttonId: 'close-device', context: { portId: 'COM3' } });
    expect(api['serial.close']).toHaveBeenCalledExactlyOnceWith({ portId: 'COM3', expectedConnectionGeneration: 7 });
    await click({ buttonId: 'close-device', context: { portId: 'COM3' } });
    expect(api['serial.close']).toHaveBeenCalledTimes(1);
  });
});
