/** Injection fragment for the Worker bridge, where `api` is already defined.
 *
 * Consume both piped streams concurrently (or discard one at start), since the
 * bounded pipes intentionally backpressure the child. A byte chunk can end in
 * the middle of a UTF-8 code point, so keep one decoder per stream:
 *
 * ```js
 * const task = await self.plugin.shell.start({ program: 'my-local-tool' });
 * async function consume(stream, render) {
 *   const decoder = new TextDecoder();
 *   for await (const bytes of stream) render(decoder.decode(bytes, { stream: true }));
 *   render(decoder.decode());
 * }
 * try {
 *   const [, , terminal] = await Promise.all([
 *     consume(task.stdout, renderStdout), consume(task.stderr, renderStderr), task.wait()
 *   ]);
 * } finally { await task.release(); }
 * // From the user's Cancel action: await task.cancel(); // acknowledges request
 * // For unneeded stderr: shell.start(request, { stderr: 'discard' })
 * ```
 */
export const PLUGIN_PROCESS_FACADE_CODE = `
  function startPluginProcess(request, options) {
    return api['shell.start']({ request: request, options: options }).then(function (opened) {
      var taskId = opened.taskId;
      var released = false;
      var releasing = null;
      function call(op, extra) {
        if (released || releasing) return Promise.reject(new Error('Shell task released'));
        return api[op](Object.assign({ taskId: taskId }, extra));
      }
      function output(stream) {
        var active = false;
        return Object.freeze({
          [Symbol.asyncIterator]: async function* () {
            if (active) throw new Error('Shell output already has a reader');
            active = true;
            try {
              while (!released && !releasing) {
                var result = await call('shell.read', { stream: stream });
                if (released || releasing || result.kind === 'eof') return;
                if (result.kind !== 'chunk' || !(result.bytes instanceof Uint8Array)) throw new Error('Invalid shell output');
                yield result.bytes;
              }
            } finally { active = false; }
          }
        });
      }
      return Object.freeze({
        stdout: output('stdout'),
        stderr: output('stderr'),
        status: function () { return call('shell.status', { wait: false }); },
        wait: function () { return call('shell.status', { wait: true }); },
        cancel: function () { return call('shell.cancel'); },
        release: function () {
          if (released) return Promise.resolve();
          if (!releasing) {
            releasing = api['shell.release']({ taskId: taskId }).then(function () { released = true; })
              .finally(function () { releasing = null; });
          }
          return releasing;
        }
      });
    });
  }
`;
