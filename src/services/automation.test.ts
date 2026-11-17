import { describe, expect, it, vi } from 'vitest';
import {
  AutomationServiceError, automationService, createAutomationNdjsonDecoder, createAutomationService,
  decodeAutomationEvent, decodeAutomationHandshake, decodeAutomationLease, decodeAutomationOperation,
  decodeAutomationPort, decodeAutomationSnapshot, encodeAutomationRequest, mapAutomationError,
} from './automation';
import { AUTOMATION_ERROR_CODES } from '../types/automation';
import type {
  AutomationRequest, AutomationTransport, SendRequest, WireAutomationEvent,
  WireAutomationEventSnake, WireAutomationSubscription,
} from '../types/automation';

const target = { hostId: 'lab-a', nativePortId: 'COM3' };
const precondition = { serverEpoch: 'boot-a', connectionGeneration: '7' };
const control = { leaseId: 'lease-a', fence: '9007199254740993' };
const hostRequest = { requestId: 'request-a', hostId: 'lab-a', serverEpoch: 'boot-a' };
const portRequest = { requestId: 'request-a', target, precondition };
const lease = {
  target, ...precondition, ...control, state: 'granted', expiresAtMs: 12345, clientSessionId: 'session-a',
};
const port = {
  target, ...precondition, state: 'open', name: 'USB serial', control: lease,
  params: { baudRate: 115200, dataBits: 8, parity: 'None', stopBits: 'One', handshake: 'None', dtr: true, rts: false },
};
const snapshot = { hostId: 'lab-a', serverEpoch: 'boot-a', cursor: 'opaque-cursor:20', ports: [port] };
const operation = {
  target, ...precondition, operationId: 'operation-a', requestId: 'request-a', state: 'succeeded',
  outcome: { certainty: 'known', bytesWritten: '3' },
};
const event: WireAutomationEvent = {
  hostId: 'lab-a', serverEpoch: 'boot-a', nativePortId: 'COM3', connectionGeneration: '7',
  seq: '9007199254740993', cursor: 'cursor:21', type: 'rx', timestampMs: 1700000000000,
  dataBase64: 'AP+A', origin: { source: '设备', clientSessionId: 'session-a', principalId: 'principal-a' },
  operationId: 'operation-a', jobId: 'job-a', replay: true,
  gap: { reason: 'retention', fromCursor: 'cursor:18', toCursor: 'cursor:20' },
};
const snakeEvent: WireAutomationEventSnake = {
  host_id: 'lab-a', server_epoch: 'boot-a', native_port_id: 'COM3', connection_generation: '7',
  seq: '9007199254740993', cursor: 'cursor:21', type: 'rx', timestamp_ms: 1700000000000,
  data_base64: 'AP+A', origin: { source: '设备', client_session_id: 'session-a', principal_id: 'principal-a' },
  operation_id: 'operation-a', job_id: 'job-a', replay: true,
  gap: { reason: 'retention', from_cursor: 'cursor:18', to_cursor: 'cursor:20' },
};
const snakeTarget = { host_id: 'lab-a', native_port_id: 'COM3' };
const snakeLease = {
  target: snakeTarget, server_epoch: 'boot-a', connection_generation: '7', lease_id: 'lease-a',
  fence: '9007199254740993', state: 'granted', expires_at_ms: 12345, client_session_id: 'session-a',
};
const snakePort = {
  target: snakeTarget, server_epoch: 'boot-a', connection_generation: '7', state: 'open', name: 'USB serial', control: snakeLease,
  params: { baud_rate: 115200, data_bits: 8, parity: 'None', stop_bits: 'One', handshake: 'None', dtr: true, rts: false },
};
function fakeTransport() {
  return {
    request: vi.fn<AutomationTransport['request']>(),
    subscribe: vi.fn<AutomationTransport['subscribe']>(),
  };
}
async function* events(...values: unknown[]) { yield* values; }
function wireSubscription(values: unknown[] = [event]): WireAutomationSubscription {
  return { snapshot, events: events(...values), unsubscribe: vi.fn(async () => undefined) };
}
function sendRequest(): SendRequest {
  return { ...portRequest, control, timeoutMs: 3000, input: { mode: 'raw', data: new Uint8Array([0, 255, 128]) } };
}

