/**
 * 插件 Worker 桥（宿主注入 worker 的代码前缀，issue #17，评审 v2 D1）
 *
 * worker 内插件代码**零宿主特权**——`self.plugin` 由本桥提供：
 * - `plugin.api.<op>(...args)`：经 postMessage 请求宿主执行（RPC 往返）；
 *   宿主侧**调用时权限校验**（评审 v2 P7，撤销即时生效）后执行真实实现。
 * - `plugin.http.request(options)` / `plugin.http.stream(options)`：完整请求与
 *   拉取式字节流；`signal`（AbortSignal）在 Worker 内处理，**绝不跨结构化克隆**。
 * - `plugin.on(type, cb)`：订阅宿主 → 插件事件（ui.buttonClick / rx.line 等）。
 * - 返回值 Promise：宿主侧错误 → reject；普通 RPC 超时只 retire 槽位。
 *
 * worker 无 window/document/__TAURI__/localStorage——桥是插件触达宿主的
 * **唯一通道**。未知 op / 无权限 op 由宿主拒绝（错误经 reject 透出）。
 *
 * 打包：宿主读 manifest.entry 后拼接桥前缀与用户代码包成 Blob 加载。
 * `__plugin_ready` 在**用户代码同步执行完成之后**才发出——同步初始化异常
 * 属于启动失败（可重启/熔断），启动后的普通异步错误只上报诊断。
 * 桥必须**不依赖任何外部模块**（worker 内无 bundler）——纯自包含字符串。
 */
import { VIEW_BINARY_TRANSFER_TIMEOUT_MS } from './pluginViewBinary';

/** Host expires first; allow the worker one second to receive its reply. */
export const PLUGIN_RPC_TIMEOUT_MS = 10_000;
/** Hard resource lifetime for one binary RPC (per-chunk ACK has a shorter idle deadline). */
export const PLUGIN_BINARY_RPC_TIMEOUT_MS = VIEW_BINARY_TRANSFER_TIMEOUT_MS;

/**
 * Ops that legitimately wait for the user or the network. They have no host
 * deadline; native HTTP applies only the caller-supplied timeout.
 */
export function hasNoRpcDeadline(op: string): boolean {
  return op === 'fs.read' || op === 'fs.openDialog' || op === 'ui.panel.export' ||
    op === 'fs.write' || op === 'storage.set' ||
    op === 'http.request' || op === 'http.open' || op === 'http.read' || op === 'http.cancel';
}

