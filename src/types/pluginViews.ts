export type PluginViewInput = 'bytes' | 'lines' | 'none';
export type PluginViewPlacement = 'serial-content' | 'workspace-tab';

export interface PluginViewDeclaration {
  id: string;
  label: string;
  entry: string;
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

export interface PluginViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
  zoomPercent: number;
}

export interface PluginNativeMessage {
  instanceId: string;
  type: 'ready' | 'ack' | 'message' | 'focus' | 'error';
  revision?: number;
  messageType?: string;
  payload?: unknown;
  error?: string;
}

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
