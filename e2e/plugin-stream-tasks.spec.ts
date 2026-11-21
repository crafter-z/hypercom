import { expect, test, type Page } from '@playwright/test';

const PLUGIN = 'com.example.stream-tasks';
const GENERATION = 'e2e-install';
const GRANTS = ['fs:open', 'fs:save', 'fs:storage', 'serial:send', 'shell:execute'];
const PORT = 'COM61';
const CONNECTION = 17;
const READ_HANDLE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WRITE_HANDLE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FILE_BYTES = [128, 0, 65, 255, 10];

// The browser runs the shipped Worker code, PluginSession, domain contexts and
// services. Only OS/native IPC is substituted; Rust integration is tested separately.
const WORKER = `
  const p = self.plugin;
  const serial = { portId: '${PORT}', expectedConnectionGeneration: ${CONNECTION} };
  const report = (key, value) => p.api['ui.panel.append']({ text: key + ':' + JSON.stringify(value) + '\\n' });
  let controller, activeShell;
  async function collect(stream) {
    const decoder = new TextDecoder();
    let text = '';
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
    return text + decoder.decode();
  }
  async function capture(run) { try { await run(); return 'unexpected success'; } catch (error) { return error.message; } }
  p.on('ui.buttonClick', async ({ buttonId }) => {
    try {
      if (buttonId === 'roundtrip') {
        const selected = await p.fs.openFile({ title: 'Pick a capture' });
        const window = await selected.read(1, 3);
        const range = await p.api['fs.readRange']({ rel: 'data/legacy.bin', offset: 0, length: 2 });
        const legacyFile = await p.api['fs.openDialog']({ format: 'binary' });
        const target = await p.fs.createFile({ defaultFileName: 'capture.bin' });
        const staged = await target.write(new Uint8Array([9, 0, 255]));
        const committed = await target.commit();
        const bytes = await p.serial.sendBytes({ ...serial, bytes: new Uint8Array([128, 0, 255]) }).done;
        const file = await p.serial.sendFile({ ...serial, handleId: selected.handleId }).done;
        await selected.close();
        const legacySerial = await p.api['serial.send']({ portId: serial.portId, data: 'Z' });
        const legacyShell = await p.api['shell.execute']({ program: 'legacy-tool' });
        const process = await p.shell.start({ program: 'normal-tool' });
        const out = process.stdout[Symbol.asyncIterator]();
        const first = await out.next();
        const running = await process.status();
        await report('first-output', { bytes: Array.from(first.value), status: running.state });
        await out.return();
        const [stdoutTail, stderr, terminal] = await Promise.all([collect(process.stdout), collect(process.stderr), process.wait()]);
        await process.release();
        await report('roundtrip', {
          selected: selected.name, window: Array.from(window), range: Array.from(range), typed: window instanceof Uint8Array,
          legacyFile: Array.from(legacyFile.files[0].bytes), staged, committed, bytes, file, legacySerial, legacyShell, stdoutTail, stderr, terminal
        });
      } else if (buttonId === 'permissions') {
        const results = await Promise.all([
          capture(() => p.fs.openFile()), capture(() => p.fs.createFile()),
          p.serial.sendBytes({ ...serial, bytes: new Uint8Array([1]) }).done,
          capture(() => p.shell.start({ program: 'denied-tool' }))
        ]);
        await report('permissions', results);
      } else if (buttonId === 'late-file') {
        const selected = await p.fs.openFile();
        controller = new AbortController();
        try {
          const bytes = await selected.read(0, 2, { signal: controller.signal });
          await report('unexpected-late-file', Array.from(bytes));
        } catch (error) { await report('late-file', error.name); }
        await selected.close();
      } else if (buttonId === 'abort-file') {
        controller.abort();
      } else if (buttonId === 'shell-blocked') {
        activeShell = await p.shell.start({ program: 'wait-tool' }, { stderr: 'discard' });
        const pending = activeShell.stdout[Symbol.asyncIterator]().next();
        const first = await pending;
        await report('shell-unblocked', { done: first.done, terminal: await activeShell.wait() });
        await activeShell.release();
      } else if (buttonId === 'cancel-shell') {
        await report('shell-cancel', (await activeShell.cancel()).state);
      } else if (buttonId === 'stop-during-file-send') {
        const selected = await p.fs.openFile();
        const shell = await p.shell.start({ program: 'held-on-stop' }, { stdout: 'discard', stderr: 'discard' });
        const sent = await p.serial.sendFile({ ...serial, handleId: selected.handleId }).done;
        await report('retired-output', { sent, shell: await shell.status() });
      } else if (buttonId === 'fresh') {
        const selected = await p.fs.openFile();
        const shell = await p.shell.start({ program: 'normal-tool' }, { stdout: 'discard', stderr: 'discard' });
        await report('fresh', { selected: selected.name, state: (await shell.status()).state });
        await shell.release();
        await selected.close();
      }
    } catch (error) { await report('error', String(error && error.stack || error)); }
  });
`;

