/*
 * HyperCom 示例插件（issue #17）。
 *
 * 加载：宿主读本文件文本 → Blob URL → Web Worker。**必须是普通脚本**
 * （无 ESM import/require；`self.plugin` 由宿主注入的桥提供）。
 *
 * 桥 API（单层代理——op 名含点号必须用方括号访问）：
 *   plugin.api['terminal.append']({ portId, text })
 *   plugin.api['serial.send']({ portId, data })
 *   plugin.api.ports.list()
 * 事件：plugin.on('rx.line' | 'rx.detached' | 'ui.buttonClick' | 'lifecycle', cb)
 */

var lineCount = 0;

self.plugin.on('rx.line', function (lines) {
  for (var i = 0; i < lines.length; i++) {
    lineCount++;
    var text = new TextDecoder().decode(lines[i].rawData);
    // 用例①：行匹配 → terminal.append 写 NOTE 旁注（零侵入：原始行保留）。
    if (text.indexOf('PING') !== -1) {
      self.plugin.api['terminal.append']({
        portId: lines[i].portId,
        text: 'PONG<' + text.trim() + '>',
      });
    }
  }
});

// TRX→TTY 切换（reason=mode-tty）与端口断线（reason=port-disconnected）
// 都会收到 rx.detached——插件应提示用户该端口观察已断流。
self.plugin.on('rx.detached', function (e) {
  self.plugin.api['terminal.append']({
    portId: e.portId,
    text: '[demo] RX 观察断流: ' + e.reason,
  });
});

// 用例②：声明式 UI 按钮 → 宿主推送 ui.buttonClick。
self.plugin.on('ui.buttonClick', function (payload) {
  self.plugin.api['terminal.append']({
    portId: (payload && payload.context && payload.context.portId) || '',
    text: '[demo] 已观察 ' + lineCount + ' 行 RX（按钮 ' + ((payload && payload.buttonId) || '?') + '）',
  });
});

// 用例③：serial 作用域演示——manifest 声明 portWhitelist: ["COM9"]，
// 对白名单外端口发送会被桥拒绝（reject），这里捕获后写旁注说明。
self.plugin.on('lifecycle', function (e) {
  if (e && e.state === 'enabled') {
    self.plugin.api['serial.send']({ portId: 'COM1', data: 'demo-handshake' })
      .then(function () {
        // 不可能出现（e2e/演示环境 COM1 不在白名单内；真实白名单端口则正常发送）
      })
      .catch(function (err) {
        self.plugin.api['terminal.append']({
          portId: 'COM1',
          text: '[demo] serial.send 被端口作用域拒绝: ' + (err && err.message ? err.message : err),
        });
      });
  }
});
