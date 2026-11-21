const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function loadExample() {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const events = new Map();
  const calls = { status: [], bytes: [], files: [], panels: [] };
  const ports = new Map([
    ['COM1', { id: 'COM1', status: 'connected', connectionGeneration: 11 }],
    ['COM2', { id: 'COM2', status: 'connected', connectionGeneration: 22 }],
  ]);
  const task = (list, options) => ({
    onProgress() {},
    done: Promise.resolve({ status: 'completed', bytesWritten: options.totalBytes || 4 }),
  });
  const plugin = {
    api: {
      'ui.panel.append': async ({ text }) => calls.panels.push(text),
      'ports.status': async ({ portId }) => {
        calls.status.push(portId);
        return ports.get(portId) || null;
      },
    },
    fs: {
      openFile: async () => ({
        handleId: 'reader-1', name: 'synthetic.bin', size: 4,
        read: async () => new Uint8Array([1, 2, 3, 4]),
        close: async () => {},
      }),
    },
    serial: {
      sendBytes: (options) => {
        calls.bytes.push(options);
        return task(calls.bytes, options);
      },
      sendFile: (options) => {
        calls.files.push(options);
        return task(calls.files, options);
      },
    },
    shell: { start: async () => { throw new Error('not used by this test'); } },
    on: (name, callback) => events.set(name, callback),
  };
  const context = {
    self: { plugin },
    AbortController,
    TextEncoder,
    TextDecoder,
    console,
    Uint8Array,
    ArrayBuffer,
    Promise,
    Number,
    String,
    Set,
    Map,
  };
  vm.runInNewContext(source, context, { filename: 'examples/plugin-stream-tasks/main.js' });
  return { handler: events.get('ui.buttonClick'), calls };
}

test('send actions use the explicitly selected second port and its current generation', async () => {
  const { handler, calls } = loadExample();
  handler({ buttonId: 'send-bytes', context: { portId: 'COM2' } });
  await flush();
  await flush();
  assert.deepEqual(calls.status, ['COM2']);
  assert.equal(calls.bytes[0].portId, 'COM2');
  assert.equal(calls.bytes[0].expectedConnectionGeneration, 22);
  assert.deepEqual(Array.from(calls.bytes[0].bytes), [0x48, 0x43, 0x2d, 0x32]);
});

test('file send uses the same selected port and missing context never falls back', async () => {
  const { handler, calls } = loadExample();
  handler({ buttonId: 'read-file', context: {} });
  await flush();
  await flush();
  handler({ buttonId: 'send-file', context: { portId: 'COM2' } });
  await flush();
  await flush();
  assert.deepEqual(calls.status, ['COM2']);
  assert.equal(calls.files[0].portId, 'COM2');
  assert.equal(calls.files[0].expectedConnectionGeneration, 22);
  assert.equal(calls.files[0].handleId, 'reader-1');
  handler({ buttonId: 'send-bytes', context: {} });
  await flush();
  await flush();
  assert.deepEqual(calls.status, ['COM2']);
  assert.equal(calls.bytes.length, 0);
});
