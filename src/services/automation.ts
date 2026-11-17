/**
 * Unified local/remote domain adapter. No invoke, fetch, credentials or connection
 * side effects live here. Until a native transport is injected, every I/O rejects.
 * Unlike legacy services/tauri.ts, this new API deliberately separates wire and
 * domain types. Field names are mapped explicitly, never recursively recased.
 */
import { createDecoder } from '../utils/lineText';
import { AUTOMATION_ERROR_CODES } from '../types/automation';
import type {
  AutomationClient, AutomationErrorCode, AutomationEvent, AutomationMethod,
  AutomationOperation, AutomationRequest, AutomationSnapshot, AutomationSubscription,
  AutomationTarget, AutomationTransport, ControlLease, Handshake, HostRequest,
  PortRef, PortRequest, PortSnapshot, SerialParameters, SideEffects,
  StructuredAutomationError, SubscribeRequest, WireAutomationRequest, WireCase,
} from '../types/automation';

export const AUTOMATION_PROTOCOL_VERSION = 1;

export class AutomationServiceError extends Error implements StructuredAutomationError {
  readonly code: AutomationErrorCode;
  readonly stage: string;
  readonly operationId?: string;
  readonly sideEffects?: SideEffects;
  readonly retryable?: boolean;
  readonly wireCode?: string;
  constructor(error: StructuredAutomationError, wireCode?: string) {
    super(error.message);
    this.name = 'AutomationServiceError';
    this.code = error.code;
    this.stage = error.stage;
    this.operationId = error.operationId;
    this.sideEffects = error.sideEffects;
    this.retryable = error.retryable;
    this.wireCode = wireCode;
  }
}

function invalid(message: string): never {
  throw new AutomationServiceError({ code: 'INVALID_ARGUMENT', stage: 'decode', message });
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Expected an automation object');
  return value as Record<string, unknown>;
}
/** An explicitly selected dialect rejects the other spelling, including mixed aliases. */
function field(value: Record<string, unknown>, camel: string, snake: string, casing: WireCase): unknown {
  const key = casing === 'camel' ? camel : snake;
  const other = casing === 'camel' ? snake : camel;
  if (key !== other && Object.prototype.hasOwnProperty.call(value, other)) return invalid(`Unexpected wire field ${other}`);
  return value[key];
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) return invalid(`Invalid ${label}`);
  return value;
}
function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined || value === null ? undefined : text(value, label);
}
function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid(`Invalid ${label}`);
  return value;
}
/** Safe numeric legacy wire values are accepted; unsafe numbers are never rounded. */
function counter(value: unknown, label: string): string {
  if (typeof value === 'number') return String(integer(value, label));
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 18446744073709551615n) return invalid(`Invalid ${label}`);
  return value;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') return invalid(`Invalid ${label}`);
  return value;
}
function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return invalid(`Invalid ${label}`);
  return value as T;
}
function portRef(value: unknown, casing: WireCase): PortRef {
  const item = object(value);
  return {
    hostId: text(field(item, 'hostId', 'host_id', casing), 'hostId'),
    nativePortId: text(field(item, 'nativePortId', 'native_port_id', casing), 'nativePortId'),
  };
}
function sideEffects(value: unknown, casing: WireCase): SideEffects {
  const item = object(value);
  const bytes = field(item, 'bytesWritten', 'bytes_written', casing);
  return {
    certainty: oneOf(item.certainty, ['known', 'unknown', 'partial'], 'outcome certainty'),
    ...(bytes === undefined || bytes === null ? {} : { bytesWritten: counter(bytes, 'bytesWritten') }),
  };
}

/** Never infer a machine code from human-readable legacy CommandError strings. */
export function mapAutomationError(value: unknown, casing: WireCase = 'camel', fallback: AutomationErrorCode = 'HOST_UNAVAILABLE'): AutomationServiceError {
  if (value instanceof AutomationServiceError) return value;
  if (value && typeof value === 'object' && !Array.isArray(value) && 'code' in value) {
    const item = object(value);
    const wireCode = text(item.code, 'error code');
    const code = AUTOMATION_ERROR_CODES.includes(wireCode as AutomationErrorCode) ? wireCode as AutomationErrorCode : 'OUTCOME_UNKNOWN';
    const effects = field(item, 'sideEffects', 'side_effects', casing);
    return new AutomationServiceError({
      code,
      stage: item.stage === undefined ? 'transport' : text(item.stage, 'error stage'),
      message: text(item.message, 'error message'),
      operationId: optionalText(field(item, 'operationId', 'operation_id', casing), 'operationId'),
      sideEffects: effects === undefined ? undefined : sideEffects(effects, casing),
      retryable: item.retryable === undefined ? undefined : boolean(item.retryable, 'retryable'),
    }, wireCode);
  }
  return new AutomationServiceError({
    code: fallback, stage: 'transport',
    message: value instanceof Error ? value.message : typeof value === 'string' ? value : 'Automation transport failed',
    sideEffects: { certainty: 'unknown' },
    retryable: false,
  });
}

