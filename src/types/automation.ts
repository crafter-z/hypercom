/**
 * Unified automation API boundary, separate from the legacy Tauri/serial payloads.
 * Wire counters are decimal strings: never round a Rust u64 through a JS number.
 * Neither these types nor the adapter grant authority; the Host remains authoritative.
 */
export type HostId = string;
export type ServerEpoch = string;
export type ConnectionGeneration = string;
export type LeaseId = string;
export type Fence = string;
export type RequestId = string;
export type OperationId = string;
export type EventSequence = string;
export type EventCursor = string;
export type WireCase = 'camel' | 'snake';
/** Numeric peers are accepted only while within Number.MAX_SAFE_INTEGER. */
export type WireCounter = string | number;

export interface PortRef { hostId: HostId; nativePortId: string }
export interface WirePortRefSnake { host_id: HostId; native_port_id: string }

/** Remote connections/credentials are resolved by the native adapter, not the WebView. */
export type AutomationTarget =
  | { kind: 'local'; hostId?: HostId }
  | { kind: 'remote'; hostId: HostId; connectionId: string };

export interface Precondition {
  serverEpoch: ServerEpoch;
  connectionGeneration: ConnectionGeneration;
}
export interface ControlToken { leaseId: LeaseId; fence: Fence }
export interface WirePreconditionSnake {
  server_epoch: ServerEpoch;
  connection_generation: ConnectionGeneration;
}
export interface WireControlTokenSnake { lease_id: LeaseId; fence: Fence }

export type AutomationMethod =
  | 'handshake' | 'host.status' | 'ports.list' | 'ports.watch'
  | 'events.subscribe' | 'control.acquire' | 'control.renew'
  | 'control.release' | 'serial.send' | 'operations.get';

export interface AutomationRequest {
  protocolVersion: number;
  requestId: RequestId;
  method: AutomationMethod;
  target?: PortRef | { hostId: HostId };
  precondition?: { serverEpoch: ServerEpoch; connectionGeneration?: ConnectionGeneration };
  control?: ControlToken;
  timeoutMs?: number;
  params: Record<string, unknown>;
}
export interface WireAutomationRequestSnake {
  protocol_version: number;
  request_id: RequestId;
  method: AutomationMethod;
  target?: WirePortRefSnake | { host_id: HostId };
  precondition?: { server_epoch: ServerEpoch; connection_generation?: ConnectionGeneration };
  control?: WireControlTokenSnake;
  timeout_ms?: number;
  params: Record<string, unknown>;
}
export type WireAutomationRequest = AutomationRequest | WireAutomationRequestSnake;

export const AUTOMATION_ERROR_CODES = [
  'INVALID_ARGUMENT', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'HOST_UNAVAILABLE',
  'PORT_NOT_FOUND', 'PORT_BUSY', 'CONTROL_LOST', 'STALE_SESSION', 'REQUEST_ID_CONFLICT',
  'DEADLINE_EXCEEDED', 'CANCELLED', 'IO_ERROR', 'OUTCOME_UNKNOWN', 'CURSOR_EXPIRED',
  'STREAM_GAP', 'UNSUPPORTED_CAPABILITY', 'CONFIG_CONFLICT', 'SHUTTING_DOWN',
] as const;
export type AutomationErrorCode = typeof AUTOMATION_ERROR_CODES[number];
export type OutcomeCertainty = 'known' | 'unknown' | 'partial';
export interface SideEffects { certainty: OutcomeCertainty; bytesWritten?: string }
export interface StructuredAutomationError {
  code: AutomationErrorCode;
  stage: string;
  message: string;
  operationId?: OperationId;
  sideEffects?: SideEffects;
  /** Diagnostic hint only. Never authorizes automatic replay of a device operation. */
  retryable?: boolean;
}
export interface WireAutomationError {
  code: string;
  stage?: string;
  message: string;
  operationId?: OperationId;
  sideEffects?: SideEffects;
  retryable?: boolean;
}
export interface WireAutomationErrorSnake {
  code: string;
  stage: string;
  message: string;
  operation_id?: OperationId;
  side_effects?: { certainty: OutcomeCertainty; bytes_written?: string };
  retryable?: boolean;
}

