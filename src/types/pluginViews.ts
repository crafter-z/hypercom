export type PluginViewInput = 'bytes' | 'lines' | 'none';
export type PluginViewPlacement = 'serial-content' | 'workspace-tab';

export interface PluginViewDeclaration {
  id: string;
  label: string;
  entry: string;
  mode?: 'isolated' | 'trusted-web';
  /** `false` marks a trusted local page that runs without a Worker session. */
  worker?: boolean;
  styles: string[];
  assets: string[];
  modes: Array<'trx' | 'tty'>;
  input: PluginViewInput;
  placements: PluginViewPlacement[];
  portBinding: 'required' | 'optional' | 'none';
  restoreOnStartup: boolean;
}

export interface PluginViewPreference {
  pluginId: string;
  installGeneration: string;
  viewId: string;
}

export interface PluginViewBinding extends PluginViewPreference {
  tabId: string;
  placement: PluginViewPlacement;
  boundPortId: string | null;
  portMode: 'trx' | 'tty' | null;
  tabSessionId: string;
  viewInstanceId: string;
  /** 0 means an independent local page: no Worker peer for this document. */
  workerEpoch: number;
  streamEpoch: number;
}

export interface PluginViewEnvironment {
  theme: 'dark' | 'light';
  language: string;
  fontFamily: string;
  fontSize: number;
  zoomPercent: number;
  visible: boolean;
  focused: boolean;
  portStatus: string | null;
}

export interface PluginViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PluginViewRect extends PluginViewportRect {
  zoomPercent: number;
}

/** Native -> frontend view event. Every document-scoped event carries the
 *  current `documentId`; `document` announces a new top-level document, and
 *  `navigation-complete` reports that the document finished loading (used for
 *  the trusted-web ready watchdog). */
export interface PluginNativeMessage {
  instanceId: string;
  type: 'ready' | 'ack' | 'message' | 'focus' | 'error' | 'document' | 'navigation-complete' | 'binary' | 'binary-ack';
  documentId?: string;
  revision?: number;
  messageType?: string;
  payload?: unknown;
  error?: string;
  transferId?: string;
  transferType?: string;
  seq?: number;
  done?: boolean;
  /** Base64-encoded raw chunk bytes (maximum 8 KiB per chunk). */
  data?: string;
  ok?: boolean;
}

/** Host -> native view message. Binary chunks never pass through the bounded
 *  realtime state JSON; each envelope carries at most 8 KiB of raw bytes. */
export interface PluginViewHostMessage {
  type: 'init' | 'state' | 'environment' | 'binary-chunk' | 'binary-ack';
  documentId: string;
  context?: PluginViewBinding;
  environment?: PluginViewEnvironment;
  revision?: number;
  snapshot?: unknown;
  transferId?: string;
  transferType?: string;
  seq?: number;
  done?: boolean;
  data?: string;
  ok?: boolean;
  error?: string;
}

/** Raw bytes used by the bidirectional binary channel (256 MiB per transfer). */
export type PluginViewBinaryBytes = Uint8Array | ArrayBuffer;

export interface PluginTabOpenOptions {
  viewId: string;
  portId?: string | null;
  instanceKey?: string;
  params?: unknown;
  activation?: 'background' | 'foreground';
  actionToken?: string;
}

export interface PluginViewState {
  status: 'loading' | 'ready' | 'unavailable';
  error: string | null;
  instanceId: string | null;
}
