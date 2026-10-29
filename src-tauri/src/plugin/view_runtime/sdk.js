(() => {
  'use strict';
  if (globalThis.__hypercomViewSdkInstalled) return;
  Object.defineProperty(globalThis, '__hypercomViewSdkInstalled', { value: true, configurable: false, writable: false });
  const trustedWeb = __HOST_TRUSTED_WEB__;
  const hasWorker = __HOST_HAS_WORKER__;
  const CHUNK_BYTES = 8192;
  let documentId = null;
  const post = (value) => {
    const encoded = JSON.stringify(value);
    if (new TextEncoder().encode(encoded).length > 16384) throw new Error('View message exceeds 16 KiB');
    globalThis.ipc.postMessage(encoded);
  };
  const report = (error) => {
    try { post({ type: 'error', documentId, error: String(error?.stack || error).slice(0, 2048) }); }
    catch { /* Native channel may already be retired. */ }
  };
  const stateCallbacks = new Set();
  const environmentCallbacks = new Set();
  const binaryCallbacks = new Set();
  const pendingBinaryAcks = new Map();
  const inboundTransfers = new Map();
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

  const newId = () => {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const encodeBase64 = (bytes) => {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  };
  const decodeBase64 = (value) => {
    if (typeof value !== 'string') throw new TypeError('Invalid binary chunk');
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };
  const normalizeBytes = (value) => {
    if (value instanceof Uint8Array) return value.slice();
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    throw new TypeError('sendBinary requires Uint8Array or ArrayBuffer');
  };
  const validType = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128;

  const acknowledge = (message, ok, error) => {
    const ack = { type: 'binary-ack', documentId, transferId: message.transferId, seq: message.seq, done: message.done === true, ok };
    if (error) ack.error = String(error).slice(0, 2048);
    post(ack);
  };
  const handleBinaryAck = (message) => {
    if (!documentId || message.documentId !== documentId) return;
    const key = `${message.transferId}:${message.seq}`;
    const waiter = pendingBinaryAcks.get(key);
    if (!waiter) return;
    pendingBinaryAcks.delete(key);
    if (message.ok === true) waiter.resolve();
    else waiter.reject(new Error(typeof message.error === 'string' && message.error ? message.error : 'View binary transfer was rejected'));
  };
  const dispatchBinary = async (message) => {
    const transferId = message.transferId;
    if (typeof transferId !== 'string' || !transferId || transferId.length > 128
      || !Number.isSafeInteger(message.seq) || message.seq < 0) return;
    if (typeof message.done !== 'boolean' || !validType(message.transferType)) {
      acknowledge(message, false, 'invalid binary chunk metadata');
      return;
    }
    let state = inboundTransfers.get(transferId);
    if (!state) {
      if (message.seq !== 0) { acknowledge(message, false, 'binary chunk order mismatch'); return; }
      if (inboundTransfers.size >= 4) { acknowledge(message, false, 'too many binary transfers'); return; }
      state = { next: 0, transferType: message.transferType, chunks: [], total: 0 };
      inboundTransfers.set(transferId, state);
    }
    if (message.seq !== state.next || state.transferType !== message.transferType) {
      inboundTransfers.delete(transferId);
      acknowledge(message, false, 'binary chunk order mismatch');
      return;
    }
    let bytes;
    try { bytes = decodeBase64(message.data); }
    catch { inboundTransfers.delete(transferId); acknowledge(message, false, 'invalid binary chunk'); return; }
    if (bytes.length > CHUNK_BYTES) { inboundTransfers.delete(transferId); acknowledge(message, false, 'binary chunk exceeds 8 KiB'); return; }
    state.chunks.push(bytes);
    state.total += bytes.length;
    state.next++;
    if (!message.done) { acknowledge(message, true); return; }
    inboundTransfers.delete(transferId);
    const joined = new Uint8Array(state.total);
    let offset = 0;
    for (const part of state.chunks) { joined.set(part, offset); offset += part.length; }
    const payload = { type: state.transferType, bytes: joined };
    let failure = null;
    for (const callback of binaryCallbacks) {
      try { await callback(payload); }
      catch (error) { failure = error; break; }
    }
    acknowledge(message, failure === null, failure);
  };

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
      post({ type: 'state-ack', documentId, revision: message.revision });
    } else if (message.type === 'environment') {
      if (!initialized) throw new Error('View not initialized');
      environment = freeze(message.environment);
      for (const callback of environmentCallbacks) await callback(environment);
    } else if (message.type === 'binary-chunk') {
      if (!initialized) throw new Error('View not initialized');
      await dispatchBinary(message);
    } else {
      throw new Error('Unknown host view message');
    }
  };
  const sdk = Object.freeze({
    get context() { return context; },
    get documentId() { return documentId; },
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
    onBinary(callback) {
      if (typeof callback !== 'function') throw new TypeError('onBinary requires a callback');
      binaryCallbacks.add(callback);
      return () => binaryCallbacks.delete(callback);
    },
    send(type, payload) {
      if (!initialized) throw new Error('View not initialized');
      if (!hasWorker) throw new Error('View has no Worker peer');
      if (!validType(type)) throw new TypeError('Invalid view message type');
      post({ type: 'ui-message', documentId, messageType: type, payload });
    },
    sendBinary(type, value) {
      if (!hasWorker) return Promise.reject(new Error('View has no Worker binary peer'));
      if (!initialized) return Promise.reject(new Error('View not initialized'));
      if (!validType(type)) return Promise.reject(new TypeError('Invalid binary view type'));
      let bytes;
      try { bytes = normalizeBytes(value); }
      catch (error) { return Promise.reject(error); }
      const transferId = newId();
      const total = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
      const sendChunk = (seq) => new Promise((resolve, reject) => {
        const key = `${transferId}:${seq}`;
        pendingBinaryAcks.set(key, { resolve, reject });
        try {
          const start = seq * CHUNK_BYTES;
          const end = Math.min(bytes.length, start + CHUNK_BYTES);
          post({
            type: 'binary-chunk', documentId, transferId, transferType: type,
            seq, done: seq === total - 1, data: encodeBase64(bytes.subarray(start, end)),
          });
        } catch (error) {
          pendingBinaryAcks.delete(key);
          reject(error);
        }
      });
      return (async () => {
        for (let seq = 0; seq < total; seq++) await sendChunk(seq);
      })();
    },
  });
  Object.defineProperty(globalThis, 'view', { value: sdk, writable: false, configurable: false });
  const startDocument = (id) => {
    if (typeof id !== 'string' || !id) throw new Error('Invalid document identity');
    if (documentId !== null) {
      if (documentId === id) return;
      throw new Error('View document already started');
    }
    documentId = id;
    post({ type: 'ready', documentId });
  };
  Object.defineProperty(globalThis, '__hypercomViewDocumentStart', { configurable: false, writable: false, value: startDocument });
  Object.defineProperty(globalThis, '__hypercomViewDispatch', { configurable: false, writable: false, value(message) {
    if (!message) return;
    // Native rejects stale documents too; this keeps the page-side dispatcher
    // from ever applying a message addressed to another document generation.
    if (!documentId || message.documentId !== documentId) return;
    if (message.type === 'binary-ack') { handleBinaryAck(message); return; }
    if (message.type === 'environment') {
      pendingEnvironment = message;
      if (environmentQueued) return;
      environmentQueued = true;
      sequence = sequence.then(async () => {
        const latest = pendingEnvironment;
        pendingEnvironment = null;
        environmentQueued = false;
        if (latest) await apply(latest);
      }).catch(report);
      return;
    }
    if (++pending > 16) { pending--; report(new Error('Host view queue overflow')); return; }
    sequence = sequence.then(() => apply(message)).catch(report).finally(() => { pending--; });
  } });
  if (!trustedWeb) {
    addEventListener('error', (event) => { report(event.error || event.message || 'View resource failed to load'); }, true);
    addEventListener('unhandledrejection', (event) => report(event.reason));
  }
})();