describe('automation explicit wire/domain mapping', () => {
  it('maps snake and camel events identically without converting opaque payload text', () => {
    expect(decodeAutomationEvent(snakeEvent, 'snake')).toEqual(decodeAutomationEvent(event));
    expect(decodeAutomationEvent(event)).toMatchObject({ data: new Uint8Array([0, 255, 128]), replay: true, seq: '9007199254740993' });
    expect(decodeAutomationEvent(event)).not.toHaveProperty('dataBase64');
    expect(decodeAutomationEvent(event).cursor).toBe('cursor:21');
  });

  it('maps nested port, serial params, control lease and snapshot explicitly', () => {
    expect(decodeAutomationPort(snakePort, 'snake')).toEqual(decodeAutomationPort(port));
    expect(decodeAutomationLease(snakeLease, 'snake')).toEqual(decodeAutomationLease(lease));
    expect(decodeAutomationSnapshot({ host_id: 'lab-a', server_epoch: 'boot-a', cursor: snapshot.cursor, ports: [snakePort] }, 'snake'))
      .toEqual(decodeAutomationSnapshot(snapshot));
  });

  it('maps operation partial side effects and structured nested errors', () => {
    const decoded = decodeAutomationOperation({
      target: snakeTarget, server_epoch: 'boot-a', connection_generation: '7', operation_id: 'operation-a', request_id: 'request-a', state: 'failed',
      outcome: { certainty: 'partial', bytes_written: '2' },
      error: { code: 'IO_ERROR', stage: 'write', message: 'partial write', operation_id: 'operation-a', side_effects: { certainty: 'partial', bytes_written: '2' }, retryable: false },
    }, 'snake');
    expect(decoded.outcome).toEqual({ certainty: 'partial', bytesWritten: '2' });
    expect(decoded.error).toMatchObject({ code: 'IO_ERROR', operationId: 'operation-a', sideEffects: { certainty: 'partial', bytesWritten: '2' } });
  });

  it('maps compatible handshake and rejects an incompatible protocol major', () => {
    expect(decodeAutomationHandshake({ protocol_version: 1, host_id: 'h', server_epoch: 'e', capabilities: ['ports.list'], client_session_id: 's' }, 'snake'))
      .toEqual({ protocolVersion: 1, hostId: 'h', serverEpoch: 'e', capabilities: ['ports.list'], clientSessionId: 's' });
    expect(() => decodeAutomationHandshake({ protocolVersion: 2 })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
  });

  it.each([
    { ...event, server_epoch: 'other' },
    { ...event, origin: { source: 'cli', client_session_id: 'wrong-dialect' } },
    { ...event, gap: { reason: 'overflow', from_cursor: 'wrong-dialect' } },
  ])('rejects mixed camel/snake aliases rather than guessing', value => {
    expect(() => decodeAutomationEvent(value)).toThrow(AutomationServiceError);
  });

  it('rejects the wrong selected wire dialect', () => {
    expect(() => decodeAutomationEvent(event, 'snake')).toThrow(AutomationServiceError);
    expect(() => decodeAutomationEvent(snakeEvent, 'camel')).toThrow(AutomationServiceError);
    expect(() => decodeAutomationPort({ ...port, connection_generation: '7' })).toThrow(AutomationServiceError);
  });

  it.each(['-1', '1.5', '01', '', '18446744073709551616', Number.MAX_SAFE_INTEGER + 1, -1, NaN])('rejects invalid or lossy counter %s', value => {
    expect(() => decodeAutomationEvent({ ...event, connectionGeneration: value })).toThrow(AutomationServiceError);
  });

  it('normalizes safe numeric peers but preserves the largest u64 as a decimal string', () => {
    expect(decodeAutomationEvent({ ...event, connectionGeneration: 7 }).connectionGeneration).toBe('7');
    expect(decodeAutomationEvent({ ...event, connectionGeneration: '18446744073709551615' }).connectionGeneration).toBe('18446744073709551615');
  });

  it('rejects incoherent snapshot Host/epoch instead of merging another COM3', () => {
    expect(() => decodeAutomationSnapshot({ ...snapshot, hostId: 'lab-b' })).toThrowError(expect.objectContaining({ code: 'STALE_SESSION' }));
    expect(() => decodeAutomationSnapshot({ ...snapshot, serverEpoch: 'boot-b' })).toThrowError(expect.objectContaining({ code: 'STALE_SESSION' }));
  });

  it('does not turn unknown operation outcomes into a zero-byte result', () => {
    expect(decodeAutomationOperation({ ...operation, outcome: { certainty: 'unknown' } }).outcome).toEqual({ certainty: 'unknown' });
    expect(() => decodeAutomationOperation({ ...operation, state: 'mystery' })).toThrow(AutomationServiceError);
  });

  it('rejects a nested snapshot lease from another port or connection', () => {
    expect(() => decodeAutomationPort({ ...port, control: { ...lease, target: { ...target, nativePortId: 'COM4' } } })).toThrow(AutomationServiceError);
    expect(() => decodeAutomationPort({ ...port, control: { ...lease, connectionGeneration: '8' } })).toThrow(AutomationServiceError);
  });

  it('canonicalizes safe runtime counters and excludes untrusted identity extras', () => {
    const request = {
      protocolVersion: 1, requestId: 'r', method: 'serial.send',
      target: { ...target, principalId: 'not-authority' },
      precondition: { ...precondition, connectionGeneration: 7 }, control: { ...control, fence: 12, principalId: 'not-authority' }, params: {},
    } as unknown as AutomationRequest;
    expect(encodeAutomationRequest(request)).toMatchObject({ target, precondition, control: { leaseId: 'lease-a', fence: '12' } });
    expect((encodeAutomationRequest(request) as AutomationRequest).target).not.toHaveProperty('principalId');
    expect((encodeAutomationRequest(request) as AutomationRequest).control).not.toHaveProperty('principalId');
    expect(encodeAutomationRequest(request, 'snake')).toMatchObject({ precondition: { connection_generation: '7' }, control: { fence: '12' } });
  });

  it('maps only the envelope and keeps method-specific params explicit', () => {
    const request: AutomationRequest = { protocolVersion: 1, requestId: 'r', method: 'serial.send', target, precondition, control, timeoutMs: 3000, params: { data_base64: 'AP+A' } };
    expect(encodeAutomationRequest(request, 'snake')).toEqual({
      protocol_version: 1, request_id: 'r', method: 'serial.send', target: snakeTarget,
      precondition: { server_epoch: 'boot-a', connection_generation: '7' },
      control: { lease_id: 'lease-a', fence: '9007199254740993' }, timeout_ms: 3000, params: { data_base64: 'AP+A' },
    });
    expect(encodeAutomationRequest({ ...request, params: { dataBase64: 'AP+A' } })).toEqual({ ...request, params: { dataBase64: 'AP+A' } });
  });
});

describe('automation NDJSON and base64 decoding', () => {
  it.each(['A', 'AA=', '!!!!', 'AP+A\n', '____', 'AB==', 'AAB='])('rejects noncanonical base64 %s', value => {
    expect(() => decodeAutomationEvent({ ...event, dataBase64: value })).toThrow(AutomationServiceError);
  });

  it('distinguishes empty bytes from an event without bytes', () => {
    expect(decodeAutomationEvent({ ...event, dataBase64: '' }).data).toEqual(new Uint8Array());
    const { dataBase64: _data, ...noData } = event;
    expect(decodeAutomationEvent(noData)).not.toHaveProperty('data');
  });

  it('decodes split UTF-8, JSON, CRLF, blank lines and an unterminated last line', () => {
    const bytes = new TextEncoder().encode(`\ufeff${JSON.stringify(event)}\r\n\n${JSON.stringify({ ...event, seq: '22', replay: false })}`);
    const decoder = createAutomationNdjsonDecoder();
    const result = [];
    for (const byte of bytes) result.push(...decoder.push(new Uint8Array([byte])));
    result.push(...decoder.finish());
    expect(result.map(item => item.seq)).toEqual(['9007199254740993', '22']); // Never sort by seq/time.
    expect(result[0].origin?.source).toBe('设备');
    expect(result[1].replay).toBe(false);
    expect(() => decoder.finish()).toThrow(AutomationServiceError);
  });

  it('decodes the snake dialect through the same streaming boundary', () => {
    const decoder = createAutomationNdjsonDecoder('snake');
    expect(decoder.push(new TextEncoder().encode(JSON.stringify(snakeEvent) + '\n'))).toEqual([decodeAutomationEvent(event)]);
    expect(decoder.finish()).toEqual([]);
  });

  it.each([new Uint8Array([0xff]), new TextEncoder().encode('{broken}\n')])('fails closed on invalid UTF-8 or JSON', input => {
    const decoder = createAutomationNdjsonDecoder();
    expect(() => decoder.push(input)).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => decoder.push(new Uint8Array())).toThrow(AutomationServiceError);
  });

  it('rejects truncated UTF-8, JSON and oversized lines at EOF', () => {
    const utf8 = createAutomationNdjsonDecoder();
    utf8.push(new Uint8Array([0xe4]));
    expect(() => utf8.finish()).toThrow(AutomationServiceError);
    const json = createAutomationNdjsonDecoder();
    json.push(new TextEncoder().encode('{'));
    expect(() => json.finish()).toThrow(AutomationServiceError);
    expect(() => createAutomationNdjsonDecoder('camel', 3).push(new TextEncoder().encode('    '))).toThrow(AutomationServiceError);
    expect(() => createAutomationNdjsonDecoder('camel', 0)).toThrow(AutomationServiceError);
  });
});

