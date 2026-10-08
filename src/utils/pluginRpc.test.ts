/**
 * pluginRpc / pluginBridge 测试（issue #17，评审 v2 D3/P7 + §9 权限过滤矩阵）
 *
 * 覆盖：
 * - 权限过滤矩阵：无权限 / 部分权限 / 撤销后旧 op 被拒（调用时校验语义）；
 * - 未知 op 拒绝；
 * - Worker 桥事件注册与调用语义。
 */
import { describe, expect, it, vi } from 'vitest';
import { checkOpAllowed, OP_PERMISSIONS, checkPortScope, SENSITIVE_PERMISSIONS } from './pluginRpc';
import { PLUGIN_BRIDGE_CODE } from './pluginBridge';

describe('权限过滤矩阵（调用时校验，评审 v2 P7）', () => {
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

  it('未知 op 拒绝', () => {
    expect(checkOpAllowed('totally.made.up', ['terminal:read'])).toContain('未知');
  });

  it('全部 op 都有权限映射（无遗漏——新增 API 必须登记权限点）', () => {
    // 若未来加 API 忘了登记权限 → 默认拒绝（undefined = 未知），此处守护
    // OP_PERMISSIONS 覆盖了 Host API v1 声明的全部 op。
    const declaredOps = [
      'ports.list',
      'ports.status',
      'rx.onLine',
      'rx.onBytes',
      'terminal.append',
      'serial.send',
      'fs.openDialog',
      'fs.read',
      'fs.write',
      'http.request',
      'shell.openExternal',
      'clipboard.readText',
      'clipboard.writeText',
      'notify',
      'ui.panel.append',
      'ui.panel.clear',
      'ui.panel.export',
      'storage.get',
      'storage.set',
      'log',
    ];
    for (const op of declaredOps) {
      expect(OP_PERMISSIONS[op], `op ${op} 缺权限映射`).toBeDefined();
    }
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

  it('敏感确认仅列出已交付的三项能力', () => {
    expect(SENSITIVE_PERMISSIONS).toEqual(['serial:send', 'http:request', 'shell:open']);
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
});