export interface Handshake {
  protocolVersion: number;
  hostId: HostId;
  serverEpoch: ServerEpoch;
  capabilities: string[];
  clientSessionId?: string;
}
export interface WireHandshakeSnake {
  protocol_version: number;
  host_id: HostId;
  server_epoch: ServerEpoch;
  capabilities: string[];
  client_session_id?: string;
}

export type PortState = 'closed' | 'opening' | 'open' | 'closing' | 'error';
export type LeaseState = 'requested' | 'granted' | 'revoking' | 'draining' | 'released' | 'expired';
export interface ControlLease extends ControlToken {
  target: PortRef;
  serverEpoch: ServerEpoch;
  connectionGeneration: ConnectionGeneration;
  state: LeaseState;
  expiresAtMs: number;
  clientSessionId?: string;
}
export interface WireControlLease extends Omit<ControlLease, 'connectionGeneration' | 'fence'> {
  connectionGeneration: WireCounter;
  fence: WireCounter;
}
export interface WireControlLeaseSnake extends WireControlTokenSnake {
  target: WirePortRefSnake;
  server_epoch: ServerEpoch;
  connection_generation: ConnectionGeneration;
  state: LeaseState;
  expires_at_ms: number;
  client_session_id?: string;
}
export interface SerialParameters {
  baudRate: number;
  dataBits: number;
  parity: string;
  stopBits: string;
  handshake: string;
  dtr: boolean;
  rts: boolean;
}
export interface WireSerialParametersSnake {
  baud_rate: number;
  data_bits: number;
  parity: string;
  stop_bits: string;
  handshake: string;
  dtr: boolean;
  rts: boolean;
}
export interface PortSnapshot {
  target: PortRef;
  serverEpoch: ServerEpoch;
  connectionGeneration: ConnectionGeneration;
  state: PortState;
  name?: string;
  params?: SerialParameters;
  control?: ControlLease | null;
}
export interface WirePortSnapshot extends Omit<PortSnapshot, 'connectionGeneration' | 'control'> {
  connectionGeneration: WireCounter;
  control?: WireControlLease | null;
}
export interface WirePortSnapshotSnake {
  target: WirePortRefSnake;
  server_epoch: ServerEpoch;
  connection_generation: ConnectionGeneration;
  state: PortState;
  name?: string;
  params?: WireSerialParametersSnake;
  control?: WireControlLeaseSnake | null;
}
/** A single authoritative snapshot + watermark, never a list-then-listen approximation. */
export interface AutomationSnapshot {
  hostId: HostId;
  serverEpoch: ServerEpoch;
  cursor: EventCursor;
  ports: PortSnapshot[];
}
export interface WireAutomationSnapshot extends Omit<AutomationSnapshot, 'ports'> { ports: WirePortSnapshot[] }
export interface WireAutomationSnapshotSnake {
  host_id: HostId;
  server_epoch: ServerEpoch;
  cursor: EventCursor;
  ports: WirePortSnapshotSnake[];
}
export type OperationState = 'accepted' | 'queued' | 'executing' | 'succeeded' | 'failed' | 'cancelled';
export interface AutomationOperation {
  operationId: OperationId;
  requestId: RequestId;
  target: PortRef;
  serverEpoch: ServerEpoch;
  connectionGeneration: ConnectionGeneration;
  state: OperationState;
  outcome: SideEffects;
  error?: StructuredAutomationError;
}
export interface WireAutomationOperation extends Omit<AutomationOperation, 'connectionGeneration' | 'error'> {
  connectionGeneration: WireCounter;
  error?: WireAutomationError;
}
export interface WireAutomationOperationSnake {
  operation_id: OperationId;
  request_id: RequestId;
  target: WirePortRefSnake;
  server_epoch: ServerEpoch;
  connection_generation: ConnectionGeneration;
  state: OperationState;
  outcome: { certainty: OutcomeCertainty; bytes_written?: string };
  error?: WireAutomationErrorSnake;
}