/** worker 内执行的桥代码（字符串常量，宿主注入）。 */
export const PLUGIN_BRIDGE_CODE = `
(function () {
  'use strict';
  var seq = 0;
  var pending = Object.create(null);

  // 宿主 → 插件事件处理器（plugin.on）
  var handlers = Object.create(null);
  var viewSessions = Object.create(null);
  var viewDocuments = Object.create(null);
  var viewQueues = Object.create(null);
  var viewBinaryQueues = Object.create(null);
  var viewDeliveries = Object.create(null);

  self.onmessage = function (ev) {
    var msg = ev.data;
    if (!msg) return;
    if (typeof msg.seq === 'number' && 'ok' in msg) {
      // 宿主对 plugin.api 调用的响应；超时/abort 后的迟到响应不再影响 Promise。
      var p = pending[msg.seq];
      if (p) {
        delete pending[msg.seq];
        clearTimeout(p.timer);
        if (p.removeAbort) p.removeAbort();
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || 'plugin api failed'));
      }
    } else if (typeof msg.type === 'string') {
      if (msg.type.indexOf('view.') === 0) {
        var instanceId = msg.type === 'view.open' ? msg.payload.context.viewInstanceId : msg.payload.instanceId;
        if (msg.type === 'view.document') {
          // Trusted host authority: bind the current native document id.
          var documentId = msg.payload.documentId;
          if (typeof instanceId !== 'string' || typeof documentId !== 'string') {
            if (typeof msg.eventId === 'number') self.postMessage({ eventAck: msg.eventId });
            return;
          }
          viewDocuments[instanceId] = documentId;
          var documentSession = viewSessions[instanceId];
          if (documentSession) documentSession.documentId = documentId;
          if (typeof msg.eventId === 'number') self.postMessage({ eventAck: msg.eventId });
          return;
        }
        if (msg.type === 'view.close') {
          var oldSession = viewSessions[instanceId];
          if (oldSession) { oldSession.retired = true; delete viewSessions[instanceId]; }
          var deliveries = viewDeliveries[instanceId] || [];
          deliveries.forEach(function (delivery) {
            if (typeof delivery.eventId === 'number') {
              if (delivery.message && delivery.message.type === 'view.binary') {
                self.postMessage({ eventAck: delivery.eventId, ok: false, error: 'view closed' });
              } else {
                self.postMessage({ eventAck: delivery.eventId });
              }
            }
            delivery.message = null;
          });
          delete viewDeliveries[instanceId]; delete viewQueues[instanceId]; delete viewBinaryQueues[instanceId];
          delete viewDocuments[instanceId];
          if (oldSession) Promise.all(runHandlers('view.close', { view: oldSession.view, reason: msg.payload.reason })).catch(function (error) { console.error('[plugin] close handler', error); });
          if (typeof msg.eventId === 'number') self.postMessage({ eventAck: msg.eventId });
          return;
        }
        var delivery = { message: msg, eventId: msg.eventId };
        var list = viewDeliveries[instanceId] || (viewDeliveries[instanceId] = []);
        list.push(delivery);
        if (msg.type === 'view.binary') {
          // Binary chunks must not queue behind a view.open handler that is itself
          // awaiting sendBinary (that would deadlock the UI ack). They use their own
          // per-view queue and only wait until onOpen registered its handlers.
          var binarySession = viewSessions[instanceId];
          var binaryOutcome;
          if (!binarySession) {
            binaryOutcome = Promise.reject(new Error('view session not open'))
              .then(function () { return null; }, function (error) { return error; });
          } else {
            var gate = binarySession.openReady || Promise.resolve();
            var binaryQueue = viewBinaryQueues[instanceId] || Promise.resolve();
            binaryOutcome = binaryQueue.then(function () { return gate; }).then(function () {
              var message = delivery.message; delivery.message = null;
              if (!message) return undefined;
              // Accepted-transfer document must still be the session's authority.
              if (message.payload.documentId !== binarySession.documentId) {
                throw new Error('view document changed');
              }
              return dispatchView(message);
            }).then(function () { return null; }, function (error) { return error; });
            viewBinaryQueues[instanceId] = binaryOutcome.then(function () {});
          }
          binaryOutcome.then(function (error) {
            if (typeof delivery.eventId === 'number') {
              if (error) self.postMessage({ eventAck: delivery.eventId, ok: false, error: String(error && error.message || error) });
              else self.postMessage({ eventAck: delivery.eventId, ok: true });
            }
            var currentList = viewDeliveries[instanceId];
            if (currentList) { var index = currentList.indexOf(delivery); if (index >= 0) currentList.splice(index, 1); }
          });
          return;
        }
        var queue = viewQueues[instanceId] || Promise.resolve();
        var next = queue.then(function () {
          var message = delivery.message; delivery.message = null;
          return message ? dispatchView(message) : undefined;
        });
        viewQueues[instanceId] = next.catch(function (error) {
          console.error('[plugin] view handler', error);
          self.postMessage({ type: '__plugin_view_error', payload: {
            instanceId: instanceId, error: String(error && error.message || error)
          } });
        });
        next.finally(function () {
          if (typeof delivery.eventId === 'number') self.postMessage({ eventAck: delivery.eventId });
          var currentList = viewDeliveries[instanceId];
          if (currentList) { var index = currentList.indexOf(delivery); if (index >= 0) currentList.splice(index, 1); }
        }).catch(function () {});
        return;
      }
      var jobs = runHandlers(msg.type, msg.payload);
      if (typeof msg.eventId === 'number') {
        Promise.allSettled(jobs).then(function () { self.postMessage({ eventAck: msg.eventId }); });
      }
    }
  };

  function abortError() {
    try { return new DOMException('The operation was aborted.', 'AbortError'); }
    catch (error) {
      var fallback = new Error('The operation was aborted.');
      fallback.name = 'AbortError';
      return fallback;
    }
  }

  // UUID v4 so a cancel can target a request before its open RPC completes.
  function newRequestId() {
    if (self.crypto && typeof self.crypto.randomUUID === 'function') return self.crypto.randomUUID();
    var bytes = new Uint8Array(16);
    self.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = '';
    for (var i = 0; i < 16; i++) hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  // Fire-and-forget host op (cancellation): a reply is not needed and must not
  // create a pending slot that could leak.
  function sendFire(op, args) {
    try { self.postMessage({ seq: ++seq, op: op, args: args }); } catch (error) {}
  }

  // api 代理：plugin.api.<op>(args) → 宿主。HTTP open/request strip signal and
  // carry a pre-generated requestId so abort can cancel a pending open.
  function callHost(op, args) {
    var id = ++seq;
    var options = args && typeof args === 'object' ? args : {};
    var isHttp = op === 'http.request' || op === 'http.open';
    var signal = isHttp ? options.signal : undefined;
    var requestId;
    var wireArgs = args === undefined ? null : args;
    if (isHttp) {
      requestId = typeof options.requestId === 'string' && options.requestId ? options.requestId : newRequestId();
      wireArgs = {};
      for (var key in options) {
        if (key === 'signal' || key === 'requestId') continue;
        wireArgs[key] = options[key];
      }
      wireArgs.requestId = requestId;
    }
    var deadline = op === 'fs.read' || op === 'fs.openDialog' || op === 'ui.panel.export' ||
      op === 'fs.write' || op === 'storage.set' ||
      op === 'http.request' || op === 'http.open' || op === 'http.read' || op === 'http.cancel'
      ? 0 : op === 'view.sendBinary' ? ${PLUGIN_BINARY_RPC_TIMEOUT_MS + 1000} : ${PLUGIN_RPC_TIMEOUT_MS + 1000};
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) {
        // Never sent: no native request exists to cancel.
        reject(abortError());
        return;
      }
      var timer = deadline ? setTimeout(function () {
        if (!pending[id]) return;
        delete pending[id];
        reject(new Error('plugin RPC timed out'));
      }, deadline) : undefined;
      var onAbort = null;
      var entry = {
        resolve: resolve,
        reject: reject,
        timer: timer,
        removeAbort: function () { if (signal && onAbort) signal.removeEventListener('abort', onAbort); }
      };
      if (signal) {
        onAbort = function () {
          if (pending[id] !== entry) return;
          delete pending[id];
          clearTimeout(timer);
          if (requestId) sendFire('http.cancel', { requestId: requestId });
          reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      pending[id] = entry;
      try {
        self.postMessage({ seq: id, op: op, args: wireArgs });
      } catch (error) {
        if (pending[id] === entry) delete pending[id];
        clearTimeout(timer);
        entry.removeAbort();
        reject(error);
      }
    });
  }

  // Pull-driven byte stream over http.open/read/cancel. No total size cap: each
  // next() yields whatever the native transport delivered (bounded per chunk).
  function createStream(head, requestId, cancel, signal) {
    var done = false;
    var pendingReject = null;
    var onAbort = null;
    var lane = Promise.resolve();
    function clearAbort() {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      onAbort = null;
    }
    function stop() {
      if (done) return Promise.resolve();
      done = true;
      clearAbort();
      // Explicit cancel/return must settle an in-flight next even if native
      // cancellation later fails.
      var reject = pendingReject;
      pendingReject = null;
      if (reject) reject(abortError());
      return cancel();
    }
    if (signal) {
      if (signal.aborted) {
        done = true;
        void cancel().catch(function () {});
      } else {
        onAbort = function () {
          void stop().catch(function () {});
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    function pull() {
      if (done) return Promise.resolve({ done: true, value: undefined });
      return new Promise(function (resolve, reject) {
        pendingReject = reject;
        callHost('http.read', { requestId: requestId }).then(function (chunk) {
          if (pendingReject !== reject) return;
          pendingReject = null;
          var bytes = chunk && chunk.bytes;
          if (!chunk || chunk.done === true) {
            done = true;
            clearAbort();
            // A final chunk may still carry bytes: yield them once, then done.
            if (bytes && bytes.byteLength > 0) resolve({ done: false, value: bytes });
            else resolve({ done: true, value: undefined });
          } else if (!bytes || bytes.byteLength === 0) {
            // Zero-length non-final chunk: retry internally, never surface as EOF.
            pull().then(resolve, reject);
          } else {
            resolve({ done: false, value: bytes });
          }
        }, function (error) {
          if (pendingReject !== reject) return;
          pendingReject = null;
          stop().then(function () { reject(error); }, function () { reject(error); });
        });
      });
    }
    var iterator = {};
    iterator.next = function () {
      // Serialize concurrent next() calls on one lane; pendingReject is single-slot.
      var result = lane.then(function () { return pull(); });
      lane = result.then(function () {}, function () {});
      return result;
    };
    iterator.return = function () {
      return stop().then(function () { return { done: true, value: undefined }; });
    };
    iterator.throw = function (error) {
      return stop().then(function () { throw error; });
    };
    var body = {};
    body[Symbol.asyncIterator] = function () { return iterator; };
    return {
      status: head.status,
      headers: head.headers,
      url: head.url,
      body: body,
      cancel: function () { return stop(); }
    };
  }

  function httpStream(options) {
    var source = options && typeof options === 'object' ? options : {};
    var signal = source.signal;
    var requestId = typeof source.requestId === 'string' && source.requestId ? source.requestId : newRequestId();
    var wire = {};
    for (var key in source) {
      if (key === 'signal' || key === 'requestId' || key === 'responseType') continue;
      wire[key] = source[key];
    }
    wire.requestId = requestId;
    var cancelled = false;
    function cancelNative() {
      cancelled = true;
      // Explicit cancel()/return await this and see native failures; cleanup
      // callers attach their own catch.
      return callHost('http.cancel', { requestId: requestId });
    }
    return new Promise(function (resolve, reject) {
      var settled = false;
      function onAbort() {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        void cancelNative().catch(function () {});
        reject(abortError());
      }
      if (signal) {
        if (signal.aborted) {
          settled = true;
          reject(abortError());
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      callHost('http.open', wire).then(function (head) {
        if (settled || cancelled) {
          // Aborted while open was pending: release the native request.
          sendFire('http.cancel', { requestId: requestId });
          return;
        }
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(createStream(head, requestId, cancelNative, signal));
      }, function (error) {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(error);
      });
    });
  }

  var http = {
    request: function (options) { return callHost('http.request', options); },
    stream: function (options) { return httpStream(options); }
  };

  var api = new Proxy({}, {
    get: function (_t, op) {
      if (typeof op !== 'string') return undefined;
      return function (args) { return callHost(op, args); };
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

  function runHandlers(type, payload) {
    var hs = handlers[type] && handlers[type].slice();
    var jobs = [];
    if (hs) hs.forEach(function (handler) {
      try { jobs.push(Promise.resolve(handler(payload))); }
      catch (error) { jobs.push(Promise.reject(error)); }
    });
    return jobs;
  }

  function viewOn(session, type, callback) {
    if (typeof callback !== 'function') throw new TypeError('view callback required');
    var list = session.handlers[type] || (session.handlers[type] = []);
    list.push(callback);
    return function () { var index = list.indexOf(callback); if (index >= 0) list.splice(index, 1); };
  }
  function dispatchView(message) {
    var payload = message.payload;
    var id = message.type === 'view.open' ? payload.context.viewInstanceId : payload.instanceId;
    if (message.type === 'view.open') {
      var session = { handlers: Object.create(null), context: Object.freeze(payload.context), streamEpoch: payload.context.streamEpoch || 0, gapEpoch: -1, retired: false };
      session.documentId = typeof payload.documentId === 'string'
        ? payload.documentId
        : (viewDocuments[id] || null);
      var view = {
        context: session.context,
        params: payload.params,
        onInput: function (cb) { return viewOn(session, 'input', cb); },
        onDiscontinuity: function (cb) { return viewOn(session, 'discontinuity', cb); },
        onStatus: function (cb) { return viewOn(session, 'status', cb); },
        onMessage: function (cb) { return viewOn(session, 'message', cb); },
        onBinary: function (cb) { return viewOn(session, 'binary', cb); },
        publish: function (snapshot) { return session.retired ? Promise.reject(new Error('view session retired')) : api['view.publish']({ instanceId: id, snapshot: snapshot }); },
        sendSerial: function (args) { return session.retired ? Promise.reject(new Error('view session retired')) : api['view.sendSerial'](Object.assign({}, args, { instanceId: id })); },
        sendBinary: function (type, bytes) {
          if (session.retired) return Promise.reject(new Error('view session retired'));
          if (typeof type !== 'string' || !type) return Promise.reject(new TypeError('binary type required'));
          if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer) &&
            !(typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(bytes))) {
            return Promise.reject(new TypeError('binary bytes required'));
          }
          return api['view.sendBinary']({ instanceId: id, type: type, bytes: bytes, documentId: session.documentId }).then(function () {});
        }
      };
      session.view = Object.freeze(view);
      viewSessions[id] = session;
      // Registrations made before the first await in onOpen are complete now;
      // binary chunks may proceed without waiting for async open work.
      var openJobs = runHandlers('view.open', session.view);
      session.openReady = Promise.resolve();
      return Promise.all(openJobs).then(function () {
        if (!session.retired) self.postMessage({ type: '__plugin_view_ready', payload: { instanceId: id } });
      });
    }
    var current = viewSessions[id];
    if (!current) return Promise.resolve();
    if (message.type === 'view.close') {
      delete viewSessions[id];
      return Promise.all(runHandlers('view.close', { view: current.view, reason: payload.reason }));
    }
    var type = message.type.slice(5);
    var callbacks = current.handlers[type] || [];
    if (typeof payload.streamEpoch === 'number') {
      if (payload.streamEpoch < current.streamEpoch) return Promise.resolve();
      current.streamEpoch = payload.streamEpoch;
    }
    if (type === 'discontinuity') current.gapEpoch = payload.streamEpoch;
    var jobs = [];
    if (type === 'input' && payload.gapBefore && current.gapEpoch !== payload.streamEpoch) {
      current.gapEpoch = payload.streamEpoch;
      jobs = (current.handlers.discontinuity || []).map(function (cb) {
        return Promise.resolve().then(function () { if (!current.retired) return cb({ reason: 'input-gap', streamEpoch: payload.streamEpoch }); });
      });
    }
    return Promise.all(jobs).then(function () {
      if (current.retired) return;
      return Promise.all(callbacks.slice().map(function (cb) {
        return Promise.resolve().then(function () {
          if (current.retired) return;
          if (type === 'input') return cb(payload.batch);
          if (type === 'binary') return cb({ type: payload.type, bytes: payload.bytes });
          return cb(payload);
        });
      }));
    }).then(function () {
      if (!current.retired && type === 'message') return Promise.all(runHandlers('view.message', { view: current.view, type: payload.type, payload: payload.payload }));
    });
  }

  var views = {
    onOpen: function (cb) { return on('view.open', cb); },
    onClose: function (cb) { return on('view.close', cb); },
    onMessage: function (cb) { return on('view.message', cb); }
  };
  var tabs = {
    open: function (args) { return api['tabs.open'](args); },
    activate: function (args) { return api['tabs.activate'](args); },
    close: function (args) { return api['tabs.close'](args); },
    setTitle: function (args) { return api['tabs.setTitle'](args); },
    list: function () { return api['tabs.list'](); }
  };

  var rx = {
    onLine: function (cb) { return on('rx.line', cb); },
    onBytes: function (cb) { return on('rx.bytes', cb); },
    onDetached: function (cb) { return on('rx.detached', cb); },
    onDropped: function (cb) { return on('rx.dropped', cb); }
  };

  self.plugin = { api: api, http: http, on: on, rx: rx, views: views, tabs: tabs };

  // 普通异步异常只上报诊断（宿主记录后保留 worker）；同步初始化失败发生在
  // __plugin_ready 之前，由宿主按启动失败处理。
  self.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    self.postMessage({ type: '__plugin_error', payload: {
      kind: 'unhandledrejection',
      message: String(reason && reason.message || reason)
    } });
  });
})();
`;

/**
 * Wrap the manifest.entry classic worker script with the in-worker host bridge.
 * Ready is posted only after the user script finished synchronous initialization.
 */
export function wrapPluginCode(userCode: string): string {
  return `${PLUGIN_BRIDGE_CODE}\n${userCode}\n;self.postMessage({ type: '__plugin_ready' });`;
}