type NativeCall = { cmd: string; args: Record<string, unknown> };
type TestHarness = {
  calls: NativeCall[];
  run(name: string): void;
  setGrants(grants: string[]): void;
  logs(): string;
  stop(): void;
  start(): Promise<void>;
  hold(kind: 'read' | 'serial'): void;
  resolveHeld(): void;
  sizes(): number[];
};

declare global { interface Window { __streamTasksE2e: TestHarness } }

async function setup(page: Page, grants = GRANTS) {
  // Keep the real Vite origin for module and Blob Worker loading, but leave
  // the UI shell out so unrelated startup IPC does not mask contract failures.
  await page.route('**/__stream-tasks-e2e', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto('/__stream-tasks-e2e');
  await page.evaluate(async (fixture) => {
    const { pluginId, generation, workerCode, allGrants, grants, portId, connection, readHandle, writeHandle, fileBytes } = fixture;
    const calls: NativeCall[] = [];
    const returnedBuffers: ArrayBuffer[] = [];
    let hold: 'read' | 'serial' | null = null;
    let resolveHeld: (() => void) | undefined;
    const nativeFileIds = new Set<string>();
    const serialTasks = new Map<string, { totalBytes: number; file: boolean }>();
    const nativeProcesses = new Map<string, {
      stdout: string[]; stderr: string[]; program: string; cancelled: boolean; finish?: (value: { kind: 'eof' }) => void;
    }>();
    const terminal = (state: string, exitCode: number | null = null) => ({ state, exitCode, error: null });
    const mock = {
      async invoke(cmd: string, args: Record<string, unknown> = {}) {
        calls.push({ cmd, args: structuredClone(args) });
        if ('pluginId' in args && args.pluginId !== pluginId) throw new Error('wrong native plugin');
        if ('expectedGeneration' in args && args.expectedGeneration !== generation) throw new Error('wrong native install');
        switch (cmd) {
          case 'read_plugin_asset':
            if (args.relPath === 'main.js') return workerCode;
            if (args.relPath === 'manifest.json') return JSON.stringify({
              id: pluginId, name: 'Streams E2E', apiVersion: '1.0', version: '1.0.0', entry: 'main.js',
              permissions: allGrants, serial: { portWhitelist: [portId] },
            });
            throw new Error('unexpected asset');
          case 'plugin_fs_open_session': return crypto.randomUUID();
          case 'plugin_fs_close_session':
          case 'plugin_fs_cancel':
          case 'plugin_fs_release': return null;
          case 'plugin_fs_read_ranges': {
            const ranges = args.ranges as Array<{ rel: string; offset: number; length: number }>;
            const range = ranges[0];
            const data = new Uint8Array(fileBytes.slice(range.offset, range.offset + range.length));
            const metadata = new TextEncoder().encode(JSON.stringify({ results: [{ rel: range.rel, offset: 0, length: data.length }] }));
            const frame = new Uint8Array(8 + metadata.length + data.length);
            frame.set([72, 67, 70, 82]);
            new DataView(frame.buffer).setUint32(4, metadata.length, true);
            frame.set(metadata, 8); frame.set(data, 8 + metadata.length);
            return frame.buffer;
          }
          case 'plugin_pick_files': return { files: [{ path: 'C:/mock/legacy.bin', base64: btoa(String.fromCharCode(...fileBytes)) }] };
          case 'plugin_file_pick_read':
            nativeFileIds.add(readHandle);
            return { handleId: readHandle, name: 'selected.bin', mode: 'read', size: fileBytes.length, activeHandles: [...nativeFileIds] };
          case 'plugin_file_pick_write':
            nativeFileIds.add(writeHandle);
            return { handleId: writeHandle, name: 'capture.bin', mode: 'write', size: 0, activeHandles: [...nativeFileIds] };
          case 'plugin_file_read': {
            const offset = args.offset as number;
            const buffer = new Uint8Array(fileBytes.slice(offset, offset + Number(args.length))).buffer;
            returnedBuffers.push(buffer);
            if (hold === 'read') {
              hold = null;
              await new Promise<void>(resolve => { resolveHeld = resolve; });
            }
            return buffer;
          }
          case 'plugin_file_write': return Number(args.offset) + atob(String(args.base64)).length;
          case 'plugin_file_commit': return { bytesWritten: 3 };
          case 'plugin_file_close': nativeFileIds.delete(String(args.handleId)); return null;
          case 'plugin_serial_task_begin': {
            const source = args.source as { kind: string; totalBytes?: number; handleId?: string };
            const file = source.kind === 'file';
            if (file && source.handleId !== readHandle) throw new Error('wrong selected handle');
            const totalBytes = file ? fileBytes.length : source.totalBytes!;
            serialTasks.set(String(args.taskId), { totalBytes, file });
            return { totalBytes, connected: true, windowBytes: 2 };
          }
          case 'plugin_serial_task_step': {
            const task = serialTasks.get(String(args.taskId));
            if (!task) throw new Error('unknown serial task');
            if (hold === 'serial') {
              hold = null;
              await new Promise<void>(resolve => { resolveHeld = resolve; });
            }
            const bytesWritten = Math.min(2, task.totalBytes - Number(args.offset));
            if (task.file ? args.bytes !== null : (args.bytes as number[]).length !== bytesWritten) throw new Error('wrong serial window');
            return { outcome: 'written', bytesWritten };
          }
          case 'plugin_serial_task_close': serialTasks.delete(String(args.taskId)); return null;
          case 'send_serial_data': return 1;
          case 'plugin_shell_execute': return { exitCode: 9, stdout: 'legacy stdout', stderr: '' };
          case 'plugin_shell_open_session': return crypto.randomUUID();
          case 'plugin_shell_start': {
            const { program } = args.request as { program: string };
            const id = crypto.randomUUID();
            nativeProcesses.set(id, { program, stdout: ['o1', 'o2'], stderr: ['err'], cancelled: false });
            return id;
          }
          case 'plugin_shell_status': {
            const task = nativeProcesses.get(String(args.taskId))!;
            return task.cancelled ? terminal('cancelled') : args.wait ? terminal('exited', 7) : terminal('running');
          }
          case 'plugin_shell_read': {
            const task = nativeProcesses.get(String(args.taskId))!;
            if (task.cancelled) return { kind: 'eof' };
            if (task.program === 'wait-tool') return new Promise(resolve => { task.finish = resolve; });
            const chunk = (args.stream === 'stdout' ? task.stdout : task.stderr).shift();
            return chunk === undefined ? { kind: 'eof' } : { kind: 'chunk', base64: btoa(chunk) };
          }
          case 'plugin_shell_cancel': {
            const task = nativeProcesses.get(String(args.taskId))!;
            task.cancelled = true;
            task.finish?.({ kind: 'eof' });
            return terminal('cancelling');
          }
          case 'plugin_shell_release': nativeProcesses.delete(String(args.taskId)); return null;
          case 'plugin_shell_close_session':
          case 'append_diag_log': return null;
          default: throw new Error(`unexpected native command: ${cmd}`);
        }
      },
    };
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: mock });
    const hostModule = '/src/utils/pluginHost.ts';
    const storeModule = '/src/stores/useAppStore.ts';
    const panelModule = '/src/utils/pluginPanelRegistry.ts';
    const { PluginSession } = await import(/* @vite-ignore */ hostModule) as typeof import('../src/utils/pluginHost');
    const { useAppStore } = await import(/* @vite-ignore */ storeModule) as typeof import('../src/stores/useAppStore');
    const { getPluginPanelSnapshot } = await import(/* @vite-ignore */ panelModule) as typeof import('../src/utils/pluginPanelRegistry');
    const setGrants = (grantedPermissions: string[]) => useAppStore.getState().setConfig({
      pluginConfigs: [{ id: pluginId, enabled: true, installGeneration: generation, grantedPermissions }],
    });
    setGrants(grants);
    useAppStore.getState().setPorts([{ id: portId, name: portId, status: 'connected', mode: 'trx', type: 'real', isHidden: false, connectionGeneration: connection }]);
    const session = new PluginSession(pluginId);
    window.__streamTasksE2e = {
      calls, setGrants, logs: () => getPluginPanelSnapshot()[pluginId]?.buffer ?? '',
      run: buttonId => { if (!session.post({ type: 'ui.buttonClick', payload: { buttonId } })) throw new Error('Worker event refused'); },
      stop: () => session.stop(), start: () => session.startReady(), sizes: () => returnedBuffers.map(bytes => bytes.byteLength),
      hold: kind => { hold = kind; }, resolveHeld: () => { resolveHeld?.(); resolveHeld = undefined; },
    };
    await session.startReady();
  }, { pluginId: PLUGIN, generation: GENERATION, workerCode: WORKER, allGrants: GRANTS, grants, portId: PORT, connection: CONNECTION,
    readHandle: READ_HANDLE, writeHandle: WRITE_HANDLE, fileBytes: FILE_BYTES });
}