export interface EventOrigin {
  source: string;
  clientSessionId?: string;
  principalId?: string;
}
export interface StreamGap { reason: string; fromCursor?: EventCursor; toCursor?: EventCursor }
export interface WireAutomationEvent {
  hostId: HostId;
  serverEpoch: ServerEpoch;
  nativePortId: string;
  connectionGeneration: WireCounter;
  seq: WireCounter;
  cursor: EventCursor;
  type: string;
  timestampMs: number;
  dataBase64?: string;
  origin?: EventOrigin;
  operationId?: OperationId;
  jobId?: string;
  replay?: boolean;
  gap?: StreamGap;
}
export interface WireAutomationEventSnake {
  host_id: HostId;
  server_epoch: ServerEpoch;
  native_port_id: string;
  connection_generation: ConnectionGeneration;
  seq: EventSequence;
  cursor: EventCursor;
  type: string;
  timestamp_ms: number;
  data_base64?: string;
  origin?: { source: string; client_session_id?: string; principal_id?: string };
  operation_id?: OperationId;
  job_id?: string;
  replay?: boolean;
  gap?: { reason: string; from_cursor?: EventCursor; to_cursor?: EventCursor };
}
export interface AutomationEvent extends Omit<WireAutomationEvent, 'dataBase64' | 'replay' | 'connectionGeneration' | 'seq'> {
  connectionGeneration: ConnectionGeneration;
  seq: EventSequence;
  data?: Uint8Array;
  replay: boolean;
}

export interface HostRequest { requestId: RequestId; hostId: HostId; serverEpoch: ServerEpoch }
export interface PortRequest {
  requestId: RequestId;
  target: PortRef;
  precondition: Precondition;
  timeoutMs?: number;
}
export interface AcquireControlRequest extends PortRequest { ttlMs: number; waitMs?: number }
export interface RenewControlRequest extends PortRequest { control: ControlToken; ttlMs: number }
export interface ReleaseControlRequest extends PortRequest { control: ControlToken }
/** Host codec owns text/HEX interpretation; raw bytes bypass text/line-ending conversion. */
export type SendInput =
  | { mode: 'raw'; data: Uint8Array }
  | { mode: 'text'; text: string; encoding: string; lineEnding: string }
  | { mode: 'hex'; hex: string; lineEnding: string };
export interface SendRequest extends ReleaseControlRequest { input: SendInput }
export interface SubscribeRequest extends HostRequest { nativePortId?: string; cursor?: EventCursor }
export type GetOperationRequest = HostRequest &
  ({ operationId: OperationId; originalRequestId?: never } | { originalRequestId: RequestId; operationId?: never });

/** Transport returns unwrapped domain response payloads, not arbitrary Tauri invoke values. */
export interface AutomationTransport {
  request(target: AutomationTarget, request: WireAutomationRequest): Promise<unknown>;
  /** Must atomically register the stream and return its matching snapshot/watermark. */
  subscribe(target: AutomationTarget, request: WireAutomationRequest): Promise<WireAutomationSubscription>;
}
export interface WireAutomationSubscription {
  snapshot: unknown;
  /** Each item is one JSON event object; NDJSON transports use the incremental decoder. */
  events: AsyncIterable<unknown>;
  unsubscribe(): Promise<void>;
}
export interface AutomationSubscription {
  snapshot: AutomationSnapshot;
  events: AsyncIterable<AutomationEvent>;
  /** Detach only. Does not release control, close the port or stop the Host. */
  unsubscribe(): Promise<void>;
}
export interface AutomationClient {
  readonly target: AutomationTarget;
  handshake(requestId: RequestId): Promise<Handshake>;
  status(request: HostRequest): Promise<AutomationSnapshot>;
  listPorts(request: HostRequest): Promise<PortSnapshot[]>;
  subscribe(request: SubscribeRequest): Promise<AutomationSubscription>;
  watch(request: SubscribeRequest): Promise<AutomationSubscription>;
  acquireControl(request: AcquireControlRequest): Promise<ControlLease>;
  renewControl(request: RenewControlRequest): Promise<ControlLease>;
  releaseControl(request: ReleaseControlRequest): Promise<void>;
  send(request: SendRequest): Promise<AutomationOperation>;
  getOperation(request: GetOperationRequest): Promise<AutomationOperation>;
}
