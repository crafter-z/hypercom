/**
 * 插件 Worker 桥（宿主注入 worker 的代码前缀，issue #17，评审 v2 D1）
 *
 * worker 内插件代码**零宿主特权**——`self.plugin` 由本桥提供：
 * - `plugin.api.<op>(...args)`：经 postMessage 请求宿主执行（RPC 往返）；
 *   宿主侧**调用时权限校验**（评审 v2 P7，撤销即时生效）后执行真实实现。
 * - `plugin.on(type, cb)`：订阅宿主 → 插件事件（ui.buttonClick / rx.line 等）。
 * - 返回值 Promise：宿主侧超时/错误 → reject（错误串进 diaglog）。
 *
 * worker 无 window/document/__TAURI__/localStorage——桥是插件触达宿主的
 * **唯一通道**。未知 op / 无权限 op 由宿主拒绝（错误经 reject 透出）。
 *
 * 打包：宿主读 main.js 后拼接 `${BRIDGE_CODE}\n${userCode}` 包成 Blob 加载。
 * 桥必须**不依赖任何外部模块**（worker 内无 bundler）——纯自包含字符串。
 */

/** worker 内执行的桥代码（字符串常量，宿主注入）。 */
export const PLUGIN_BRIDGE_CODE = `
(function () {
  'use strict';
  var seq = 0;
  var pending = Object.create(null);

  // 宿主 → 插件事件处理器（plugin.on）
  var handlers = Object.create(null);

  self.onmessage = function (ev) {
    var msg = ev.data;
    if (!msg) return;
    if (typeof msg.seq === 'number' && 'ok' in msg) {
      // 宿主对 plugin.api 调用的响应
      var p = pending[msg.seq];
      if (p) {
        delete pending[msg.seq];
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || 'plugin api failed'));
      }
    } else if (typeof msg.type === 'string') {
      // 宿主 → 插件事件（ui.buttonClick / lifecycle / rx.line…）
      var hs = handlers[msg.type];
      if (hs) {
        for (var i = 0; i < hs.length; i++) {
          try { hs[i](msg.payload); } catch (e) { console.error('[plugin] handler', msg.type, e); }
        }
      }
    }
  };

  // api 代理：plugin.api.<op>(args) → 宿主
  var api = new Proxy({}, {
    get: function (_t, op) {
      if (typeof op !== 'string') return undefined;
      return function (args) {
        var id = ++seq;
        return new Promise(function (resolve, reject) {
          pending[id] = { resolve: resolve, reject: reject };
          self.postMessage({ seq: id, op: op, args: args === undefined ? null : args });
          // 宿主侧超时已覆盖（RPC_TIMEOUT_MS）；此处不重复计时。
        });
      };
    }
  });

  // plugin.on(type, cb) 订阅宿主事件
  function on(type, cb) {
    if (typeof type !== 'string' || typeof cb !== 'function') return;
    (handlers[type] = handlers[type] || []).push(cb);
  }

  self.plugin = { api: api, on: on };

  // 向宿主上报就绪（宿主 start() 后插件代码可立即开始调用）
  self.postMessage({ type: '__plugin_ready' });
})();
`;

/** 把用户 main.js 包上桥代码（无 ESM import/require 的普通脚本，评审 v2 P6）。 */
export function wrapPluginCode(userCode: string): string {
  return `${PLUGIN_BRIDGE_CODE}\n${userCode}`;
}
