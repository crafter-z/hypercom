import { PLUGIN_FILE_WINDOW_BYTES } from '../services/pluginFileHandle';

/** Instantiate inside the Worker bridge IIFE before assigning self.plugin.
 * The existing callHost handles AbortSignal, tombstones, and late replies for
 * fs.openFile/createFile/readFileWindow/writeFileChunk; commit takes no signal. */
export const PLUGIN_FILE_HANDLE_SDK = `
  var pluginFileSdk = (function () {
    var MAX_WINDOW = ${PLUGIN_FILE_WINDOW_BYTES};
    function closeHandle(id) { return callHost('fs.closeFile', { handleId: id }); }
    function pickOptions(options) {
      var input = options || {};
      var hints = {};
      ['title', 'defaultFileName', 'filters'].forEach(function (key) {
        if (input[key] !== undefined) hints[key] = input[key];
      });
      return { options: hints, signal: input.signal };
    }
    function viewBytes(bytes) {
      if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
      if (bytes instanceof Uint8Array) return bytes;
      throw new TypeError('file chunk must be Uint8Array or ArrayBuffer');
    }
    function checkBounds(offset, length) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > MAX_WINDOW) {
        throw new RangeError('invalid plugin file window');
      }
    }
    function reader(selected) {
      var closed = false;
      function read(offset, length, options) {
        checkBounds(offset, length);
        if (closed) return Promise.reject(new Error('selected file is closed'));
        return callHost('fs.readFileWindow', { handleId: selected.handleId, offset: offset, length: length, signal: options && options.signal });
      }
      function close() {
        if (closed) return Promise.resolve();
        closed = true;
        return closeHandle(selected.handleId).catch(function (error) { closed = false; throw error; });
      }
      async function* windows(options) {
        var size = options && options.chunkSize !== undefined ? options.chunkSize : MAX_WINDOW;
        checkBounds(0, size);
        if (size === 0) throw new RangeError('file iterator requires a positive chunk size');
        try {
          for (var offset = 0; offset < selected.size;) {
            var bytes = await read(offset, Math.min(size, selected.size - offset), options);
            offset += bytes.byteLength;
            if (options && typeof options.onProgress === 'function') options.onProgress({ bytesRead: offset, totalBytes: selected.size });
            yield bytes;
          }
        } finally { await close(); }
      }
      return Object.freeze({ handleId: selected.handleId, name: selected.name, size: selected.size,
        read: read, windows: windows, close: close, cancel: close });
    }
    function writer(selected) {
      var state = 'open';
      var offset = 0;
      function close() {
        if (state === 'closed' || state === 'committed') return Promise.resolve();
        // Explicit close competes with an active commit. Only the awaited
        // commit result indicates whether an atomic publication occurred.
        state = 'closing';
        return closeHandle(selected.handleId).then(function () { state = 'closed'; });
      }
      async function write(bytes, options) {
        if (state !== 'open') throw new Error('file writer is busy or closed');
        bytes = viewBytes(bytes);
        checkBounds(offset, bytes.byteLength);
        if (bytes.byteLength < 1) throw new RangeError('file chunk is empty');
        state = 'writing';
        try {
          // A view over a huge backing buffer must not clone the rest of it.
          var exact = bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
          offset = await callHost('fs.writeFileChunk', { handleId: selected.handleId, offset: offset, bytes: exact, signal: options && options.signal });
          if (state !== 'writing') throw new Error('file writer was closed');
          state = 'open';
          return offset;
        } catch (error) {
          try { await close(); } catch (_) {}
          throw error;
        }
      }
      async function commit() {
        if (state !== 'open') throw new Error('file writer is busy or closed');
        state = 'committing';
        try {
          var result = await callHost('fs.commitFile', { handleId: selected.handleId });
          state = 'committed';
          return result;
        } catch (error) {
          // Never replay commit: the reply might have been lost after rename.
          try { await close(); } catch (_) {}
          throw error;
        }
      }
      return Object.freeze({ name: selected.name, write: write, commit: commit, close: close, cancel: close });
    }
    return Object.freeze({
      openFile: function (options) { return callHost('fs.openFile', pickOptions(options)).then(function (selected) { return selected ? reader(selected) : null; }); },
      createFile: function (options) { return callHost('fs.createFile', pickOptions(options)).then(function (selected) { return selected ? writer(selected) : null; }); }
    });
  })();
`;
