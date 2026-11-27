/**
 * pluginRpc / pluginBridge 测试（issue #17，评审 v2 D3/P7 + §9 权限过滤矩阵）
 *
 * 覆盖：
 * - 权限过滤矩阵：无权限 / 部分权限 / 撤销后旧 op 被拒（调用时校验语义）；
 * - 未知 op 拒绝；
 * - Worker 桥事件注册与调用语义。
 */
import { describe, expect, it, vi } from 'vitest';
import { checkOpAllowed, OP_PERMISSIONS, checkPortScope, SENSITIVE_PERMISSIONS, PLUGIN_SERIAL_TASK_OPS } from './pluginRpc';
import { PLUGIN_FILE_HANDLE_OPS } from './pluginFileHandle';
import { PLUGIN_PROCESS_OPS } from './pluginProcess';
import { PLUGIN_BRIDGE_CODE } from './pluginBridge';
import hostApiSource from './pluginHostApi.ts?raw';

describe('权限过滤矩阵（调用时校验，评审 v2 P7）', () => {
  it('covers every dispatched API operation with an explicit permission policy', () => {
    const dispatched = [...hostApiSource.matchAll(/case '([^']+)':/g)].map(match => match[1]);
    expect(dispatched.length).toBeGreaterThan(0);
    const all = [...dispatched, ...PLUGIN_FILE_HANDLE_OPS, ...PLUGIN_SERIAL_TASK_OPS, ...PLUGIN_PROCESS_OPS];
    expect([...new Set(all)].sort()).toEqual(Object.keys(OP_PERMISSIONS).sort());
  });

  it('never inherits task permissions from related grants and keeps ownership-only cleanup available', () => {
    expect(checkOpAllowed('fs.openFile', ['fs:assets', 'fs:open-dir', 'fs:save'])).toContain('fs:open');
    expect(checkOpAllowed('fs.createFile', ['fs:open', 'fs:export-dir'])).toContain('fs:save');
    expect(checkOpAllowed('serial.beginSend', ['serial:send'], { kind: 'file' })).toContain('fs:open');
    expect(checkOpAllowed('serial.beginSend', ['serial:send', 'fs:open'], { kind: 'file' })).toBeNull();
    expect(checkOpAllowed('serial.beginSend', ['serial:send'], { kind: 'bytes' })).toBeNull();
    expect(checkOpAllowed('serial.sendStep', ['serial:control'])).toContain('serial:send');
    for (const op of PLUGIN_PROCESS_OPS) {
      expect(checkOpAllowed(op, ['shell:open'])).toContain('shell:execute');
      expect(checkOpAllowed(op, ['shell:execute'])).toBeNull();
    }
    for (const op of ['fs.closeFile', 'fs.cancelFileRequest', 'serial.cancelSend']) expect(checkOpAllowed(op, [])).toBeNull();
  });
  it('无权限：敏感 op 全拒，只读 op 放行', () => {
    expect(checkOpAllowed('ports.list', [])).toBeNull();
    expect(checkOpAllowed('ports.status', [])).toBeNull();
    expect(checkOpAllowed('log', [])).toBeNull();
    expect(checkOpAllowed('serial.send', [])).not.toBeNull();
    expect(checkOpAllowed('http.request', [])).not.toBeNull();
    expect(checkOpAllowed('fs.read', [], { rel: 'assets/help.txt' })).not.toBeNull();
    expect(checkOpAllowed('notify', [])).not.toBeNull();
  });

  it('部分授予：仅授予的敏感 op 放行', () => {
    const granted = ['terminal:read', 'http:request'];
    expect(checkOpAllowed('rx.onLine', granted)).toBeNull();
    expect(checkOpAllowed('http.request', granted)).toBeNull();
    expect(checkOpAllowed('serial.send', granted)).not.toBeNull();
    expect(checkOpAllowed('fs.write', granted)).not.toBeNull();
  });

  it('撤销即时生效：授予集变化后旧 op 被拒（无缓存语义）', () => {
    // 模拟「先授予后撤销」——checkOpAllowed 每次按传入的当前集判断，
    // 宿主侧每次 RPC 传最新 grantedPermissions → 撤销即拒。
    const grantedBefore = ['serial:send'];
    expect(checkOpAllowed('serial.send', grantedBefore)).toBeNull();
    const grantedAfter: string[] = []; // 撤销
    expect(checkOpAllowed('serial.send', grantedAfter)).not.toBeNull();
  });

  it('shell.execute has its own high-risk grant, never inherited from shell:open', () => {
    expect(OP_PERMISSIONS['shell.execute']).toBe('shell:execute');
    expect(checkOpAllowed('shell.execute', ['shell:open'])).toContain('shell:execute');
    expect(checkOpAllowed('shell.execute', ['shell:execute'])).toBeNull();
    expect(checkOpAllowed('shell.openExternal', ['shell:execute'])).toContain('shell:open');
    expect(checkOpAllowed('shell.execute', [])).toContain('shell:execute');
  });

  it('serial control is independent of serial sending and revokes immediately', () => {
    for (const op of ['serial.open', 'serial.close']) {
      expect(OP_PERMISSIONS[op]).toBe('serial:control');
      expect(checkOpAllowed(op, ['serial:send'])).toContain('serial:control');
      expect(checkOpAllowed(op, ['serial:control'])).toBeNull();
      expect(checkOpAllowed(op, [])).toContain('serial:control');
    }
    expect(checkOpAllowed('serial.send', ['serial:control'])).toContain('serial:send');
  });

  it('minimal file grants never inherit reading, destructive writes, or each other', () => {
    expect(OP_PERMISSIONS['fs.exportFile']).toBe('fs:export-dir');
    expect(OP_PERMISSIONS['fs.saveFile']).toBe('fs:save');
    for (const permission of ['fs:open', 'fs:open-dir', 'fs:write-dir', 'fs:assets', 'fs:storage']) {
      expect(checkOpAllowed('fs.exportFile', [permission])).toContain('fs:export-dir');
      expect(checkOpAllowed('fs.saveFile', [permission])).toContain('fs:save');
    }
    expect(checkOpAllowed('fs.exportFile', ['fs:export-dir'])).toBeNull();
    expect(checkOpAllowed('fs.saveFile', ['fs:save'])).toBeNull();
    expect(checkOpAllowed('fs.exportFile', ['fs:save'])).not.toBeNull();
    expect(checkOpAllowed('fs.saveFile', ['fs:export-dir'])).not.toBeNull();
    expect(checkOpAllowed('fs.openDirectoryDialog', ['fs:export-dir'])).toBeNull();
    for (const op of ['fs.listDirectory', 'fs.readDirectoryFile', 'fs.statDirectoryEntry',
      'fs.writeDirectoryFile', 'fs.createDirectory', 'fs.removeDirectoryEntry', 'fs.renameDirectoryEntry', 'fs.openDialog']) {
      expect(checkOpAllowed(op, ['fs:export-dir'])).not.toBeNull();
      expect(checkOpAllowed(op, ['fs:save'])).not.toBeNull();
    }
    expect(checkOpAllowed('ui.panel.export', [])).toBeNull();
  });

  it('未知 op 拒绝', () => {
    expect(checkOpAllowed('totally.made.up', ['terminal:read'])).toContain('未知');
  });

  it('新增能力权限点：rx.onBytes 需 rx:bytes；fs.openDialog 需 fs:open（与 fs:assets 分离）', () => {
    expect(OP_PERMISSIONS['rx.onBytes']).toBe('rx:bytes');
    expect(checkOpAllowed('rx.onBytes', [])).toContain('rx:bytes');
    expect(checkOpAllowed('rx.onBytes', ['rx:bytes'])).toBeNull();

    expect(OP_PERMISSIONS['fs.openDialog']).toBe('fs:open');
    // fs:assets（仅读自身资产）不得隐式覆盖任意文件打开。
    expect(checkOpAllowed('fs.openDialog', ['fs:assets'])).not.toBeNull();
    expect(checkOpAllowed('fs.openDialog', ['fs:open'])).toBeNull();
  });

  it('fs:open-dir gates the directory APIs and never reuses the fs:open file grant', () => {
    for (const op of ['fs.listDirectory', 'fs.readDirectoryFile', 'fs.statDirectoryEntry']) {
      expect(OP_PERMISSIONS[op]).toBe('fs:open-dir');
      expect(checkOpAllowed(op, [])).toContain('fs:open-dir');
      expect(checkOpAllowed(op, ['fs:open'])).not.toBeNull();
      expect(checkOpAllowed(op, ['fs:open-dir'])).toBeNull();
    }
    // 反向：目录授权不得打开任意文件。
    expect(checkOpAllowed('fs.openDialog', ['fs:open-dir'])).not.toBeNull();
    expect(checkOpAllowed('fs.openDialog', ['fs:write-dir'])).not.toBeNull();
  });

  it('opens the directory picker with either directory grant and rejects file-only grants', () => {
    // 选择器是取得目录根的唯一入口；读/写任一权限都可打开。
    expect(OP_PERMISSIONS['fs.openDirectoryDialog']).toBe('fs:open-dir');
    const denied = checkOpAllowed('fs.openDirectoryDialog', []);
    expect(denied).toContain('fs:open-dir');
    expect(denied).toContain('fs:write-dir');
    expect(checkOpAllowed('fs.openDirectoryDialog', ['fs:open'])).not.toBeNull();
    expect(checkOpAllowed('fs.openDirectoryDialog', ['fs:assets'])).not.toBeNull();
    expect(checkOpAllowed('fs.openDirectoryDialog', ['fs:open-dir'])).toBeNull();
    expect(checkOpAllowed('fs.openDirectoryDialog', ['fs:write-dir'])).toBeNull();
    expect(checkOpAllowed('fs.openDirectoryDialog', ['fs:open-dir', 'fs:write-dir'])).toBeNull();
  });

  it('separates directory read grants from directory write grants', () => {
    for (const op of ['fs.listDirectory', 'fs.readDirectoryFile', 'fs.statDirectoryEntry']) {
      expect(OP_PERMISSIONS[op]).toBe('fs:open-dir');
      expect(checkOpAllowed(op, ['fs:open-dir'])).toBeNull();
      // 写授权不得隐式升级为读授权（反向亦然）。
      expect(checkOpAllowed(op, ['fs:write-dir'])).not.toBeNull();
      expect(checkOpAllowed(op, [])).toContain('fs:open-dir');
    }
    for (const op of ['fs.writeDirectoryFile', 'fs.createDirectory', 'fs.removeDirectoryEntry', 'fs.renameDirectoryEntry']) {
      expect(OP_PERMISSIONS[op]).toBe('fs:write-dir');
      expect(checkOpAllowed(op, ['fs:write-dir'])).toBeNull();
      expect(checkOpAllowed(op, ['fs:open-dir'])).not.toBeNull();
      expect(checkOpAllowed(op, [])).toContain('fs:write-dir');
    }
  });

  it('fs.releaseDirectory is cleanup and needs no permission', () => {
    expect(OP_PERMISSIONS['fs.releaseDirectory']).toBeNull();
    expect(checkOpAllowed('fs.releaseDirectory', [])).toBeNull();
    expect(checkOpAllowed('fs.releaseDirectory', ['fs:open-dir'])).toBeNull();
  });
  it('fs.read grants only the requested data or package path', () => {
    expect(checkOpAllowed('fs.read', ['fs:storage'], { rel: 'data/state.json' })).toBeNull();
    expect(checkOpAllowed('fs.read', ['fs:storage'], { rel: 'assets/help.txt' })).toContain('fs:assets');
    expect(checkOpAllowed('fs.read', ['fs:assets'], { rel: 'assets/help.txt' })).toBeNull();
    expect(checkOpAllowed('fs.read', ['fs:assets'], { rel: 'data/state.json' })).toContain('fs:storage');
    expect(checkOpAllowed('fs.read', ['fs:storage'], { rel: 'data\\settings.json' })).toBeNull();
    expect(checkOpAllowed('fs.read', ['fs:assets'], { rel: 'data/../assets/help.txt' })).not.toBeNull();
    expect(checkOpAllowed('fs.read', ['fs:assets'])).not.toBeNull();
  });

  it('无权限要求的 op（log/ports）标记为 null 放行；notify 需权限', () => {
    expect(OP_PERMISSIONS['log']).toBeNull();
    expect(OP_PERMISSIONS['ports.list']).toBeNull();
    expect(OP_PERMISSIONS['notify']).toBe('notify');
  });

  it('host.info is a permission-free read-only capability query', () => {
    expect(OP_PERMISSIONS['host.info']).toBeNull();
    expect(checkOpAllowed('host.info', [])).toBeNull();
    expect(checkOpAllowed('host.info', ['serial:control'])).toBeNull();
  });
});

