/*
 * HyperCom second-batch stream-task example.
 *
 * Every capability is behind an explicit sidebar button. Startup does not open
 * a picker, inspect a device, start a process, or send bytes.
 */

var selectedReader = null;
var activeShell = null;

function text(value) {
  return String(value && value.message ? value.message : value);
}

async function panel(message) {
  await self.plugin.api['ui.panel.append']({ text: message + '\n' });
}

function selectedPort(event) {
  var portId = event && event.context && event.context.portId;
  if (typeof portId !== 'string' || !portId) {
    return Promise.reject(new Error('发送动作必须从端口菜单明确选择 portId'));
  }
  return self.plugin.api['ports.status']({ portId: portId }).then(function (port) {
    if (!port || port.id !== portId || port.status !== 'connected' || !Number.isSafeInteger(port.connectionGeneration)) {
      throw new Error('所选端口已断开或没有有效 connectionGeneration: ' + portId);
    }
    return port;
  });
}

async function chooseReader() {
  if (selectedReader) {
    await selectedReader.close().catch(function () {});
    selectedReader = null;
  }
  selectedReader = await self.plugin.fs.openFile({
    title: '选择一个要读取或发送的文件',
    filters: [{ name: '日志或数据', extensions: ['log', 'txt', 'bin'] }],
  });
  return selectedReader;
}

async function readFile() {
  var reader = await chooseReader();
  if (!reader) return panel('[file] 用户取消选择');
  var controller = new AbortController();
  try {
    var length = Math.min(reader.size, 64 * 1024);
    var bytes = await reader.read(0, length, { signal: controller.signal });
    await panel('[file] ' + reader.name + ': ' + bytes.byteLength + '/' + reader.size + ' bytes read');
  } catch (error) {
    await panel('[file] read failed: ' + text(error));
  }
}

async function writeReport() {
  var writer = await self.plugin.fs.createFile({
    title: '保存示例报告',
    defaultFileName: 'stream-task-report.txt',
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  if (!writer) return panel('[file] 用户取消另存为');
  try {
    var bytes = new TextEncoder().encode('HyperCom stream-task example\n');
    await writer.write(bytes);
    var result = await writer.commit();
    await panel('[file] committed ' + result.bytesWritten + ' bytes to ' + writer.name);
  } catch (error) {
    await panel('[file] write/commit failed; do not retry blindly: ' + text(error));
    await writer.close().catch(function () {});
  }
}

async function sendBytes(event) {
  try {
    var port = await selectedPort(event);
    var task = self.plugin.serial.sendBytes({
      portId: port.id,
      expectedConnectionGeneration: port.connectionGeneration,
      bytes: new Uint8Array([0x48, 0x43, 0x2d, 0x32]),
    });
    task.onProgress(function (progress) {
      void panel('[serial] ' + progress.status + ' ' + progress.bytesWritten + '/' + progress.totalBytes);
    });
    var result = await task.done;
    await panel('[serial] bytes result: ' + result.status + ', confirmed=' + result.bytesWritten);
  } catch (error) {
    await panel('[serial] bytes task failed: ' + text(error));
  }
}

async function sendFile(event) {
  if (!selectedReader) return panel('[serial] 先点击“选择并读文件”选择一个文件');
  try {
    var port = await selectedPort(event);
    var task = self.plugin.serial.sendFile({
      portId: port.id,
      expectedConnectionGeneration: port.connectionGeneration,
      handleId: selectedReader.handleId,
    });
    task.onProgress(function (progress) {
      void panel('[serial-file] ' + progress.status + ' ' + progress.bytesWritten + '/' + progress.totalBytes);
    });
    var result = await task.done;
    await panel('[serial-file] result: ' + result.status + ', confirmed=' + result.bytesWritten);
  } catch (error) {
    await panel('[serial-file] task failed: ' + text(error));
  }
}

async function drain(stream, label) {
  var decoder = new TextDecoder();
  for await (var bytes of stream) {
    var chunk = decoder.decode(bytes, { stream: true });
    if (chunk) await panel('[' + label + '] ' + chunk);
  }
  var tail = decoder.decode(); // flush a UTF-8 code point split at EOF
  if (tail) await panel('[' + label + '] ' + tail);
}

async function startTool() {
  if (activeShell) return panel('[shell] a task is already running');
  var task;
  try {
    task = await self.plugin.shell.start(
      { program: 'git', args: ['--version'] },
      { stdout: 'pipe', stderr: 'pipe' },
    );
    activeShell = task;
    await panel('[shell] started; stdout/stderr are drained concurrently');
    var status;
    await Promise.all([
      drain(task.stdout, 'stdout'),
      drain(task.stderr, 'stderr'),
      task.wait().then(function (value) { status = value; }),
    ]);
    await panel('[shell] ' + status.state + ' exit=' + status.exitCode);
  } catch (error) {
    await panel('[shell] failed: ' + text(error));
  } finally {
    if (task) await task.release().catch(function () {});
    if (activeShell === task) activeShell = null;
  }
}

async function cancelTool() {
  if (!activeShell) return panel('[shell] no active task');
  await activeShell.cancel().catch(function (error) { void panel('[shell] cancel failed: ' + text(error)); });
}

self.plugin.on('ui.buttonClick', function (event) {
  if (!event) return;
  var action = {
    'read-file': readFile,
    'write-file': writeReport,
    'send-bytes': sendBytes,
    'send-file': sendFile,
    'start-tool': startTool,
    'cancel-tool': cancelTool,
  }[event.buttonId];
  if (action) void action(event).catch(function (error) { void panel('[example] ' + text(error)); });
});
