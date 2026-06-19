import React, { useRef } from 'react';
import { useOperationStore } from '../../stores/useOperationStore';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { Send, Cable, Eraser } from 'lucide-react';
import type { LineEnding } from '../../types';

export interface SendSectionProps {
  activeTabId: string | null;
  isPortActive: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  isPortError: boolean;
  sendData: (portId: string, data: string, isHex: boolean, lineEnding: string) => Promise<number>;
  toggleConnection: (portId: string) => Promise<void>;
}

const SendSection: React.FC<SendSectionProps> = ({
  activeTabId,
  isPortActive,
  isConnected,
  isConnecting,
  isPortError,
  sendData,
  toggleConnection,
}) => {
  const sendInput = useOperationStore(s => s.sendInput);
  const sendIsHex = useOperationStore(s => s.sendIsHex);
  const sendAppendLineEnding = useOperationStore(s => s.sendAppendLineEnding);
  const setOpState = useOperationStore(s => s.setOpState);
  const clearTerminal = useTerminalStore(s => s.clearTerminal);

  const sendHistoryRef = useRef<{ history: string[]; index: number }>({ history: [], index: -1 });

  const connectButtonLabel = isConnected
    ? '断开串口'
    : isConnecting
    ? '连接中...'
    : isPortError
    ? '重试连接'
    : '打开串口';
  const connectButtonDisabled = !isPortActive || isConnecting;

  const handleSend = async () => {
    if (!isPortActive || !sendInput.trim()) return;
    const hist = sendHistoryRef.current;
    hist.history = hist.history.filter(h => h !== sendInput);
    hist.history.push(sendInput);
    if (hist.history.length > 50) hist.history.shift();
    hist.index = -1;
    await sendData(activeTabId!, sendInput, sendIsHex, sendAppendLineEnding);
    setOpState({ sendInput: '' });
  };

  const handleToggleConnection = async () => {
    if (!activeTabId) return;
    await toggleConnection(activeTabId);
  };

  const handleClear = () => {
    if (!activeTabId) return;
    clearTerminal(activeTabId);
  };

  return (
    <div className="op-section op-section-send">
      <div className="panel-card-title">发送命令 & 基础控制</div>

      <div className="op-send-row">
        <textarea
          className="input op-send-input"
          placeholder={isPortActive ? '输入发送内容...' : '未选择串口'}
          disabled={!isPortActive}
          value={sendInput}
          onChange={e => setOpState({ sendInput: e.target.value })}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleSend();
            } else if (e.key === 'ArrowUp' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              const hist = sendHistoryRef.current;
              if (hist.history.length > 0) {
                if (hist.index === -1 || hist.index >= hist.history.length) {
                  hist.index = hist.history.length - 1;
                } else if (hist.index > 0) {
                  hist.index--;
                }
                setOpState({ sendInput: hist.history[hist.index] });
              }
            } else if (e.key === 'ArrowDown' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              const hist = sendHistoryRef.current;
              if (hist.index >= 0 && hist.index < hist.history.length - 1) {
                hist.index++;
                setOpState({ sendInput: hist.history[hist.index] });
              } else {
                hist.index = -1;
                setOpState({ sendInput: '' });
              }
            }
          }}
        />
        <div className="op-send-actions">
          <button
            className="btn btn-primary op-send-btn"
            disabled={!isPortActive}
            onClick={handleSend}
          >
            <Send size={14} />
            发送
          </button>
          <div className="op-send-options">
            <label className="checkbox-wrapper" style={{ fontSize: 10 }}>
              <input
                type="checkbox"
                checked={sendIsHex}
                onChange={e => setOpState({ sendIsHex: e.target.checked })}
              />
              HEX
            </label>
            <select
              className="select"
              style={{ fontSize: 10, padding: '1px 14px 1px 3px', width: 56 }}
              value={sendAppendLineEnding}
              onChange={e => setOpState({ sendAppendLineEnding: e.target.value as LineEnding })}
            >
              <option value="\\r\\n">\r\n</option>
              <option value="\\r">\r</option>
              <option value="\\n">\n</option>
              <option value="None">无</option>
            </select>
          </div>
        </div>
      </div>

      <div className="op-btn-row">
        <button className="btn" style={{ flex: 1 }} onClick={handleToggleConnection} disabled={connectButtonDisabled}>
          <Cable size={13} /> {connectButtonLabel}
        </button>
        <button className="btn" title="清屏" onClick={handleClear} disabled={!isPortActive}>
          <Eraser size={13} /> 清屏
        </button>
      </div>
    </div>
  );
};

export default SendSection;