describe('serial.send per-port 作用域（评审 v2 P10 / 复审补强）', () => {
  it('未声明 serial scope → 任意端口放行（serial:send 授权与守卫仍生效）', () => {
    expect(checkPortScope(null, 'COM1')).toContain('manifest 不可用');
    expect(checkPortScope({}, 'COM1')).toBeNull();
    expect(checkPortScope({ serial: undefined }, 'COM1')).toBeNull();
  });

  it('声明白名单：命中的端口放行、未命中拒绝', () => {
    const m = { serial: { portWhitelist: ['COM3', 'COM7'] } };
    expect(checkPortScope(m, 'COM3')).toBeNull();
    expect(checkPortScope(m, 'COM9')).toContain('不在插件 serial.portWhitelist');
  });

  it('声明为空数组 → 全部拒绝（与 http.urlWhitelist 同规）', () => {
    expect(checkPortScope({ serial: { portWhitelist: [] } }, 'COM1')).toContain('空数组');
  });

  it('敏感确认列出已交付的高风险能力', () => {
    expect(SENSITIVE_PERMISSIONS).toEqual(['serial:control', 'serial:send', 'http:request', 'shell:open', 'shell:execute', 'fs:export-dir', 'fs:save', 'fs:write-dir']);
  });
});

describe('windowed file permissions', () => {
  it('requires the correct per-range capability and rejects the entire mixed batch', () => {
    expect(checkOpAllowed('fs.readRange', ['fs:assets'], { rel: 'a' })).toBeNull();
    expect(checkOpAllowed('fs.readRange', ['fs:storage'], { rel: './data/a' })).toBeNull();
    expect(checkOpAllowed('fs.readRange', ['fs:assets'], { rel: 'data/a' })).toContain('fs:storage');
    expect(checkOpAllowed('fs.readRange', ['fs:open-dir'], { rel: 'a', grantId: 'grant' })).toBeNull();
    expect(checkOpAllowed('fs.readRange', ['fs:write-dir'], { rel: 'a', grantId: 'grant' })).toContain('fs:open-dir');
    const args = { ranges: [{ rel: 'a' }, { rel: 'data/a' }, { rel: 'a', grantId: 'grant' }] };
    expect(checkOpAllowed('fs.readRanges', ['fs:assets', 'fs:storage'], args)).toContain('fs:open-dir');
    expect(checkOpAllowed('fs.readRanges', ['fs:assets', 'fs:storage', 'fs:open-dir'], args)).toBeNull();
    expect(checkOpAllowed('fs.cancel', [])).toBeNull();
    expect(checkOpAllowed('fs.listDirectoryPage', ['fs:assets'], { grantId: 'grant' })).toContain('fs:open-dir');
  });
  it('uses UTF-8 byte path limits for new ranges/pages while keeping legacy path contracts', () => {
    for (const rel of ['a'.repeat(4096), '中'.repeat(1365) + 'a', '😀'.repeat(1024)]) {
      expect(checkOpAllowed('fs.readRange', ['fs:assets'], { rel })).toBeNull();
      expect(checkOpAllowed('fs.listDirectoryPage', ['fs:open-dir'], { grantId: 'grant', rel })).toBeNull();
    }
    for (const rel of ['a'.repeat(4097), '中'.repeat(1366), '😀'.repeat(1024) + 'a', '\ud800', '\udc00']) {
      expect(checkOpAllowed('fs.readRange', ['fs:assets'], { rel })).not.toBeNull();
      expect(checkOpAllowed('fs.readRanges', ['fs:assets'], { ranges: [{ rel: 'a' }, { rel }] })).not.toBeNull();
      expect(checkOpAllowed('fs.listDirectoryPage', ['fs:open-dir'], { grantId: 'grant', rel })).not.toBeNull();
    }
    expect(checkOpAllowed('fs.listDirectoryPage', ['fs:open-dir'], { grantId: 'grant', rel: '' })).toBeNull();
    expect(checkOpAllowed('fs.read', ['fs:assets'], { rel: '中'.repeat(1366) })).toBeNull();
  });
  it.each([null, {}, { ranges: [] }, { ranges: [null] }, { ranges: [{ rel: '../a' }] },
    { ranges: [{ rel: '/data/a' }] }, { ranges: [{ rel: 'C:a' }] }, { ranges: [{ rel: 'a', grantId: null }] },
  ])('fails closed on malformed batch identity: %j', args => {
    expect(checkOpAllowed('fs.readRanges', ['fs:assets', 'fs:storage', 'fs:open-dir'], args)).not.toBeNull();
  });
});