const run = (page: Page, name: string) => page.evaluate(name => window.__streamTasksE2e.run(name), name);
const calls = (page: Page) => page.evaluate(() => window.__streamTasksE2e.calls);
const logs = (page: Page) => page.evaluate(() => window.__streamTasksE2e.logs());
async function result(page: Page, key: string): Promise<unknown> {
  await expect.poll(() => logs(page)).toContain(`${key}:`);
  const text = (await logs(page)).split('\n').find(line => line.startsWith(`${key}:`));
  return JSON.parse(text!.slice(key.length + 1));
}

test('file, raw serial/file serial, and process outputs traverse the real worker and host; legacy APIs remain callable', async ({ page }) => {
  await setup(page);
  await run(page, 'roundtrip');
  expect(await result(page, 'first-output')).toEqual({ bytes: [111, 49], status: 'running' });
  expect(await result(page, 'roundtrip')).toMatchObject({
    selected: 'selected.bin', window: [0, 65, 255], range: [128, 0], typed: true, legacyFile: FILE_BYTES,
    staged: 3, committed: { bytesWritten: 3 },
    bytes: { status: 'completed', bytesWritten: 3, connectionGeneration: CONNECTION },
    file: { status: 'completed', bytesWritten: FILE_BYTES.length, connectionGeneration: CONNECTION },
    legacySerial: { bytesWritten: 1 }, legacyShell: { exitCode: 9, stdout: 'legacy stdout', stderr: '' },
    stdoutTail: 'o2', stderr: 'err', terminal: { state: 'exited', exitCode: 7, error: null },
  });
  const native = await calls(page);
  const find = (cmd: string) => native.find(call => call.cmd === cmd)!.args;
  const fileRead = find('plugin_file_read');
  expect(fileRead).toMatchObject({ pluginId: PLUGIN, expectedGeneration: GENERATION, handleId: READ_HANDLE, offset: 1, length: 3 });
  expect(fileRead.requestId).toMatch(/^[a-f\d-]{36}$/i);
  expect(fileRead).not.toHaveProperty('signal');
  expect(find('plugin_fs_read_ranges').sessionId).toBe(fileRead.sessionId);
  expect(native.filter(call => call.cmd === 'plugin_fs_open_session')).toHaveLength(1);
  expect(find('plugin_file_write')).toMatchObject({ handleId: WRITE_HANDLE, offset: 0, base64: 'CQD/' });
  expect(native).toContainEqual({ cmd: 'plugin_fs_release', args: { pluginId: PLUGIN, requestId: fileRead.requestId, sessionId: fileRead.sessionId } });
  expect(await page.evaluate(() => window.__streamTasksE2e.sizes())).toEqual([0]); // ArrayBuffer was transferred, not cloned.
  const serialBegins = native.filter(({ cmd }) => cmd === 'plugin_serial_task_begin');
  expect(serialBegins.map(({ args }) => ({ source: args.source, gen: args.connectionGeneration }))).toEqual([
    { source: { kind: 'bytes', totalBytes: 3 }, gen: CONNECTION },
    { source: { kind: 'file', sessionId: fileRead.sessionId, handleId: READ_HANDLE }, gen: CONNECTION },
  ]);
  expect(native.filter(({ cmd, args }) => cmd === 'plugin_serial_task_step' && args.taskId === serialBegins[0].args.taskId).map(({ args }) => args.bytes)).toEqual([[128, 0], [255]]);
  expect(native.filter(({ cmd, args }) => cmd === 'plugin_serial_task_step' && args.taskId === serialBegins[1].args.taskId).map(({ args }) => args.bytes)).toEqual([null, null, null]);
  expect(find('plugin_shell_read')).toMatchObject({ sessionId: find('plugin_shell_status').sessionId, stream: 'stdout' });
  expect(await logs(page)).not.toContain('error:');
});

