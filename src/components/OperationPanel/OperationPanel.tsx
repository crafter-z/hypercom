/**
 * 操作面板组件 (底部操作区)
 * 横向三栏布局：手动发送 | 自动循环 | 串口参数与视图
 * 支持折叠/展开
 */

import React from 'react';
import { useAppStore } from '../../stores/useAppStore';
import type { DataBits, Parity, StopBits, Handshake, LineEnding } from '../../types';

const OperationPanel: React.FC = () => {
  const {
    activeTabId,
    ui,
    opBaudRate,
    opDataBits,
    opParity,
    opStopBits,
    opHandshake,
    opDtr,
    opRts,
    opIgnoreEmptyChars,
    opScrollLocked,
    opShowTimestamp,
    opDisplayFormat,
    opSendIsHex,
    opSendAppendLineEnding,
    opSendInput,
    opIsLoopSending,
    setOpState,
    setUIState,
    config,
    toggleConfigModal,
    setConfigActiveTab,
  } = useAppStore();

  const isPortActive = !!activeTabId;
  const collapsed = ui.isOperationPanelCollapsed;

  const handleSend = () => {
    if (!isPortActive || !opSendInput.trim()) return;
    // TODO: 调用Tauri命令发送数据
  };

  const openConfigToTab = (tab: string) => {
    setConfigActiveTab(tab);
    toggleConfigModal(true);
  };

  const toggleCollapse = () => {
    setUIState({ isOperationPanelCollapsed: !collapsed });
  };

  return (
    <div
      style={{
        background: 'var(--bg-secondary)',
        borderTop: '1px solid var(--border-color)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        height: collapsed ? 32 : 'var(--operation-panel-height)',
        minHeight: collapsed ? 32 : 200,
        transition: 'height 0.2s ease',
        flexShrink: 0,
      }}
    >
      {/* 标题栏兼折叠按钮 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '4px 12px',
        borderBottom: collapsed ? 'none' : '1px solid var(--border-color)',
        background: 'var(--bg-tertiary)',
        cursor: 'pointer',
        userSelect: 'none',
      }}
        onClick={toggleCollapse}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontSize: 10,
            transition: 'transform 0.2s',
            transform: collapsed ? 'rotate(-90deg)' : 'rotate(90deg)',
          }}>
            ▶
          </span>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>
            操作面板
          </span>
          {isPortActive && (
            <span style={{ fontSize: 11, color: 'var(--text-primary)' }}>{activeTabId}</span>
          )}
        </div>
        {!collapsed && (
          <button
            className="btn btn-icon btn-sm"
            title="收起操作面板"
            onClick={(e) => { e.stopPropagation(); toggleCollapse(); }}
            style={{ fontSize: 14 }}
          >
            ✕
          </button>
        )}
      </div>

      {/* 操作区内容 */}
      {!collapsed && (
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden', padding: '8px 12px', gap: 12 }}>

          {/* ========== 左侧：手动发送与基础控制 ========== */}
          <div style={{ flex: 1.2, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
            <div className="panel-card-title">发送命令 & 基础控制</div>

            {/* 发送输入区 */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', minHeight: 0 }}>
              <textarea
                className="input"
                style={{
                  flex: 1,
                  resize: 'none',
                  fontFamily: 'var(--font-terminal)',
                  fontSize: 13,
                  minHeight: 52,
                }}
                placeholder={isPortActive ? '输入发送内容...' : '未选择串口'}
                disabled={!isPortActive}
                value={opSendInput}
                onChange={(e) => setOpState({ opSendInput: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, justifyContent: 'flex-end' }}>
                <button
                  className="btn btn-primary"
                  style={{ minWidth: 56, padding: '6px 14px', fontSize: 14, fontWeight: 600 }}
                  disabled={!isPortActive}
                  onClick={handleSend}
                >
                  发送
                </button>
                {/* 发送选项 - 紧凑排布 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 10, color: 'var(--text-secondary)' }}>
                  <label className="checkbox-wrapper" style={{ fontSize: 10 }}>
                    <input
                      type="checkbox"
                      checked={opSendIsHex}
                      onChange={(e) => setOpState({ opSendIsHex: e.target.checked })}
                    />
                    HEX
                  </label>
                  <select
                    className="select"
                    style={{ fontSize: 10, padding: '1px 14px 1px 3px', width: 56 }}
                    value={opSendAppendLineEnding}
                    onChange={(e) => setOpState({ opSendAppendLineEnding: e.target.value as LineEnding })}
                  >
                    <option value="\\r\\n">\r\n</option>
                    <option value="\\r">\r</option>
                    <option value="\\n">\n</option>
                    <option value="None">无</option>
                  </select>
                </div>
              </div>
            </div>

            {/* 基础控制按钮 */}
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn" style={{ flex: 1 }}>
                {isPortActive ? '断开串口' : '打开串口'}
              </button>
              <button className="btn" title="清空终端显示内容">清屏</button>
            </div>
          </div>

          <div className="divider" style={{ margin: '0 4px' }} />

          {/* ========== 中间：自动循环与规则应用 ========== */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
            <div className="panel-card-title">循环发送 & 规则</div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', minWidth: 56 }}>高亮规则:</span>
                <select className="select" style={{ flex: 1, fontSize: 11, padding: '2px 16px 2px 4px' }}>
                  <option>默认规则集</option>
                </select>
                <button className="btn btn-icon btn-sm" title="编辑高亮规则" onClick={() => openConfigToTab('highlight')}>
                  ⚙
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', minWidth: 56 }}>命令集:</span>
                <select className="select" style={{ flex: 1, fontSize: 11, padding: '2px 16px 2px 4px' }}>
                  <option>AT指令集</option>
                </select>
                <button className="btn btn-icon btn-sm" title="编辑发送命令" onClick={() => openConfigToTab('commands')}>
                  ✎
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              {!opIsLoopSending ? (
                <button
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  disabled={!isPortActive}
                  onClick={() => setOpState({ opIsLoopSending: true })}
                >
                  ▶ 开始循环发送
                </button>
              ) : (
                <button
                  className="btn"
                  style={{ flex: 1, color: 'var(--text-error)' }}
                  onClick={() => setOpState({ opIsLoopSending: false })}
                >
                  ⏹ 停止发送
                </button>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>间隔:</span>
                <input
                  className="input"
                  type="number"
                  style={{ width: 56, fontSize: 11, textAlign: 'center' }}
                  defaultValue={500}
                  min={0}
                  step={10}
                />
                <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>ms</span>
              </div>
            </div>

            <div style={{ marginTop: 'auto', display: 'flex', gap: 6 }}>
              <button className="btn btn-sm" style={{ flex: 1 }}>HEX/文本</button>
              <button className="btn btn-sm" style={{ flex: 1 }}>日志文件</button>
            </div>
          </div>

          <div className="divider" style={{ margin: '0 4px' }} />

          {/* ========== 右侧：串口参数与视图控制 ========== */}
          <div style={{ flex: 1.3, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
            <div className="panel-card-title">视图 & 日志 & 参数</div>

            {/* 视图控制 */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
              <label className="checkbox-wrapper">
                <input
                  type="checkbox"
                  checked={opScrollLocked}
                  onChange={(e) => setOpState({ opScrollLocked: e.target.checked })}
                />
                滚动锁定
              </label>
              <label className="checkbox-wrapper">
                <input
                  type="checkbox"
                  checked={opShowTimestamp}
                  onChange={(e) => setOpState({ opShowTimestamp: e.target.checked })}
                />
                时间戳
              </label>
            </div>

            {/* 显示格式 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>显示:</span>
              <label className="checkbox-wrapper">
                <input
                  type="radio"
                  name="displayFormat"
                  checked={opDisplayFormat === 'hex'}
                  onChange={() => setOpState({ opDisplayFormat: 'hex' })}
                />
                HEX
              </label>
              <label className="checkbox-wrapper">
                <input
                  type="radio"
                  name="displayFormat"
                  checked={opDisplayFormat === 'string'}
                  onChange={() => setOpState({ opDisplayFormat: 'string' })}
                />
                文本
              </label>
            </div>

            {/* 日志操作 */}
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-sm" style={{ flex: 1 }}>另存为</button>
              <button className="btn btn-sm" style={{ flex: 1 }}>打开文件</button>
              <button className="btn btn-sm" style={{ flex: 1 }}>打开目录</button>
            </div>

            <div className="divider-h" />

            {/* 串口参数 */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', minWidth: 44 }}>波特率:</span>
                <select
                  className="select"
                  style={{ flex: 1, fontSize: 11, padding: '2px 14px 2px 4px' }}
                  value={opBaudRate}
                  onChange={(e) => setOpState({ opBaudRate: Number(e.target.value) })}
                >
                  {config.defaultBaudRates.map(rate => (
                    <option key={rate} value={rate}>{rate}</option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', minWidth: 44 }}>数据位:</span>
                <select
                  className="select"
                  style={{ flex: 1, fontSize: 11, padding: '2px 14px 2px 4px' }}
                  value={opDataBits}
                  onChange={(e) => setOpState({ opDataBits: Number(e.target.value) as DataBits })}
                >
                  <option value={5}>5</option>
                  <option value={6}>6</option>
                  <option value={7}>7</option>
                  <option value={8}>8</option>
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', minWidth: 44 }}>校验:</span>
                <select
                  className="select"
                  style={{ flex: 1, fontSize: 11, padding: '2px 14px 2px 4px' }}
                  value={opParity}
                  onChange={(e) => setOpState({ opParity: e.target.value as Parity })}
                >
                  <option>None</option>
                  <option>Even</option>
                  <option>Odd</option>
                  <option>Mark</option>
                  <option>Space</option>
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', minWidth: 44 }}>停止位:</span>
                <select
                  className="select"
                  style={{ flex: 1, fontSize: 11, padding: '2px 14px 2px 4px' }}
                  value={opStopBits}
                  onChange={(e) => setOpState({ opStopBits: e.target.value as StopBits })}
                >
                  <option value="One">1</option>
                  <option value="OnePointFive">1.5</option>
                  <option value="Two">2</option>
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 4, gridColumn: '1 / -1' }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', minWidth: 44 }}>握手:</span>
                <select
                  className="select"
                  style={{ flex: 1, fontSize: 11, padding: '2px 14px 2px 4px' }}
                  value={opHandshake}
                  onChange={(e) => setOpState({ opHandshake: e.target.value as Handshake })}
                >
                  <option value="None">None</option>
                  <option value="XonXoff">Xon/Xoff</option>
                  <option value="RequestToSend">RTS/CTS</option>
                  <option value="RequestToSendXonXoff">RTS/CTS+Xon/Xoff</option>
                </select>
              </div>
            </div>

            {/* DTR / RTS / 忽略空字符 */}
            <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
              <label className="checkbox-wrapper">
                <input
                  type="checkbox"
                  checked={opDtr}
                  onChange={(e) => setOpState({ opDtr: e.target.checked })}
                />
                DTR
              </label>
              <label className="checkbox-wrapper">
                <input
                  type="checkbox"
                  checked={opRts}
                  onChange={(e) => setOpState({ opRts: e.target.checked })}
                />
                RTS
              </label>
              <label className="checkbox-wrapper" style={{ fontSize: 11 }}>
                <input
                  type="checkbox"
                  checked={opIgnoreEmptyChars}
                  onChange={(e) => setOpState({ opIgnoreEmptyChars: e.target.checked })}
                />
                忽略空字符
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default OperationPanel;