export function decodeAutomationHandshake(value: unknown, casing: WireCase = 'camel'): Handshake {
  const item = object(value);
  const protocolVersion = integer(field(item, 'protocolVersion', 'protocol_version', casing), 'protocolVersion');
  if (protocolVersion !== AUTOMATION_PROTOCOL_VERSION) {
    throw new AutomationServiceError({ code: 'UNSUPPORTED_CAPABILITY', stage: 'handshake', message: `Unsupported automation protocol ${protocolVersion}` });
  }
  if (!Array.isArray(item.capabilities)) return invalid('Invalid capabilities');
  return {
    protocolVersion,
    hostId: text(field(item, 'hostId', 'host_id', casing), 'hostId'),
    serverEpoch: text(field(item, 'serverEpoch', 'server_epoch', casing), 'serverEpoch'),
    capabilities: item.capabilities.map(value => text(value, 'capability')),
    clientSessionId: optionalText(field(item, 'clientSessionId', 'client_session_id', casing), 'clientSessionId'),
  };
}

export function decodeAutomationLease(value: unknown, casing: WireCase = 'camel'): ControlLease {
  const item = object(value);
  return {
    target: portRef(item.target, casing),
    serverEpoch: text(field(item, 'serverEpoch', 'server_epoch', casing), 'serverEpoch'),
    connectionGeneration: counter(field(item, 'connectionGeneration', 'connection_generation', casing), 'connectionGeneration'),
    leaseId: text(field(item, 'leaseId', 'lease_id', casing), 'leaseId'),
    fence: counter(item.fence, 'fence'),
    state: oneOf(item.state, ['requested', 'granted', 'revoking', 'draining', 'released', 'expired'], 'lease state'),
    expiresAtMs: integer(field(item, 'expiresAtMs', 'expires_at_ms', casing), 'expiresAtMs'),
    clientSessionId: optionalText(field(item, 'clientSessionId', 'client_session_id', casing), 'clientSessionId'),
  };
}
function serialParameters(value: unknown, casing: WireCase): SerialParameters {
  const item = object(value);
  return {
    baudRate: integer(field(item, 'baudRate', 'baud_rate', casing), 'baudRate'),
    dataBits: integer(field(item, 'dataBits', 'data_bits', casing), 'dataBits'),
    parity: text(item.parity, 'parity'),
    stopBits: text(field(item, 'stopBits', 'stop_bits', casing), 'stopBits'),
    handshake: text(item.handshake, 'handshake'),
    dtr: boolean(item.dtr, 'dtr'), rts: boolean(item.rts, 'rts'),
  };
}
export function decodeAutomationPort(value: unknown, casing: WireCase = 'camel'): PortSnapshot {
  const item = object(value);
  const result: PortSnapshot = {
    target: portRef(item.target, casing),
    serverEpoch: text(field(item, 'serverEpoch', 'server_epoch', casing), 'serverEpoch'),
    connectionGeneration: counter(field(item, 'connectionGeneration', 'connection_generation', casing), 'connectionGeneration'),
    state: oneOf(item.state, ['closed', 'opening', 'open', 'closing', 'error'], 'port state'),
  };
  if (item.name !== undefined) result.name = text(item.name, 'port name');
  if (item.params !== undefined && item.params !== null) result.params = serialParameters(item.params, casing);
  if (item.control !== undefined) result.control = item.control === null ? null : decodeAutomationLease(item.control, casing);
  if (result.control) {
    assertIdentity(result.control.target.hostId, result.control.serverEpoch, result.target.hostId, result.serverEpoch);
    assertPort(result.control.target, result.target);
    if (result.control.connectionGeneration !== result.connectionGeneration) return invalid('Snapshot control generation does not match its port');
  }
  return result;
}
export function decodeAutomationSnapshot(value: unknown, casing: WireCase = 'camel'): AutomationSnapshot {
  const item = object(value);
  if (!Array.isArray(item.ports)) return invalid('Invalid snapshot ports');
  const snapshot = {
    hostId: text(field(item, 'hostId', 'host_id', casing), 'hostId'),
    serverEpoch: text(field(item, 'serverEpoch', 'server_epoch', casing), 'serverEpoch'),
    cursor: text(item.cursor, 'cursor'),
    ports: item.ports.map(port => decodeAutomationPort(port, casing)),
  };
  for (const port of snapshot.ports) assertIdentity(port.target.hostId, port.serverEpoch, snapshot.hostId, snapshot.serverEpoch);
  return snapshot;
}
export function decodeAutomationOperation(value: unknown, casing: WireCase = 'camel'): AutomationOperation {
  const item = object(value);
  return {
    operationId: text(field(item, 'operationId', 'operation_id', casing), 'operationId'),
    requestId: text(field(item, 'requestId', 'request_id', casing), 'requestId'),
    target: portRef(item.target, casing),
    serverEpoch: text(field(item, 'serverEpoch', 'server_epoch', casing), 'serverEpoch'),
    connectionGeneration: counter(field(item, 'connectionGeneration', 'connection_generation', casing), 'connectionGeneration'),
    state: oneOf(item.state, ['accepted', 'queued', 'executing', 'succeeded', 'failed', 'cancelled'], 'operation state'),
    outcome: sideEffects(item.outcome, casing),
    ...(item.error === undefined || item.error === null ? {} : { error: mapAutomationError(item.error, casing) }),
  };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return invalid('Invalid event base64');
  const binary = atob(value);
  if (btoa(binary) !== value) return invalid('Noncanonical event base64');
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
export function decodeAutomationEvent(value: unknown, casing: WireCase = 'camel'): AutomationEvent {
  const item = object(value);
  const data = field(item, 'dataBase64', 'data_base64', casing);
  const event: AutomationEvent = {
    hostId: text(field(item, 'hostId', 'host_id', casing), 'hostId'),
    serverEpoch: text(field(item, 'serverEpoch', 'server_epoch', casing), 'serverEpoch'),
    nativePortId: text(field(item, 'nativePortId', 'native_port_id', casing), 'nativePortId'),
    connectionGeneration: counter(field(item, 'connectionGeneration', 'connection_generation', casing), 'connectionGeneration'),
    seq: counter(item.seq, 'event sequence'), cursor: text(item.cursor, 'cursor'),
    type: text(item.type, 'event type'), timestampMs: integer(field(item, 'timestampMs', 'timestamp_ms', casing), 'timestampMs'),
    replay: item.replay === undefined ? false : boolean(item.replay, 'replay'),
    operationId: optionalText(field(item, 'operationId', 'operation_id', casing), 'operationId'),
    jobId: optionalText(field(item, 'jobId', 'job_id', casing), 'jobId'),
  };
  if (data !== undefined) event.data = decodeBase64(data);
  if (item.origin !== undefined && item.origin !== null) {
    const origin = object(item.origin);
    event.origin = {
      source: text(origin.source, 'origin source'),
      clientSessionId: optionalText(field(origin, 'clientSessionId', 'client_session_id', casing), 'clientSessionId'),
      principalId: optionalText(field(origin, 'principalId', 'principal_id', casing), 'principalId'),
    };
  }
  if (item.gap !== undefined && item.gap !== null) {
    const gap = object(item.gap);
    event.gap = {
      reason: text(gap.reason, 'gap reason'),
      fromCursor: optionalText(field(gap, 'fromCursor', 'from_cursor', casing), 'fromCursor'),
      toCursor: optionalText(field(gap, 'toCursor', 'to_cursor', casing), 'toCursor'),
    };
  }
  return event;
}

/** UTF-8, CRLF and JSON tokens may straddle chunks. A bad/truncated stream is terminal. */
export function createAutomationNdjsonDecoder(casing: WireCase = 'camel', maxLineChars = 1024 * 1024) {
  if (!Number.isSafeInteger(maxLineChars) || maxLineChars < 1) return invalid('Invalid NDJSON line limit');
  const decoder = createDecoder('utf-8', { fatal: true });
  let pending = '';
  let ended = false;
  const consume = (input: string, final: boolean): AutomationEvent[] => {
    const lines = (pending + input).split('\n');
    pending = final ? '' : lines.pop()!;
    if (pending.length > maxLineChars || lines.some(line => line.length > maxLineChars)) return invalid('NDJSON event exceeds line limit');
    return lines.filter(line => line.trim()).map(line => decodeAutomationEvent(JSON.parse(line) as unknown, casing));
  };
  const decode = (chunk: Uint8Array | undefined, final: boolean): AutomationEvent[] => {
    if (ended) return invalid('NDJSON decoder has ended');
    try {
      const events = consume(decoder.decode(chunk, { stream: !final }), final);
      if (final) ended = true;
      return events;
    } catch (error) {
      ended = true;
      pending = '';
      if (error instanceof AutomationServiceError) throw error;
      return invalid('Malformed automation NDJSON/UTF-8');
    }
  };
  return { push: (chunk: Uint8Array) => decode(chunk, false), finish: () => decode(undefined, true) };
}

/** Only envelope fields are converted here; each method constructs its own params. */
export function encodeAutomationRequest(request: AutomationRequest, casing: WireCase = 'camel'): WireAutomationRequest {
  text(request.requestId, 'requestId');
  if (request.protocolVersion !== AUTOMATION_PROTOCOL_VERSION) return invalid('Invalid request protocolVersion');
  if (request.timeoutMs !== undefined) integer(request.timeoutMs, 'timeoutMs');
  if (request.target) {
    text(request.target.hostId, 'hostId');
    if ('nativePortId' in request.target) text(request.target.nativePortId, 'nativePortId');
  }
  if (request.precondition) {
    text(request.precondition.serverEpoch, 'serverEpoch');
    if (request.precondition.connectionGeneration !== undefined) counter(request.precondition.connectionGeneration, 'connectionGeneration');
  }
  if (request.control) { text(request.control.leaseId, 'leaseId'); counter(request.control.fence, 'fence'); }
  if (casing === 'camel') return {
    protocolVersion: request.protocolVersion, requestId: request.requestId, method: request.method,
    ...(request.target ? { target: {
      hostId: request.target.hostId,
      ...('nativePortId' in request.target ? { nativePortId: request.target.nativePortId } : {}),
    } } : {}),
    ...(request.precondition ? { precondition: {
      serverEpoch: request.precondition.serverEpoch,
      ...(request.precondition.connectionGeneration === undefined ? {} : { connectionGeneration: counter(request.precondition.connectionGeneration, 'connectionGeneration') }),
    } } : {}),
    ...(request.control ? { control: { leaseId: request.control.leaseId, fence: counter(request.control.fence, 'fence') } } : {}),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    params: { ...request.params },
  };
  return {
    protocol_version: request.protocolVersion, request_id: request.requestId, method: request.method,
    ...(request.target ? { target: {
      host_id: request.target.hostId,
      ...('nativePortId' in request.target ? { native_port_id: request.target.nativePortId } : {}),
    } } : {}),
    ...(request.precondition ? { precondition: {
      server_epoch: request.precondition.serverEpoch,
      ...(request.precondition.connectionGeneration === undefined ? {} : { connection_generation: counter(request.precondition.connectionGeneration, 'connectionGeneration') }),
    } } : {}),
    ...(request.control ? { control: { lease_id: request.control.leaseId, fence: counter(request.control.fence, 'fence') } } : {}),
    ...(request.timeoutMs === undefined ? {} : { timeout_ms: request.timeoutMs }),
    params: { ...request.params },
  };
}

function assertIdentity(hostId: string, epoch: string | undefined, expectedHost?: string, expectedEpoch?: string): void {
  if ((expectedHost !== undefined && hostId !== expectedHost) || (expectedEpoch !== undefined && epoch !== expectedEpoch)) {
    throw new AutomationServiceError({ code: 'STALE_SESSION', stage: 'identity', message: 'Automation Host or server epoch does not match the selected target' });
  }
}
function assertPort(actual: PortRef, expected: PortRef): void {
  assertIdentity(actual.hostId, undefined, expected.hostId);
  if (actual.nativePortId !== expected.nativePortId) return invalid('Unexpected response port');
}

export function selectAutomationTarget(target: AutomationTarget): AutomationTarget {
  if (target.kind === 'local') {
    if (target.hostId !== undefined) text(target.hostId, 'hostId');
    return Object.freeze({ kind: 'local', ...(target.hostId ? { hostId: target.hostId } : {}) });
  }
  if (target.kind !== 'remote') return invalid('Invalid automation target');
  return Object.freeze({ kind: 'remote', hostId: text(target.hostId, 'hostId'), connectionId: text(target.connectionId, 'connectionId') });
}

export function createAutomationService(transport?: AutomationTransport, casing: WireCase = 'camel') {
  return {
    selectTarget(selection: AutomationTarget = { kind: 'local' }): AutomationClient {
      const target = selectAutomationTarget(selection);
      const available = (): AutomationTransport => {
        if (!transport) throw new AutomationServiceError({
          code: 'HOST_UNAVAILABLE', stage: 'transport', message: 'Automation backend is not connected',
          sideEffects: { certainty: 'known', bytesWritten: '0' }, retryable: false,
        });
        return transport;
      };
      const envelope = (method: AutomationMethod, requestId: string, rest: Omit<AutomationRequest, 'protocolVersion' | 'requestId' | 'method'>): WireAutomationRequest => {
        if (rest.target) assertIdentity(rest.target.hostId, undefined, target.hostId);
        return encodeAutomationRequest({ protocolVersion: AUTOMATION_PROTOCOL_VERSION, requestId, method, ...rest }, casing);
      };
      const call = async <T>(method: AutomationMethod, requestId: string, rest: Omit<AutomationRequest, 'protocolVersion' | 'requestId' | 'method'>, decode: (value: unknown) => T): Promise<T> => {
        try { return decode(await available().request(target, envelope(method, requestId, rest))); }
        catch (error) { throw mapAutomationError(error, casing, method === 'serial.send' ? 'OUTCOME_UNKNOWN' : 'HOST_UNAVAILABLE'); }
      };
      const hostEnvelope = (request: HostRequest) => ({ target: { hostId: request.hostId }, precondition: { serverEpoch: request.serverEpoch } });
      const portEnvelope = (request: PortRequest) => ({ target: request.target, precondition: request.precondition, timeoutMs: request.timeoutMs });
      const checkLease = (value: unknown, request: PortRequest): ControlLease => {
        const lease = decodeAutomationLease(value, casing);
        assertIdentity(lease.target.hostId, lease.serverEpoch, request.target.hostId, request.precondition.serverEpoch);
        assertPort(lease.target, request.target);
        if (lease.connectionGeneration !== request.precondition.connectionGeneration) throw new AutomationServiceError({ code: 'STALE_SESSION', stage: 'identity', message: 'Lease connection generation changed' });
        return lease;
      };
      const subscribe = async (method: 'events.subscribe' | 'ports.watch', request: SubscribeRequest): Promise<AutomationSubscription> => {
        const wire = envelope(method, request.requestId, {
          ...hostEnvelope(request),
          target: request.nativePortId === undefined ? { hostId: request.hostId } : { hostId: request.hostId, nativePortId: request.nativePortId },
          params: request.cursor === undefined ? {} : { cursor: text(request.cursor, 'cursor') },
        });
        try {
          const subscription = await available().subscribe(target, wire);
          let snapshot: AutomationSnapshot;
          try {
            snapshot = decodeAutomationSnapshot(subscription.snapshot, casing);
            assertIdentity(snapshot.hostId, snapshot.serverEpoch, request.hostId, request.serverEpoch);
          } catch (error) {
            await subscription.unsubscribe().catch(() => undefined);
            throw error;
          }
          let closed = false;
          let closing: Promise<void> | undefined;
          const unsubscribe = (): Promise<void> => {
            if (closed) return Promise.resolve();
            if (!closing) closing = Promise.resolve()
              .then(() => subscription.unsubscribe())
              .then(() => { closed = true; })
              .catch(error => { throw mapAutomationError(error, casing); })
              .finally(() => { closing = undefined; });
            return closing;
          };
          const events = async function* (): AsyncIterable<AutomationEvent> {
            let streamFailed = false;
            try {
              for await (const value of subscription.events) {
                if (closed) break;
                const event = decodeAutomationEvent(value, casing);
                assertIdentity(event.hostId, event.serverEpoch, snapshot.hostId, snapshot.serverEpoch);
                if (request.nativePortId !== undefined && event.nativePortId !== request.nativePortId) return invalid('Event does not match subscribed port');
                yield event;
              }
            } catch (error) {
              streamFailed = true;
              throw mapAutomationError(error, casing);
            } finally {
              try { await unsubscribe(); }
              catch (error) { if (!streamFailed) throw error; }
            }
          };
          return { snapshot, events: events(), unsubscribe };
        } catch (error) { throw mapAutomationError(error, casing); }
      };
      return {
        target,
        handshake: requestId => call('handshake', requestId, { params: {} }, value => {
          const handshake = decodeAutomationHandshake(value, casing);
          assertIdentity(handshake.hostId, handshake.serverEpoch, target.hostId);
          return handshake;
        }),
        status: request => call('host.status', request.requestId, { ...hostEnvelope(request), params: {} }, value => {
          const snapshot = decodeAutomationSnapshot(value, casing);
          assertIdentity(snapshot.hostId, snapshot.serverEpoch, request.hostId, request.serverEpoch);
          return snapshot;
        }),
        listPorts: request => call('ports.list', request.requestId, { ...hostEnvelope(request), params: {} }, value => {
          if (!Array.isArray(value)) return invalid('Invalid port list');
          return value.map(value => {
            const port = decodeAutomationPort(value, casing);
            assertIdentity(port.target.hostId, port.serverEpoch, request.hostId, request.serverEpoch);
            return port;
          });
        }),
        subscribe: request => subscribe('events.subscribe', request),
        watch: request => subscribe('ports.watch', request),
        acquireControl: async request => call('control.acquire', request.requestId, {
          ...portEnvelope(request), params: casing === 'camel'
            ? { ttlMs: integer(request.ttlMs, 'ttlMs'), ...(request.waitMs === undefined ? {} : { waitMs: integer(request.waitMs, 'waitMs') }) }
            : { ttl_ms: integer(request.ttlMs, 'ttlMs'), ...(request.waitMs === undefined ? {} : { wait_ms: integer(request.waitMs, 'waitMs') }) },
        }, value => checkLease(value, request)),
        renewControl: async request => call('control.renew', request.requestId, {
          ...portEnvelope(request), control: request.control,
          params: casing === 'camel' ? { ttlMs: integer(request.ttlMs, 'ttlMs') } : { ttl_ms: integer(request.ttlMs, 'ttlMs') },
        }, value => checkLease(value, request)),
        releaseControl: request => call('control.release', request.requestId, {
          ...portEnvelope(request), control: request.control, params: {},
        }, value => { if (value !== undefined && value !== null) return invalid('Invalid release acknowledgement'); }),
        send: async request => {
          let params: Record<string, unknown>;
          if (request.input.mode === 'raw') {
            if (!(request.input.data instanceof Uint8Array)) return invalid('Raw send requires Uint8Array');
            params = casing === 'camel' ? { dataBase64: encodeBase64(request.input.data) } : { data_base64: encodeBase64(request.input.data) };
          } else if (request.input.mode === 'text') {
            params = { mode: 'text', text: request.input.text, encoding: request.input.encoding,
              ...(casing === 'camel' ? { lineEnding: request.input.lineEnding } : { line_ending: request.input.lineEnding }) };
          } else if (request.input.mode === 'hex') {
            params = { mode: 'hex', hex: request.input.hex,
              ...(casing === 'camel' ? { lineEnding: request.input.lineEnding } : { line_ending: request.input.lineEnding }) };
          } else return invalid('Invalid send input mode');
          return call('serial.send', request.requestId, { ...portEnvelope(request), control: request.control, params }, value => {
            const operation = decodeAutomationOperation(value, casing);
            assertIdentity(operation.target.hostId, operation.serverEpoch, request.target.hostId, request.precondition.serverEpoch);
            assertPort(operation.target, request.target);
            if (operation.requestId !== request.requestId || operation.connectionGeneration !== request.precondition.connectionGeneration) return invalid('Unexpected send operation identity');
            return operation;
          });
        },
        getOperation: request => call('operations.get', request.requestId, {
          ...hostEnvelope(request), params: request.operationId !== undefined
            ? casing === 'camel' ? { operationId: request.operationId } : { operation_id: request.operationId }
            : casing === 'camel' ? { requestId: request.originalRequestId } : { request_id: request.originalRequestId },
        }, value => {
          const operation = decodeAutomationOperation(value, casing);
          assertIdentity(operation.target.hostId, operation.serverEpoch, request.hostId, request.serverEpoch);
          if (request.operationId !== undefined ? operation.operationId !== request.operationId : operation.requestId !== request.originalRequestId) return invalid('Unexpected queried operation identity');
          return operation;
        }),
      };
    },
  };
}

/** Explicitly unconnected. Importing this module never invokes a backend command. */
export const automationService = createAutomationService();
