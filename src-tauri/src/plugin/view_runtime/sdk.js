(() => {
  'use strict';
  const post = (value) => {
    const encoded = JSON.stringify(value);
    if (new TextEncoder().encode(encoded).length > 16384) throw new Error('View message exceeds 16 KiB');
    globalThis.ipc.postMessage(encoded);
  };
  const report = (error) => { try { post({ type: 'error', error: String(error?.stack || error).slice(0, 2048) }); } catch { /* Native channel may already be retired. */ } };
  const stateCallbacks = new Set();
  const environmentCallbacks = new Set();
  const freeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    }
    return value;
  };
  let context = freeze(__HOST_VIEW_CONTEXT__);
  let environment = null;
  let initialized = false;
  let sequence = Promise.resolve();
  let pending = 0;
  let pendingEnvironment = null;
  let environmentQueued = false;
  let lastRevision = -1;
  let loadFailed = false;
  const apply = async (message) => {
    if (message.type === 'init') {
      if (initialized) throw new Error('View already initialized');
      context = freeze(message.context);
      environment = freeze(message.environment);
      initialized = true;
      for (const callback of environmentCallbacks) await callback(environment);
    } else if (message.type === 'state') {
      if (!initialized || !Number.isSafeInteger(message.revision) || message.revision <= lastRevision) throw new Error('Invalid view state revision');
      for (const callback of stateCallbacks) await callback(message.snapshot);
      lastRevision = message.revision;
      post({ type: 'state-ack', revision: message.revision });
    } else if (message.type === 'environment') {
      if (!initialized) throw new Error('View not initialized');
      environment = freeze(message.environment);
      for (const callback of environmentCallbacks) await callback(environment);
    } else {
      throw new Error('Unknown host view message');
    }
  };
  const sdk = Object.freeze({
    get context() { return context; },
    onState(callback) {
      if (typeof callback !== 'function') throw new TypeError('onState requires a callback');
      stateCallbacks.add(callback);
      return () => stateCallbacks.delete(callback);
    },
    onEnvironment(callback) {
      if (typeof callback !== 'function') throw new TypeError('onEnvironment requires a callback');
      environmentCallbacks.add(callback);
      if (environment) {
        sequence = sequence.then(() => callback(environment)).catch(report);
      }
      return () => environmentCallbacks.delete(callback);
    },
    send(type, payload) {
      if (!initialized) throw new Error('View not initialized');
      if (typeof type !== 'string' || !type || type.length > 128) throw new TypeError('Invalid view message type');
      post({ type: 'ui-message', messageType: type, payload });
    },
  });
  Object.defineProperty(globalThis, 'view', { value: sdk, writable: false, configurable: false });
  Object.defineProperty(globalThis, '__hypercomViewDispatch', { configurable: false, writable: false, value(message) {
    if (message.type === 'environment') {
      pendingEnvironment = message;
      if (environmentQueued) return;
      environmentQueued = true;
      sequence = sequence.then(async () => {
        const latest = pendingEnvironment;
        pendingEnvironment = null;
        environmentQueued = false;
        await apply(latest);
      }).catch(report);
      return;
    }
    if (++pending > 16) { pending--; report(new Error('Host view queue overflow')); return; }
    sequence = sequence.then(() => apply(message)).catch(report).finally(() => { pending--; });
  } });
  addEventListener('error', (event) => { loadFailed = true; report(event.error || event.message || 'View resource failed to load'); }, true);
  addEventListener('unhandledrejection', (event) => report(event.reason));
  // Deferred classic scripts execute in document order. load means the declared bundle
  // and styles have loaded, not merely that the native shell was navigated to.
  addEventListener('load', () => { if (!loadFailed) post({ type: 'ready' }); }, { once: true });
})();
