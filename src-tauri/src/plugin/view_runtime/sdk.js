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
  // Timeline controls never enter the state Promise chain or the Worker lane.
  let timeline = null;
  let timelineInFlight = null;
  let timelineLatest = null;
  const timelinePost = (registration, action, fields = {}) => {
    if (!documentId) return;
    post({ type: 'timeline', documentId, payload: { action, capabilityGeneration: registration.generation, ...fields } });
  };
  const validTimelineText = (value) => typeof value === 'string' && value.length <= 128 && !/[\uD800-\uDFFF]/u.test(value) && new TextEncoder().encode(value).length <= 128;
  const validAnchor = (anchor) => anchor && Number.isFinite(anchor.timeMs)
    && (anchor.recordKey === undefined || validTimelineText(anchor.recordKey));
  const resultStatuses = new Set(['exact', 'nearest', 'before-range', 'after-range', 'no-time', 'filtered', 'held', 'loading', 'unsupported']);
  const pumpTimeline = () => {
    if (timelineInFlight || !timelineLatest) return;
    const next = timelineLatest; timelineLatest = null;
    const registration = timeline;
    if (!registration || registration.disposed || next.capabilityGeneration !== registration.generation) return;
    const controller = new AbortController();
    const flight = { request: next, controller }; timelineInFlight = flight;
    Promise.resolve().then(() => {
      if (controller.signal.aborted || registration.disposed) return { status: 'held' };
      return registration.onSeek({ ...next, signal: controller.signal });
    }).then(result => {
      if (registration.disposed || timeline !== registration) return;
      if (controller.signal.aborted) { timelinePost(registration, 'ack', { requestId: next.requestId, result: { status: 'held' } }); return; }
      if (!result || !resultStatuses.has(result.status)
        || (['exact', 'nearest', 'before-range', 'after-range'].includes(result.status) && !Number.isFinite(result.actualTimeMs))
        || (result.actualTimeMs !== undefined && !Number.isFinite(result.actualTimeMs))
        || (result.recordKey !== undefined && !validTimelineText(result.recordKey))) throw new TypeError('Invalid timeline seek result');
      timelinePost(registration, 'ack', { requestId: next.requestId, result: { status: result.status, ...(result.actualTimeMs === undefined ? {} : { actualTimeMs: result.actualTimeMs }), ...(result.recordKey === undefined ? {} : { recordKey: result.recordKey }) } });
    }).catch(error => {
      if (!registration.disposed && timeline === registration) timelinePost(registration, 'ack', { requestId: next.requestId, result: { status: controller.signal.aborted ? 'held' : 'unsupported' }, error: String(error).slice(0, 512).replace(/[\uD800-\uDFFF]/gu, '\uFFFD') });
    }).finally(() => {
      if (timelineInFlight === flight) timelineInFlight = null;
      pumpTimeline();
    });
  };
  const dispatchTimeline = (message) => {
    const registration = timeline;
    if (!registration || registration.disposed) return;
    if (message.type === 'timeline-cancel') {
      if (message.capabilityGeneration !== registration.generation) return;
      if (timelineInFlight?.request.requestId === message.requestId) timelineInFlight.controller.abort();
      if (timelineLatest?.requestId === message.requestId) {
        const cancelled = timelineLatest; timelineLatest = null;
        // Host may already own this physical slot while an old capability's
        // callback is still running. A not-yet-started cancellation is settled
        // immediately; no callback remains to produce its ACK later.
        timelinePost(registration, 'ack', { requestId: cancelled.requestId, result: { status: 'held' } });
      }
      return;
    }
    const request = message.timeline;
    if (!request || request.capabilityGeneration !== registration.generation || !validType(request.requestId)
      || !Number.isFinite(request.timeMs) || !['preview', 'commit'].includes(request.phase)) return;
    // One active callback plus one latest candidate; commit cannot be displaced
    // by a preview from that same/older navigation. Cancellation is cooperative.
    if (timelineLatest?.phase === 'commit' && request.phase === 'preview'
      && request.navigationEpoch <= timelineLatest.navigationEpoch) return;
    timelineLatest = request;
    if (timelineInFlight) timelineInFlight.controller.abort();
    pumpTimeline();
  };
  const registerTimeline = (options) => {
    if (!options || options.version !== 1 || typeof options.onSeek !== 'function'
      || !['bound-input', 'custom'].includes(options.clock?.kind)
      || (options.clock.kind === 'custom' && (!validType(options.clock.id) || !validTimelineText(options.clock.id)))
      || !['bounded', 'commit-only'].includes(options.capabilities?.preview)
      || typeof options.capabilities.canDrive !== 'boolean') throw new TypeError('Invalid timeline registration');
    if (options.clock.kind === 'bound-input' && (!context.boundPortId || !hasWorker)) throw new Error('bound-input requires a bound input session');
    if (timeline) timeline.dispose(); // Re-register creates a new capability generation.
    const registration = { generation: newId(), onSeek: options.onSeek, disposed: false, navigation: null,
      description: { version: 1, clock: { kind: options.clock.kind, ...(options.clock.kind === 'custom' ? { id: options.clock.id } : {}) }, capabilities: { preview: options.capabilities.preview, canDrive: options.capabilities.canDrive } } };
    const announce = () => {
      timelinePost(registration, 'register', { registration: registration.description });
      if (registration.availability) timelinePost(registration, 'availability', { availability: registration.availability });
    };
    const dispose = () => {
      if (registration.disposed) return;
      registration.navigation?.cancel(); registration.disposed = true;
      if (timelineInFlight?.request.capabilityGeneration === registration.generation) timelineInFlight.controller.abort();
      timelineLatest = null; timelinePost(registration, 'dispose');
      if (timeline === registration) timeline = null;
    };
    registration.dispose = dispose; registration.announce = announce;
    timeline = registration; announce();
    return Object.freeze({
      dispose,
      setAvailability(value) {
        if (registration.disposed) return;
        if (!value || typeof value.available !== 'boolean' || (value.range && (!Number.isFinite(value.range.startMs) || !Number.isFinite(value.range.endMs) || value.range.startMs > value.range.endMs))) throw new TypeError('Invalid timeline availability');
        const next = { available: value.available, ...(value.range ? { range: { startMs: value.range.startMs, endMs: value.range.endMs } } : {}) };
        if (JSON.stringify(next) === JSON.stringify(registration.availability)) return;
        registration.availability = next;
        timelinePost(registration, 'availability', { availability: next });
      },
      updateCapabilities(value) {
        if (registration.disposed) return;
        if (!value || !['bounded', 'commit-only'].includes(value.preview) || typeof value.canDrive !== 'boolean') throw new TypeError('Invalid timeline capabilities');
        if (registration.description.capabilities.preview === value.preview && registration.description.capabilities.canDrive === value.canDrive) return;
        registration.description.capabilities = { preview: value.preview, canDrive: value.canDrive };
        timelinePost(registration, 'capabilities', { capabilities: registration.description.capabilities });
      },
      beginNavigation(intent) {
        if (registration.disposed || !registration.description.capabilities.canDrive) throw new Error('Timeline cannot drive');
        if (!['scrollbar', 'wheel', 'keyboard', 'search', 'jump', 'align', 'scrub'].includes(intent)) throw new TypeError('Invalid timeline navigation intent');
        registration.navigation?.cancel();
        const gestureId = newId(); let latest = null; let timer = null; let ended = false;
        timelinePost(registration, 'begin', { gestureId, intent });
        const flush = () => { timer = null; if (!ended && latest) timelinePost(registration, 'update', { gestureId, anchor: latest }); };
        const navigation = Object.freeze({
          update(anchor) {
            if (ended || registration.disposed) return;
            if (!validAnchor(anchor)) throw new TypeError('Invalid timeline anchor');
            latest = { timeMs: anchor.timeMs, ...(anchor.recordKey === undefined ? {} : { recordKey: anchor.recordKey }) };
            if (timer === null) timer = setTimeout(flush, 100);
          },
          end(anchor) {
            if (ended || registration.disposed) return;
            if (anchor !== undefined) { if (!validAnchor(anchor)) throw new TypeError('Invalid timeline anchor'); latest = { timeMs: anchor.timeMs, ...(anchor.recordKey === undefined ? {} : { recordKey: anchor.recordKey }) }; }
            ended = true; clearTimeout(timer); timer = null;
            // Final anchor travels in the reserved end control, not a throttled update.
            timelinePost(registration, 'end', { gestureId, ...(latest ? { anchor: latest } : {}) });
            if (registration.navigation === navigation) registration.navigation = null;
          },
          cancel() {
            if (ended) return; ended = true; clearTimeout(timer); timer = null;
            timelinePost(registration, 'cancel', { gestureId });
            if (registration.navigation === navigation) registration.navigation = null;
          },
        });
        registration.navigation = navigation; return navigation;
      },
    });
  };
  const sdk = Object.freeze({
    timeline: Object.freeze({ register: registerTimeline }),
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
  addEventListener('pagehide', () => timeline?.dispose(), { once: true });
  const startDocument = (id) => {
    if (typeof id !== 'string' || !id) throw new Error('Invalid document identity');
    if (documentId !== null) {
      if (documentId === id) return;
      throw new Error('View document already started');
    }
    documentId = id;
    post({ type: 'ready', documentId });
    timeline?.announce();
  };
  Object.defineProperty(globalThis, '__hypercomViewDocumentStart', { configurable: false, writable: false, value: startDocument });
  Object.defineProperty(globalThis, '__hypercomViewDispatch', { configurable: false, writable: false, value(message) {
    if (!message) return;
    // Native rejects stale documents too; this keeps the page-side dispatcher
    // from ever applying a message addressed to another document generation.
    if (!documentId || message.documentId !== documentId) return;
    if (message.type === 'timeline-seek' || message.type === 'timeline-cancel') { dispatchTimeline(message); return; }
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
