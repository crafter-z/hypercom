(() => {
  'use strict';
  if (globalThis.__hypercomViewSdkInstalled) return;
  Object.defineProperty(globalThis, '__hypercomViewSdkInstalled', { value: true, configurable: false, writable: false });
  const trustedWeb = __HOST_TRUSTED_WEB__;
  const hasWorker = __HOST_HAS_WORKER__;
  const CHUNK_BYTES = 8192;
  const MAX_BINARY_TRANSFER_BYTES = 256 * 1024 * 1024;
  const MAX_BINARY_BYTES = 512 * 1024 * 1024;
  const MAX_BINARY_TRANSFERS = 4;
  const BINARY_IDLE_MS = 60000;
  const BINARY_ACK_MS = 30000;
  let binaryBytes = 0;
  let binaryTransfers = 0;
  const reserveBinary = (bytes, transfers = 0) => {
    if (binaryBytes + bytes > MAX_BINARY_BYTES || binaryTransfers + transfers > MAX_BINARY_TRANSFERS) throw new Error('View binary aggregate capacity exceeded');
    binaryBytes += bytes; binaryTransfers += transfers;
    let active = true;
    return () => { if (!active) return; active = false; binaryBytes -= bytes; binaryTransfers -= transfers; };
  };
  const deadline = (promise, ms, reason) => {
    let timer;
    const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), ms); });
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
  };
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
  // Slow binary handlers must not strand ordinary state/environment ACKs.
  let binarySequence = Promise.resolve();
  let pendingBinaryMessages = 0;
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
    if (typeof value !== 'string' || value.length > Math.ceil(CHUNK_BYTES / 3) * 4) throw new TypeError('Invalid binary chunk');
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
    if (waiter.done !== message.done) return;
    pendingBinaryAcks.delete(key);
    clearTimeout(waiter.timer);
    if (message.ok === true) waiter.resolve();
    else waiter.reject(new Error(typeof message.error === 'string' && message.error ? message.error : 'View binary transfer was rejected'));
  };
  const removeInbound = (id) => {
    const state = inboundTransfers.get(id);
    if (!state) return;
    clearTimeout(state.timer); state.releases.forEach(release => release());
    state.chunks.length = 0; inboundTransfers.delete(id);
  };
  const dispatchBinary = async (message) => {
    const transferId = message.transferId;
    if (typeof transferId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(transferId)) return;
    if (!Number.isSafeInteger(message.seq) || message.seq < 0 || typeof message.done !== 'boolean' || !validType(message.transferType)) {
      removeInbound(transferId);
      acknowledge(message, false, 'invalid binary chunk metadata');
      return;
    }
    let state = inboundTransfers.get(transferId);
    if (!state) {
      if (message.seq !== 0) { acknowledge(message, false, 'binary chunk order mismatch'); return; }
      if (inboundTransfers.size >= MAX_BINARY_TRANSFERS) { acknowledge(message, false, 'too many binary transfers'); return; }
      let release;
      try { release = reserveBinary(0, 1); }
      catch (error) { acknowledge(message, false, error); return; }
      state = { next: 0, transferType: message.transferType, chunks: [], total: 0, releases: [release], timer: null };
      inboundTransfers.set(transferId, state);
    }
    if (message.seq !== state.next || state.transferType !== message.transferType) {
      removeInbound(transferId);
      acknowledge(message, false, 'binary chunk order mismatch');
      return;
    }
    let bytes;
    try { bytes = decodeBase64(message.data); }
    catch { removeInbound(transferId); acknowledge(message, false, 'invalid binary chunk'); return; }
    if (bytes.length > CHUNK_BYTES || (!message.done && !bytes.length) || state.total + bytes.length > MAX_BINARY_TRANSFER_BYTES || (state.next >= Math.ceil(MAX_BINARY_TRANSFER_BYTES / CHUNK_BYTES) && !message.done)) {
      removeInbound(transferId); acknowledge(message, false, 'binary transfer capacity exceeded'); return;
    }
    try { state.releases.push(reserveBinary(bytes.length)); }
    catch (error) { removeInbound(transferId); acknowledge(message, false, error); return; }
    state.chunks.push(bytes); state.total += bytes.length; state.next++;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { removeInbound(transferId); acknowledge(message, false, 'binary transfer timed out'); }, BINARY_IDLE_MS);
    if (!message.done) { acknowledge(message, true); return; }
    let releaseJoined;
    try { releaseJoined = reserveBinary(state.total); }
    catch (error) { removeInbound(transferId); acknowledge(message, false, error); return; }
    try {
      const joined = new Uint8Array(state.total); let offset = 0;
      for (const part of state.chunks) { joined.set(part, offset); offset += part.length; }
      // Keep the transfer slot during async callbacks, but drop chunk buffers.
      clearTimeout(state.timer); state.chunks.length = 0;
      state.releases.splice(1).forEach(release => release());
      const payload = { type: state.transferType, bytes: joined };
      const jobs = [...binaryCallbacks].map(callback => {
        try { return Promise.resolve(callback(payload)); }
        catch (error) { return Promise.reject(error); }
      });
      await deadline(Promise.all(jobs), BINARY_ACK_MS, 'binary handler ACK timed out');
      acknowledge(message, true);
    } catch (error) { acknowledge(message, false, error); }
    finally { releaseJoined(); removeInbound(transferId); }
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
      let bytes; let release;
      try {
        if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) throw new TypeError('sendBinary requires Uint8Array or ArrayBuffer');
        if (value.byteLength > MAX_BINARY_TRANSFER_BYTES) throw new Error('View binary transfer exceeds capacity');
        release = reserveBinary(value.byteLength, 1);
        bytes = normalizeBytes(value);
      } catch (error) { if (release) release(); return Promise.reject(error); }
      const transferId = newId();
      const total = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
      const sendChunk = (seq) => new Promise((resolve, reject) => {
        const key = `${transferId}:${seq}`;
        const timer = setTimeout(() => {
          pendingBinaryAcks.delete(key);
          reject(new Error('View binary ACK timed out'));
        }, BINARY_ACK_MS);
        pendingBinaryAcks.set(key, { resolve, reject, timer, done: seq === total - 1 });
        try {
          const start = seq * CHUNK_BYTES;
          const end = Math.min(bytes.length, start + CHUNK_BYTES);
          post({
            type: 'binary-chunk', documentId, transferId, transferType: type,
            seq, done: seq === total - 1, data: encodeBase64(bytes.subarray(start, end)),
          });
        } catch (error) {
          clearTimeout(timer); pendingBinaryAcks.delete(key);
          reject(error);
        }
      });
      return (async () => {
        try { for (let seq = 0; seq < total; seq++) await sendChunk(seq); }
        finally { release(); bytes = null; }
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
    if (message.type === 'binary-chunk') {
      if (++pendingBinaryMessages > 16) { pendingBinaryMessages--; report(new Error('Host binary queue overflow')); return; }
      binarySequence = binarySequence.then(() => apply(message)).catch(report).finally(() => { pendingBinaryMessages--; });
      return;
    }
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