test('related but insufficient grants are refused before reaching native IPC', async ({ page }) => {
  await setup(page, ['fs:assets', 'fs:export-dir', 'serial:control', 'shell:open']);
  await run(page, 'permissions');
  expect(await result(page, 'permissions')).toEqual([
    expect.stringContaining('fs:open'), expect.stringContaining('fs:save'),
    expect.objectContaining({ status: 'failed', bytesWritten: 0, message: expect.stringContaining('serial:send') }),
    expect.stringContaining('shell:execute'),
  ]);
  expect((await calls(page)).filter(({ cmd }) => /^plugin_(file_|fs_|serial_task_|shell_)/.test(cmd))).toEqual([]);
});

test('aborts a late selected read across the bridge and cancels only the pending shell task', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => window.__streamTasksE2e.hold('read'));
  await run(page, 'late-file');
  await expect.poll(async () => (await calls(page)).filter(({ cmd }) => cmd === 'plugin_file_read').length).toBe(1);
  const read = (await calls(page)).find(({ cmd }) => cmd === 'plugin_file_read')!.args;
  await page.evaluate(grants => window.__streamTasksE2e.setGrants(grants), GRANTS.filter(grant => grant !== 'fs:open'));
  await run(page, 'abort-file');
  expect(await result(page, 'late-file')).toBe('AbortError');
  await expect.poll(() => calls(page)).toContainEqual({ cmd: 'plugin_fs_cancel', args: { pluginId: PLUGIN, sessionId: read.sessionId, requestId: read.requestId } });
  await expect.poll(async () => (await calls(page)).filter(({ cmd }) => cmd === 'plugin_file_close').length).toBe(1);
  await page.evaluate(() => window.__streamTasksE2e.resolveHeld());
  await expect.poll(() => calls(page)).toContainEqual({ cmd: 'plugin_fs_release', args: { pluginId: PLUGIN, sessionId: read.sessionId, requestId: read.requestId } });
  expect(await page.evaluate(() => window.__streamTasksE2e.sizes())).toEqual([2]); // Late data was never delivered.
  expect(await logs(page)).not.toContain('unexpected-late-file');

  await run(page, 'shell-blocked');
  await expect.poll(async () => (await calls(page)).filter(({ cmd }) => cmd === 'plugin_shell_read').length).toBe(1);
  await run(page, 'cancel-shell');
  expect(await result(page, 'shell-cancel')).toBe('cancelling');
  expect(await result(page, 'shell-unblocked')).toEqual({ done: true, terminal: { state: 'cancelled', exitCode: null, error: null } });
  const native = await calls(page);
  const pending = native.find(({ cmd }) => cmd === 'plugin_shell_read')!.args;
  expect(native.find(({ cmd }) => cmd === 'plugin_shell_cancel')!.args).toEqual({ pluginId: PLUGIN, expectedGeneration: GENERATION, taskId: pending.taskId, sessionId: pending.sessionId });
  await expect.poll(async () => (await calls(page)).filter(({ cmd }) => cmd === 'plugin_shell_release').length).toBe(1);
});

