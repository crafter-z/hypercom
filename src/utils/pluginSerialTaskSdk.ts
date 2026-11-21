import { PLUGIN_SERIAL_TASK_WINDOW_BYTES } from '../services/pluginSerialTask';
import type { PluginSerialTaskProgress } from './pluginSerialTask';

export type PluginSerialClientProgress = Omit<PluginSerialTaskProgress, 'totalBytes'> & { totalBytes: number | null };
export interface PluginSerialSendTask {
  readonly taskId: string;
  readonly done: Promise<PluginSerialClientProgress>;
  cancel(): Promise<void>;
  getProgress(): PluginSerialClientProgress;
  onProgress(callback: (progress: PluginSerialClientProgress) => void): () => void;
}

/** Inject after callHost/newRequestId are available and before self.plugin is
 * assembled. Bounded views are copied one at a time, never the whole input. */
export const PLUGIN_SERIAL_TASK_SDK_CODE = `
  function serialTask(kind, options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid serial send options');
    var data = null;
    if (kind === 'bytes') {
      data = options.bytes instanceof ArrayBuffer ? new Uint8Array(options.bytes) : options.bytes;
      if (!(data instanceof Uint8Array)) throw new Error('serial.sendBytes requires Uint8Array or ArrayBuffer');
    } else if (typeof options.handleId !== 'string' || !options.handleId) {
      throw new Error('serial.sendFile requires a selected read handle ID');
    }
    if (typeof options.portId !== 'string' || !options.portId ||
        !Number.isSafeInteger(options.expectedConnectionGeneration) || options.expectedConnectionGeneration < 0) {
      throw new Error('Serial task needs a port and its observed connection generation');
    }
    var signal = options.signal;
    if (signal != null && (typeof signal.aborted !== 'boolean' ||
        typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
      throw new Error('Invalid serial task AbortSignal');
    }
    var id = newRequestId();
    var begin = { taskId: id, kind: kind, portId: options.portId, expectedConnectionGeneration: options.expectedConnectionGeneration };
    if (data) begin.totalBytes = data.byteLength;
    else begin.handleId = options.handleId;
    var progress = { taskId: id, portId: begin.portId, connectionGeneration: begin.expectedConnectionGeneration,
      status: 'starting', bytesWritten: 0, totalBytes: data ? data.byteLength : null };
    var listeners = new Set();
    var cancellation = null;
    var cancelRequested = false;
    var beginSent = false;
    var settled = false;
    function getProgress() { return Object.assign({}, progress); }
    function publish(next) {
      progress = next;
      listeners.forEach(function (callback) {
        try { callback(getProgress()); } catch (error) { console.error('[plugin] serial progress handler', error); }
      });
      return getProgress();
    }
    function localTerminal(status, error) {
      var next = Object.assign({}, progress, { status: status });
      if (error) next.message = String(error && error.message || error);
      return next;
    }
    function cancel() {
      if (settled) return Promise.resolve();
      cancelRequested = true;
      if (beginSent && !cancellation) {
        cancellation = callHost('serial.cancelSend', { taskId: id });
        // AbortSignal users do not await cancel(). Suppress only the unobserved
        // rejection; explicit callers can still see it and the run never retries.
        cancellation.catch(function () {});
      }
      if (progress.status === 'starting' || progress.status === 'running') {
        publish(Object.assign({}, progress, { status: 'cancelling' }));
      }
      return cancellation ? cancellation.then(function () {}) : Promise.resolve();
    }
    function onAbort() { cancel().catch(function () {}); }
    async function cancelledResult() {
      try {
        var decision = await cancellation;
        if (decision && decision.status !== 'starting' && decision.status !== 'running' && decision.status !== 'cancelling') return decision;
      } catch (error) { return localTerminal('cancelled', error); }
      return localTerminal('cancelled');
    }
    async function run() {
      if (cancelRequested || (signal && signal.aborted)) return localTerminal('cancelled');
      beginSent = true;
      var state;
      try { state = await callHost('serial.beginSend', begin); }
      catch (error) { return localTerminal(cancelRequested ? 'cancelled' : 'failed', error); }
      while (state.status === 'running') {
        if (cancelRequested) {
          progress = Object.assign({}, state, { status: 'cancelling' });
          return cancelledResult();
        }
        publish(state);
        if (cancelRequested) return cancelledResult();
        var args = { taskId: id };
        try {
          if (data) {
            // Copy only the exact current window; a subarray alone would make
            // structured clone copy the whole backing buffer.
            args.bytes = data.slice(state.bytesWritten,
              state.bytesWritten + Math.min(state.windowBytes || ${PLUGIN_SERIAL_TASK_WINDOW_BYTES}, ${PLUGIN_SERIAL_TASK_WINDOW_BYTES}));
          }
        } catch (error) {
          await cancel().catch(function () {});
          return localTerminal('failed', error);
        }
        try { state = await callHost('serial.sendStep', args); }
        catch (error) {
          // The send may have reached the native writer. Never retry it or
          // turn this lost result into a success (even if cancellation raced).
          await cancel().catch(function () {});
          return localTerminal('unknown', error);
        }
      }
      return state;
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    var done = Promise.resolve().then(run).then(function (final) {
      settled = true;
      return publish(final);
    }).finally(function () {
      data = null;
      if (signal) signal.removeEventListener('abort', onAbort);
      listeners.clear();
    });
    return { taskId: id, done: done, cancel: cancel, getProgress: getProgress,
      onProgress: function (callback) {
        if (typeof callback !== 'function') throw new Error('Serial task progress callback must be a function');
        if (!settled) listeners.add(callback);
        return function () { listeners.delete(callback); };
      }
    };
  }
  var serialTasks = {
    sendBytes: function (options) { return serialTask('bytes', options); },
    sendFile: function (options) { return serialTask('file', options); }
  };
`;
