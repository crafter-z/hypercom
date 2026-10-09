/**
 * 插件 Worker 桥（宿主注入 worker 的代码前缀，issue #17，评审 v2 D1）
 *
 * worker 内插件代码**零宿主特权**——`self.plugin` 由本桥提供：
 * - `plugin.api.<op>(...args)`：经 postMessage 请求宿主执行（RPC 往返）；
 *   宿主侧**调用时权限校验**（评审 v2 P7，撤销即时生效）后执行真实实现。
 * - `plugin.on(type, cb)`：订阅宿主 → 插件事件（ui.buttonClick / rx.line 等）。
 * - 返回值 Promise：宿主侧错误/超时 → reject；原生文件选择等待用户完成。
 *
 * worker 无 window/document/__TAURI__/localStorage——桥是插件触达宿主的
 * **唯一通道**。未知 op / 无权限 op 由宿主拒绝（错误经 reject 透出）。
 *
 * 打包：宿主读 manifest.entry 后拼接桥前缀与用户代码包成 Blob 加载。
 * 桥必须**不依赖任何外部模块**（worker 内无 bundler）——纯自包含字符串。
 */
/** Host expires first; allow the worker one second to receive its reply. */
export const PLUGIN_RPC_TIMEOUT_MS = 10_000;
export const PLUGIN_HTTP_RPC_TIMEOUT_MS = 20_000;


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
      // 宿主对 plugin.api 调用的响应；超时后的迟到响应不再影响 Promise。
      var p = pending[msg.seq];
      if (p) {
        delete pending[msg.seq];
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || 'plugin api failed'));
      }
    } else if (typeof msg.type === 'string') {
      // Acknowledge after all handlers (including async forwarding) settle.
      var hs = handlers[msg.type] && handlers[msg.type].slice();
      var jobs = [];
      if (hs) {
        for (var i = 0; i < hs.length; i++) {
          try { jobs.push(Promise.resolve(hs[i](msg.payload))); }
          catch (e) { console.error('[plugin] handler', msg.type, e); }
        }
      }
      if (typeof msg.eventId === 'number') {
        Promise.allSettled(jobs).then(function () { self.postMessage({ eventAck: msg.eventId }); });
      }
    }
  };

  // api 代理：plugin.api.<op>(args) → 宿主
  var api = new Proxy({}, {
    get: function (_t, op) {
      if (typeof op !== 'string') return undefined;
      return function (args) {
        var id = ++seq;
        // Worker runtimes on older WebView2 releases lack Promise.withResolvers.
        return new Promise(function (resolve, reject) {
          // Native file selection/export may remain open for as long as the user needs.
          var timeout = op === 'fs.openDialog' || op === 'ui.panel.export' ? 0 :
            op === 'http.request' ? ${PLUGIN_HTTP_RPC_TIMEOUT_MS + 1000} : ${PLUGIN_RPC_TIMEOUT_MS + 1000};
          var timer = timeout && setTimeout(function () {
            delete pending[id];
            reject(new Error('plugin RPC timed out'));
          }, timeout);
          pending[id] = { resolve: resolve, reject: reject, timer: timer };
          try {
            self.postMessage({ seq: id, op: op, args: args === undefined ? null : args });
          } catch (e) {
            delete pending[id];
            clearTimeout(timer);
            reject(e);
          }
        });
      };
    }
  });

  // Host events are the registration contract; no callback can cross RPC structured clone.
  function on(type, cb) {
    if (typeof type !== 'string' || typeof cb !== 'function') throw new TypeError('event callback required');
    var list = handlers[type] = handlers[type] || [];
    list.push(cb);
    return function () {
      var index = list.indexOf(cb);
      if (index !== -1) list.splice(index, 1);
    };
  }

  var rx = {
    onLine: function (cb) { return on('rx.line', cb); },
    onBytes: function (cb) { return on('rx.bytes', cb); },
    onDetached: function (cb) { return on('rx.detached', cb); },
    onDropped: function (cb) { return on('rx.dropped', cb); }
  };

  self.plugin = { api: api, on: on, rx: rx };

  self.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    self.postMessage({ type: '__plugin_crash', payload: String(reason && reason.message || reason) });
  });

  // 向宿主上报就绪（宿主 start() 后插件代码可立即开始调用）
  self.postMessage({ type: '__plugin_ready' });
})();
`;

/** Wrap the manifest.entry classic worker script with the in-worker host bridge. */
export function wrapPluginCode(userCode: string): string {
  return `${PLUGIN_BRIDGE_CODE}\n${userCode}`;
}
