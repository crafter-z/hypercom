/**
 * pluginRpc / pluginBridge 测试（issue #17，评审 v2 D3/P7 + §9 权限过滤矩阵）
 *
 * 覆盖：
 * - 权限过滤矩阵：无权限 / 部分权限 / 撤销后旧 op 被拒（调用时校验语义）；
 * - 未知 op 拒绝；
 * - 桥代码注入（wrapPluginCode 拼接 + 桥自包含）。
 */
import { describe, expect, it } from 'vitest';
import { checkOpAllowed, filterAllowedOps, OP_PERMISSIONS, checkPortScope, SENSITIVE_PERMISSIONS } from './pluginRpc';
import { PLUGIN_BRIDGE_CODE, wrapPluginCode } from './pluginBridge';

describe('权限过滤矩阵（调用时校验，评审 v2 P7）', () => {
  it('无权限：敏感 op 全拒，只读 op 放行', () => {
    const { allowed, denied } = filterAllowedOps(
      ['ports.list', 'ports.status', 'serial.send', 'http.request', 'fs.read', 'log', 'notify'],
      [],
    );
    expect(allowed.sort()).toEqual(['log', 'ports.list', 'ports.status']);
    expect(denied.sort()).toEqual(['fs.read', 'http.request', 'notify', 'serial.send']);
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
      'terminal.append',
      'serial.send',
      'fs.read',
      'fs.write',
      'http.request',
      'shell.openExternal',
      'clipboard.readText',
      'clipboard.writeText',
      'notify',
      'storage.get',
      'storage.set',
      'log',
    ];
    for (const op of declaredOps) {
      expect(OP_PERMISSIONS[op], `op ${op} 缺权限映射`).toBeDefined();
    }
  });

  it('无权限要求的 op（log/ports）标记为 null 放行；notify 需权限', () => {
    expect(OP_PERMISSIONS['log']).toBeNull();
    expect(OP_PERMISSIONS['ports.list']).toBeNull();
    expect(OP_PERMISSIONS['notify']).toBe('notify');
  });
});

describe('serial.send per-port 作用域（评审 v2 P10 / 复审补强）', () => {
  it('未声明 serial scope → 任意端口放行（serial:send 授权与守卫仍生效）', () => {
    expect(checkPortScope(null, 'COM1')).toBeNull();
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

  it('敏感权限集是 D3 声明的三项（确认框消费）', () => {
    expect(SENSITIVE_PERMISSIONS).toEqual(['serial:send', 'http:request', 'shell:execute']);
  });
});

describe('pluginBridge（评审 v2 D1/P6）', () => {
  it('wrapPluginCode 拼接桥 + 用户代码', () => {
    const user = "self.plugin.api.ports.list();";
    const wrapped = wrapPluginCode(user);
    expect(wrapped.startsWith(PLUGIN_BRIDGE_CODE)).toBe(true);
    expect(wrapped.endsWith(user)).toBe(true);
  });

  it('桥代码自包含（无 import/require/外部依赖）', () => {
    expect(PLUGIN_BRIDGE_CODE).not.toContain('import ');
    expect(PLUGIN_BRIDGE_CODE).not.toContain('require(');
    expect(PLUGIN_BRIDGE_CODE).toContain('self.plugin');
    expect(PLUGIN_BRIDGE_CODE).toContain('self.postMessage');
  });

  it('桥提供 api 代理与 on 订阅（字符串级断言）', () => {
    expect(PLUGIN_BRIDGE_CODE).toContain('self.plugin = { api: api, on: on }');
    expect(PLUGIN_BRIDGE_CODE).toContain('new Proxy');
  });
});