describe('plugin worker event registration contract', () => {
  it('registers RX event handlers, unsubscribes, and acknowledges only after async handlers settle', async () => {
    const posted: unknown[] = [];
    let release!: () => void;
    const worker = {
      postMessage: (message: unknown) => posted.push(message),
      addEventListener: () => {},
    } as { postMessage: (message: unknown) => void; addEventListener: () => void; onmessage?: (event: { data: unknown }) => void; plugin?: { rx: { onLine: (handler: (payload: unknown) => Promise<void>) => () => void } } };
    new Function('self', PLUGIN_BRIDGE_CODE)(worker);
    const handled: unknown[] = [];
    const unsubscribe = worker.plugin!.rx.onLine((payload) => new Promise<void>((resolve) => {
      handled.push(payload);
      release = resolve;
    }));
    worker.onmessage!({ data: { type: 'rx.line', payload: [{ seq: 1 }], eventId: 5 } });
    expect(handled).toEqual([[{ seq: 1 }]]);
    expect(posted).not.toContainEqual({ eventAck: 5 });
    release();
    await vi.waitFor(() => expect(posted).toContainEqual({ eventAck: 5 }));
    unsubscribe();
    worker.onmessage!({ data: { type: 'rx.line', payload: [], eventId: 6 } });
    await vi.waitFor(() => expect(posted).toContainEqual({ eventAck: 6 }));
    expect(handled).toHaveLength(1);
  });
  it('rejects unknown bridge event handlers instead of silently claiming subscriptions', () => {
    const worker = { postMessage: vi.fn(), addEventListener: vi.fn() } as {
      postMessage: (message: unknown) => void;
      addEventListener: (type: string, handler: (event: unknown) => void) => void;
      plugin?: { rx: { onLine: (handler: unknown) => () => void } };
    };
    new Function('self', PLUGIN_BRIDGE_CODE)(worker);
    expect(() => worker.plugin?.rx.onLine('not-a-function')).toThrow('event callback required');
  });
  it('exposes the permission-free host capability query as plugin.host.info()', async () => {
    const posted: Array<{ seq: number; op: string; args: unknown }> = [];
    const worker = {
      postMessage: (message: { seq: number; op: string; args: unknown }) => posted.push(message),
      addEventListener: () => {},
    } as {
      postMessage: (message: { seq: number; op: string; args: unknown }) => void;
      addEventListener: () => void;
      onmessage?: (event: { data: unknown }) => void;
      plugin?: { host: { info: () => Promise<unknown> } };
    };
    new Function('self', PLUGIN_BRIDGE_CODE)(worker);
    const pending = worker.plugin!.host.info();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ op: 'host.info', args: null });
    const response = { apiVersion: 1, features: { serialLoan: true, portLease: true } };
    worker.onmessage!({ data: { seq: posted[0].seq, ok: true, result: response } });
    await expect(pending).resolves.toEqual(response);
  });
});