describe('automation structured errors', () => {
  it.each(AUTOMATION_ERROR_CODES)('retains stable error code %s', code => {
    expect(mapAutomationError({ code, stage: 'execute', message: 'detail', retryable: false })).toMatchObject({ code, stage: 'execute', message: 'detail', retryable: false });
  });

  it('preserves structured diagnostics and unknown future codes conservatively', () => {
    const mapped = mapAutomationError({ code: 'FUTURE_ERROR', stage: 'write', message: 'new backend failure', operation_id: 'op', side_effects: { certainty: 'unknown' }, retryable: true }, 'snake');
    expect(mapped).toMatchObject({ code: 'OUTCOME_UNKNOWN', wireCode: 'FUTURE_ERROR', operationId: 'op', sideEffects: { certainty: 'unknown' }, retryable: true });
    expect(mapAutomationError(mapped)).toBe(mapped);
  });

  it('does not parse a legacy error string into a domain code or promise safe resend', () => {
    const mapped = mapAutomationError('PORT_BUSY: text from old CommandError');
    expect(mapped).toMatchObject({ code: 'HOST_UNAVAILABLE', retryable: false, sideEffects: { certainty: 'unknown' } });
    expect(mapAutomationError({ code: 'PORT_BUSY', message: 'busy', retryable: false }).stage).toBe('transport');
  });
});