test('retiring a Worker cancels its file-backed send before closing the FS session; the next epoch gets fresh sessions', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => window.__streamTasksE2e.hold('serial'));
  await run(page, 'stop-during-file-send');
  await expect.poll(async () => (await calls(page)).filter(({ cmd }) => cmd === 'plugin_serial_task_step').length).toBe(1);
  await page.evaluate(() => window.__streamTasksE2e.stop());
  const stopped = await calls(page);
  const index = (cmd: string) => stopped.findIndex(call => call.cmd === cmd);
  for (const cmd of ['plugin_serial_task_close', 'plugin_shell_close_session', 'plugin_file_close', 'plugin_fs_close_session']) expect(index(cmd)).toBeGreaterThan(-1);
  expect(index('plugin_serial_task_close')).toBeLessThan(index('plugin_fs_close_session'));
  expect(index('plugin_file_close')).toBeLessThan(index('plugin_fs_close_session'));
  await page.evaluate(() => window.__streamTasksE2e.start());
  await page.evaluate(() => window.__streamTasksE2e.resolveHeld());
  await run(page, 'fresh');
  expect(await result(page, 'fresh')).toEqual({ selected: 'selected.bin', state: 'running' });
  expect(await logs(page)).not.toContain('retired-output');
  const native = await calls(page);
  for (const cmd of ['plugin_file_pick_read', 'plugin_shell_start']) {
    const sessionIds = native.filter(call => call.cmd === cmd).map(call => call.args.sessionId);
    expect(sessionIds).toHaveLength(2);
    expect(sessionIds[0]).not.toBe(sessionIds[1]);
  }
});