describe('automation service adapter', () => {
  it('rejects every unconnected operation, including release and subscriptions', async () => {
    const client = automationService.selectTarget();
    const calls = [
      client.handshake('r'), client.status(hostRequest), client.listPorts(hostRequest),
      client.subscribe(hostRequest), client.watch(hostRequest),
      client.acquireControl({ ...portRequest, ttlMs: 1000 }),
      client.renewControl({ ...portRequest, control, ttlMs: 1000 }),
      client.releaseControl({ ...portRequest, control }), client.send(sendRequest()),
      client.getOperation({ ...hostRequest, operationId: 'operation-a' }),
    ];
    const results = await Promise.allSettled(calls);
    expect(results).toHaveLength(10);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'HOST_UNAVAILABLE', stage: 'transport' });
    }
  });

  it('pins a remote target by identity, not alias/COM name, without mutating selection', async () => {
    const transport = fakeTransport();
    const selection = { kind: 'remote' as const, hostId: 'lab-a', connectionId: 'profile-a' };
    const client = createAutomationService(transport).selectTarget(selection);
    selection.hostId = 'lab-b';
    expect(client.target).toEqual({ kind: 'remote', hostId: 'lab-a', connectionId: 'profile-a' });
    expect(Object.isFrozen(client.target)).toBe(true);
    await expect(client.listPorts({ ...hostRequest, hostId: 'lab-b' })).rejects.toMatchObject({ code: 'STALE_SESSION' });
    expect(transport.request).not.toHaveBeenCalled();
  });

  it('routes handshake, status and listing through the selected domain transport', async () => {
    const transport = fakeTransport();
    const client = createAutomationService(transport).selectTarget({ kind: 'remote', hostId: 'lab-a', connectionId: 'native-profile' });
    transport.request.mockResolvedValueOnce({ protocolVersion: 1, hostId: 'lab-a', serverEpoch: 'boot-a', capabilities: ['ports.list'] })
      .mockResolvedValueOnce(snapshot).mockResolvedValueOnce([port]);
    await expect(client.handshake('hello')).resolves.toMatchObject({ hostId: 'lab-a' });
    await expect(client.status(hostRequest)).resolves.toEqual(snapshot);
    await expect(client.listPorts(hostRequest)).resolves.toEqual([port]);
    expect(transport.request.mock.calls.map(call => (call[1] as AutomationRequest).method)).toEqual(['handshake', 'host.status', 'ports.list']);
    expect(transport.request.mock.calls[0][0]).toEqual(client.target);
    expect(transport.request.mock.calls[2][1]).toEqual({ protocolVersion: 1, requestId: 'request-a', method: 'ports.list', target: { hostId: 'lab-a' }, precondition: { serverEpoch: 'boot-a' }, params: {} });
  });

  it('rejects the wrong handshake Host and stale snapshots instead of faking empty ports', async () => {
    const transport = fakeTransport();
    const client = createAutomationService(transport).selectTarget({ kind: 'local', hostId: 'lab-a' });
    transport.request.mockResolvedValueOnce({ protocolVersion: 1, hostId: 'other', serverEpoch: 'boot-a', capabilities: [] })
      .mockRejectedValueOnce({ code: 'HOST_UNAVAILABLE', stage: 'connect', message: 'offline' })
      .mockResolvedValueOnce({ ...snapshot, ports: [], serverEpoch: 'restarted' });
    await expect(client.handshake('r')).rejects.toMatchObject({ code: 'STALE_SESSION' });
    await expect(client.listPorts(hostRequest)).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE' });
    await expect(client.status(hostRequest)).rejects.toMatchObject({ code: 'STALE_SESSION' });
  });

  it('maps acquire, renew and release guards explicitly in the snake dialect', async () => {
    const transport = fakeTransport();
    transport.request.mockResolvedValueOnce(snakeLease).mockResolvedValueOnce(snakeLease).mockResolvedValueOnce(null);
    const client = createAutomationService(transport, 'snake').selectTarget();
    await expect(client.acquireControl({ ...portRequest, ttlMs: 1000, waitMs: 0 })).resolves.toEqual(lease);
    await expect(client.renewControl({ ...portRequest, control, ttlMs: 2000 })).resolves.toEqual(lease);
    await expect(client.releaseControl({ ...portRequest, control })).resolves.toBeUndefined();
    expect(transport.request.mock.calls[0][1]).toMatchObject({ method: 'control.acquire', params: { ttl_ms: 1000, wait_ms: 0 }, precondition: { server_epoch: 'boot-a', connection_generation: '7' } });
    expect(transport.request.mock.calls[1][1]).toMatchObject({ method: 'control.renew', control: { lease_id: 'lease-a', fence: '9007199254740993' }, params: { ttl_ms: 2000 } });
    expect(transport.request.mock.calls[2][1]).toMatchObject({ method: 'control.release', params: {} });
  });

  it('rejects a lease for a different port/generation and false release acknowledgements', async () => {
    const transport = fakeTransport();
    transport.request.mockResolvedValueOnce({ ...lease, target: { ...target, nativePortId: 'COM4' } })
      .mockResolvedValueOnce({ ...lease, connectionGeneration: '8' }).mockResolvedValueOnce({ success: true });
    const client = createAutomationService(transport).selectTarget();
    await expect(client.acquireControl({ ...portRequest, ttlMs: 1000 })).rejects.toBeInstanceOf(AutomationServiceError);
    await expect(client.acquireControl({ ...portRequest, ttlMs: 1000 })).rejects.toMatchObject({ code: 'STALE_SESSION' });
    await expect(client.releaseControl({ ...portRequest, control })).rejects.toBeInstanceOf(AutomationServiceError);
  });

  it('sends raw bytes exactly once with all guards and queries the original operation', async () => {
    const transport = fakeTransport();
    transport.request.mockResolvedValue(operation);
    const client = createAutomationService(transport).selectTarget();
    await expect(client.send(sendRequest())).resolves.toEqual(operation);
    expect(transport.request.mock.calls[0][1]).toEqual({ protocolVersion: 1, requestId: 'request-a', method: 'serial.send', target, precondition, control, timeoutMs: 3000, params: { dataBase64: 'AP+A' } });
    await expect(client.getOperation({ ...hostRequest, operationId: 'operation-a' })).resolves.toEqual(operation);
    await expect(client.getOperation({ ...hostRequest, originalRequestId: 'request-a' })).resolves.toEqual(operation);
    expect(transport.request).toHaveBeenCalledTimes(3);
  });

  it('forwards text and HEX to the Host codec instead of encoding/adding line endings locally', async () => {
    const transport = fakeTransport();
    transport.request.mockResolvedValue(operation);
    const client = createAutomationService(transport, 'camel').selectTarget();
    await client.send({ ...sendRequest(), input: { mode: 'text', text: '你好', encoding: 'GBK', lineEnding: '\r\n' } });
    await client.send({ ...sendRequest(), input: { mode: 'hex', hex: '00 ff', lineEnding: 'None' } });
    expect((transport.request.mock.calls[0][1] as AutomationRequest).params).toEqual({ mode: 'text', text: '你好', encoding: 'GBK', lineEnding: '\r\n' });
    expect((transport.request.mock.calls[1][1] as AutomationRequest).params).toEqual({ mode: 'hex', hex: '00 ff', lineEnding: 'None' });
  });

  it('does not retry side effects on retryable structured errors or lost replies', async () => {
    const transport = fakeTransport();
    transport.request.mockRejectedValueOnce({ code: 'IO_ERROR', stage: 'write', message: 'partial', operationId: 'operation-a', retryable: true, sideEffects: { certainty: 'partial', bytesWritten: '1' } })
      .mockRejectedValueOnce(new Error('lost ACK'));
    const client = createAutomationService(transport).selectTarget();
    await expect(client.send(sendRequest())).rejects.toMatchObject({ code: 'IO_ERROR', operationId: 'operation-a', sideEffects: { certainty: 'partial', bytesWritten: '1' } });
    await expect(client.send(sendRequest())).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', sideEffects: { certainty: 'unknown' } });
    expect(transport.request).toHaveBeenCalledTimes(2);
  });

  it('rejects operation responses for another request instead of counting their TX', async () => {
    const transport = fakeTransport();
    transport.request.mockResolvedValue({ ...operation, requestId: 'other' });
    const client = createAutomationService(transport).selectTarget();
    await expect(client.send(sendRequest())).rejects.toBeInstanceOf(AutomationServiceError);
    await expect(client.getOperation({ ...hostRequest, originalRequestId: 'request-a' })).rejects.toBeInstanceOf(AutomationServiceError);
  });

  it('subscribes atomically with the snapshot/watermark and preserves replay/gap metadata', async () => {
    const transport = fakeTransport();
    const stream = wireSubscription();
    transport.subscribe.mockResolvedValue(stream);
    const client = createAutomationService(transport).selectTarget();
    const subscription = await client.subscribe({ ...hostRequest, nativePortId: 'COM3', cursor: 'cursor:18' });
    expect(subscription.snapshot).toEqual(snapshot);
    const result = [];
    for await (const item of subscription.events) result.push(item);
    expect(result).toEqual([decodeAutomationEvent(event)]);
    expect(stream.unsubscribe).toHaveBeenCalledOnce();
    expect(transport.request).not.toHaveBeenCalled(); // No list-then-listen race.
    expect(transport.subscribe.mock.calls[0][1]).toMatchObject({ method: 'events.subscribe', target, params: { cursor: 'cursor:18' } });
    await subscription.unsubscribe();
    expect(stream.unsubscribe).toHaveBeenCalledOnce();
  });

  it('watch uses the stream interface and detach never closes the port or releases control', async () => {
    const transport = fakeTransport();
    const stream = wireSubscription();
    transport.subscribe.mockResolvedValue(stream);
    const client = createAutomationService(transport).selectTarget();
    const subscription = await client.watch(hostRequest);
    await subscription.unsubscribe();
    expect(stream.unsubscribe).toHaveBeenCalledOnce();
    expect(transport.request).not.toHaveBeenCalled();
    expect(transport.subscribe.mock.calls[0][1]).toMatchObject({ method: 'ports.watch' });
  });

  it('rejects invalid control budgets asynchronously without contacting transport', async () => {
    const transport = fakeTransport();
    const client = createAutomationService(transport).selectTarget();
    await expect(client.acquireControl({ ...portRequest, ttlMs: -1 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(client.renewControl({ ...portRequest, control, ttlMs: 0.5 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(transport.request).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent detach and cleans up an early consumer break', async () => {
    const transport = fakeTransport();
    const first = wireSubscription();
    const second = wireSubscription([event, event]);
    transport.subscribe.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const client = createAutomationService(transport).selectTarget();
    const subscription = await client.subscribe(hostRequest);
    await Promise.all([subscription.unsubscribe(), subscription.unsubscribe()]);
    expect(first.unsubscribe).toHaveBeenCalledOnce();
    const next = await client.subscribe(hostRequest);
    for await (const _item of next.events) break;
    expect(second.unsubscribe).toHaveBeenCalledOnce();
  });

  it('keeps a stream identity failure when detach fails and reports explicit detach failures', async () => {
    const transport = fakeTransport();
    const stream = wireSubscription([{ ...event, serverEpoch: 'boot-b' }]);
    stream.unsubscribe = vi.fn(async () => { throw new Error('detach failed'); });
    transport.subscribe.mockResolvedValue(stream);
    const subscription = await createAutomationService(transport).selectTarget().subscribe(hostRequest);
    const read = async () => { for await (const _item of subscription.events) { /* consumer */ } };
    await expect(read()).rejects.toMatchObject({ code: 'STALE_SESSION' });
    await expect(subscription.unsubscribe()).rejects.toMatchObject({ code: 'HOST_UNAVAILABLE', message: 'detach failed' });
    expect(stream.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('cleans up stale snapshots and rejects late events from a restarted Host', async () => {
    const transport = fakeTransport();
    const stale = { ...wireSubscription(), snapshot: { ...snapshot, serverEpoch: 'boot-b', ports: [] } };
    const late = wireSubscription([{ ...event, serverEpoch: 'boot-b' }]);
    transport.subscribe.mockResolvedValueOnce(stale).mockResolvedValueOnce(late);
    const client = createAutomationService(transport).selectTarget();
    await expect(client.subscribe(hostRequest)).rejects.toMatchObject({ code: 'STALE_SESSION' });
    expect(stale.unsubscribe).toHaveBeenCalledOnce();
    const subscription = await client.subscribe(hostRequest);
    const read = async () => { for await (const _item of subscription.events) { /* consumer */ } };
    await expect(read()).rejects.toMatchObject({ code: 'STALE_SESSION' });
    expect(late.unsubscribe).toHaveBeenCalledOnce();
  });
});
