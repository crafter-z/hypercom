import React, { useEffect, useRef } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useSerialData, useSerialConnection } from '../../hooks/useTauri';
import { serialService } from '../../services/tauri';
import type { DataBits, Parity, StopBits, Handshake, LineEnding } from '../../types';
import {
  Send, Cable, Eraser, Pin, Clock,
  FileText, FolderOpen, FileSearch, Settings,
  ChevronDown, ChevronUp, Play, Square, Edit3,
  ToggleLeft, ToggleRight
} from 'lucide-react';

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
    opLoopInterval,
    sendCommandSets,
    activeSendCommandSetId,
    highlightRuleSets,
    activeHighlightSetId,
    setOpState,
    setUIState,
    clearTerminal,
    config,
    toggleConfigModal,
    setConfigActiveTab,
    setActiveSendCommandSetId,
    setActiveHighlightSetId,
  } = useAppStore();

  const { sendData } = useSerialData();
  const { toggleConnection } = useSerialConnection();

  const activePort = useAppStore((s) => s.ports.find((p) => p.id === s.activeTabId));
  const isConnected = activePort?.status === 'connected';

  const isPortActive = !!activeTabId;
  const collapsed = ui.isOperationPanelCollapsed;

  const prevParamsRef = useRef(`${opBaudRate}-${opDataBits}-${opParity}-${opStopBits}-${opHandshake}-${opDtr}-${opRts}`);
  const loopRef = useRef<{ timeoutId: ReturnType<typeof setTimeout> | null; currentCmdIdx: number; stopped: boolean }>({
    timeoutId: null,
    currentCmdIdx: 0,
    stopped: false,
  });

  useEffect(() => {
    if (!activeTabId || !isConnected) return;
    const key = `${opBaudRate}-${opDataBits}-${opParity}-${opStopBits}-${opHandshake}-${opDtr}-${opRts}`;
    if (key !== prevParamsRef.current) {
      prevParamsRef.current = key;
      serialService.setSerialParams(activeTabId, {
        baudRate: opBaudRate,
        dataBits: opDataBits,
        parity: opParity,
        stopBits: opStopBits,
        handshake: opHandshake,
      }).catch(() => {});
      serialService.setFlowControl(activeTabId, opDtr, opRts).catch(() => {});
    }
  }, [activeTabId, isConnected, opBaudRate, opDataBits, opParity, opStopBits, opHandshake, opDtr, opRts]);

  // Cyclic send logic
  useEffect(() => {
    const ref = loopRef.current;
    if (!opIsLoopSending || !isPortActive || !isConnected) {
      ref.stopped = true;
      if (ref.timeoutId) { clearTimeout(ref.timeoutId); ref.timeoutId = null; }
      return;
    }

    const activeSet = sendCommandSets.find(s => s.id === activeSendCommandSetId);
    if (!activeSet || activeSet.commands.length === 0) {
      setOpState({ opIsLoopSending: false });
      return;
    }

    ref.stopped = false;
    ref.currentCmdIdx = 0;

    const sendNext = async () => {
      if (ref.stopped || !activeTabId) return;
      const store = useAppStore.getState();
      const currentSet = store.sendCommandSets.find(s => s.id === store.activeSendCommandSetId);
      if (!currentSet || currentSet.commands.length === 0) {
        setOpState({ opIsLoopSending: false });
        return;
      }
      const cmd = currentSet.commands[ref.currentCmdIdx % currentSet.commands.length];

      try {
        await sendData(
          activeTabId,
          cmd.content,
          cmd.type === 'hex',
          cmd.appendLineEnding
        );

        const nextIdx = ref.currentCmdIdx + 1;
        if (nextIdx >= currentSet.commands.length) {
          // Completed one full loop
          if (!currentSet.isLoop) {
            setOpState({ opIsLoopSending: false });
            ref.stopped = true;
            return;
          }
        }
        ref.currentCmdIdx = nextIdx;

        const delay = currentSet.isLoop && nextIdx >= currentSet.commands.length
          ? (currentSet.loopDelay || opLoopInterval)
          : cmd.delay ?? opLoopInterval;

        ref.timeoutId = setTimeout(sendNext, delay);
      } catch {
        // Send failed, continue
        ref.timeoutId = setTimeout(sendNext, opLoopInterval);
      }
    };

    ref.timeoutId = setTimeout(sendNext, 100);
    return () => {
      ref.stopped = true;
      if (ref.timeoutId) { clearTimeout(ref.timeoutId); ref.timeoutId = null; }
    };
  }, [opIsLoopSending, isPortActive, isConnected, activeSendCommandSetId, opLoopInterval, sendCommandSets, activeTabId, sendData, setOpState]);

  const handleSend = async () => {
    if (!isPortActive || !opSendInput.trim()) return;
    await sendData(activeTabId!, opSendInput, opSendIsHex, opSendAppendLineEnding);
    setOpState({ opSendInput: '' });
  };

  const handleToggleConnection = async () => {
    if (!activeTabId) return;
    await toggleConnection(activeTabId);
  };

  const handleClear = () => {
    if (!activeTabId) return;
    clearTerminal(activeTabId);
  };

  const openConfigToTab = (tab: string) => {
    setConfigActiveTab(tab);
    toggleConfigModal(true);
  };

  const toggleCollapse = () => {
    setUIState({ isOperationPanelCollapsed: !collapsed });
  };

  const toggleDisplayFormat = () => {
    setOpState({ opDisplayFormat: opDisplayFormat === 'hex' ? 'string' : 'hex' });
  };

  const handleToggleLoop = () => {
    if (opIsLoopSending) {
      setOpState({ opIsLoopSending: false });
    } else {
      if (!sendCommandSets.find(s => s.id === activeSendCommandSetId)) {
        // Auto-select first available set
        if (sendCommandSets.length > 0) {
          setActiveSendCommandSetId(sendCommandSets[0].id);
        }
      }
      setOpState({ opIsLoopSending: true });
    }
  };

  return (
    <div className={`operation-panel${collapsed ? ' collapsed' : ''}`}>
      <div className="operation-panel-header" onClick={toggleCollapse}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {collapsed ? (
            <ChevronDown size={12} style={{ transition: 'transform 0.2s' }} />
          ) : (
            <ChevronUp size={12} style={{ transition: 'transform 0.2s' }} />
          )}
          <span className="operation-panel-title">操作面板</span>
          {isPortActive && (
            <span className="operation-panel-port">{activeTabId}</span>
          )}
        </div>
        {!collapsed && (
          <button
            className="btn btn-icon btn-sm"
            title="收起"
            onClick={(e) => { e.stopPropagation(); toggleCollapse(); }}
          >
            <ChevronDown size={14} />
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="operation-panel-content">
          <div className="op-section op-section-send">
            <div className="panel-card-title">发送命令 & 基础控制</div>

            <div className="op-send-row">
              <textarea
                className="input op-send-input"
                placeholder={isPortActive ? '输入发送内容...' : '未选择串口'}
                disabled={!isPortActive}
                value={opSendInput}
                onChange={(e) => setOpState({ opSendInput: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    handleSend();
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

            <div className="op-btn-row">
              <button className="btn" style={{ flex: 1 }} onClick={handleToggleConnection} disabled={!isPortActive}>
                {isConnected ? <><Cable size={13} /> 断开串口</> : <><Cable size={13} /> 打开串口</>}
              </button>
              <button className="btn" title="清屏" onClick={handleClear} disabled={!isPortActive}><Eraser size={13} /> 清屏</button>
            </div>
          </div>

          <div className="divider" style={{ margin: '0 4px' }} />

          <div className="op-section op-section-rules">
            <div className="panel-card-title">循环发送 & 规则</div>

            <div className="op-rule-row">
              <span className="op-label">高亮规则:</span>
              <select
                className="select op-rule-select"
                value={activeHighlightSetId || ''}
                onChange={(e) => setActiveHighlightSetId(e.target.value || null)}
              >
                <option value="">默认</option>
                {highlightRuleSets.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <button className="btn btn-icon btn-sm" title="编辑高亮规则" onClick={() => openConfigToTab('highlight')}>
                <Settings size={12} />
              </button>
            </div>

            <div className="op-rule-row">
              <span className="op-label">命令集:</span>
              <select
                className="select op-rule-select"
                value={activeSendCommandSetId || ''}
                onChange={(e) => setActiveSendCommandSetId(e.target.value || null)}
              >
                <option value="">无</option>
                {sendCommandSets.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <button className="btn btn-icon btn-sm" title="编辑发送命令" onClick={() => openConfigToTab('commands')}>
                <Edit3 size={12} />
              </button>
            </div>

            <div className="op-loop-row">
              {!opIsLoopSending ? (
                <button
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  disabled={!isPortActive || !activeSendCommandSetId}
                  onClick={handleToggleLoop}
                >
                  <Play size={13} /> 开始循环
                </button>
              ) : (
                <button
                  className="btn btn-danger"
                  style={{ flex: 1 }}
                  onClick={handleToggleLoop}
                >
                  <Square size={13} /> 停止发送
                </button>
              )}
              <div className="op-delay-input">
                <span className="op-label">间隔:</span>
                <input
                  className="input"
                  type="number"
                  style={{ width: 56, fontSize: 11, textAlign: 'center' }}
                  value={opLoopInterval}
                  onChange={(e) => setOpState({ opLoopInterval: Number(e.target.value) || 500 })}
                  min={0}
                  step={10}
                />
                <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>ms</span>
              </div>
            </div>

            <div className="op-btn-row" style={{ marginTop: 'auto' }}>
              <button className="btn btn-sm" style={{ flex: 1 }} onClick={toggleDisplayFormat} title={opDisplayFormat === 'hex' ? '切换为文本显示' : '切换为HEX显示'}>
                {opDisplayFormat === 'hex' ? <><ToggleRight size={12} /> 文本</> : <><ToggleLeft size={12} /> HEX</>}
              </button>
              <button className="btn btn-sm" style={{ flex: 1 }} disabled={!isPortActive} title="日志操作">
                <FileText size={12} /> 日志
              </button>
            </div>
          </div>

          <div className="divider" style={{ margin: '0 4px' }} />

          <div className="op-section op-section-params">
            <div className="panel-card-title">视图 & 日志 & 参数</div>

            <div className="op-checkbox-row">
              <label className="checkbox-wrapper">
                <input
                  type="checkbox"
                  checked={opScrollLocked}
                  onChange={(e) => setOpState({ opScrollLocked: e.target.checked })}
                />
                <Pin size={12} /> 滚动锁定
              </label>
              <label className="checkbox-wrapper">
                <input
                  type="checkbox"
                  checked={opShowTimestamp}
                  onChange={(e) => setOpState({ opShowTimestamp: e.target.checked })}
                />
                <Clock size={12} /> 时间戳
              </label>
            </div>

            <div className="op-radio-row">
              <span className="op-label">显示:</span>
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

            <div className="op-btn-row">
              <button className="btn btn-sm" style={{ flex: 1 }} disabled={!isPortActive}><FileText size={12} /> 另存为</button>
              <button className="btn btn-sm" style={{ flex: 1 }} disabled={!isPortActive}><FolderOpen size={12} /> 打开文件</button>
              <button className="btn btn-sm" style={{ flex: 1 }} disabled={!isPortActive}><FileSearch size={12} /> 目录</button>
            </div>

            <div className="divider-h" />

            <div className="op-params-grid">
              <div className="op-param-item">
                <span className="op-label">波特率:</span>
                <select className="select op-param-select" value={opBaudRate} onChange={(e) => setOpState({ opBaudRate: Number(e.target.value) })}>
                  {config.defaultBaudRates.map(rate => <option key={rate} value={rate}>{rate}</option>)}
                </select>
              </div>
              <div className="op-param-item">
                <span className="op-label">数据位:</span>
                <select className="select op-param-select" value={opDataBits} onChange={(e) => setOpState({ opDataBits: Number(e.target.value) as DataBits })}>
                  <option value={5}>5</option>
                  <option value={6}>6</option>
                  <option value={7}>7</option>
                  <option value={8}>8</option>
                </select>
              </div>
              <div className="op-param-item">
                <span className="op-label">校验:</span>
                <select className="select op-param-select" value={opParity} onChange={(e) => setOpState({ opParity: e.target.value as Parity })}>
                  <option>None</option>
                  <option>Even</option>
                  <option>Odd</option>
                  <option>Mark</option>
                  <option>Space</option>
                </select>
              </div>
              <div className="op-param-item">
                <span className="op-label">停止位:</span>
                <select className="select op-param-select" value={opStopBits} onChange={(e) => setOpState({ opStopBits: e.target.value as StopBits })}>
                  <option value="One">1</option>
                  <option value="OnePointFive">1.5</option>
                  <option value="Two">2</option>
                </select>
              </div>
              <div className="op-param-item" style={{ gridColumn: '1 / -1' }}>
                <span className="op-label">握手:</span>
                <select className="select op-param-select" value={opHandshake} onChange={(e) => setOpState({ opHandshake: e.target.value as Handshake })}>
                  <option value="None">None</option>
                  <option value="XonXoff">Xon/Xoff</option>
                  <option value="RequestToSend">RTS/CTS</option>
                  <option value="RequestToSendXonXoff">RTS/CTS+Xon/Xoff</option>
                </select>
              </div>
            </div>

            <div className="op-checkbox-row" style={{ marginTop: 4 }}>
              <label className="checkbox-wrapper"><input type="checkbox" checked={opDtr} onChange={(e) => setOpState({ opDtr: e.target.checked })} /> DTR</label>
              <label className="checkbox-wrapper"><input type="checkbox" checked={opRts} onChange={(e) => setOpState({ opRts: e.target.checked })} /> RTS</label>
              <label className="checkbox-wrapper" style={{ fontSize: 11 }}><input type="checkbox" checked={opIgnoreEmptyChars} onChange={(e) => setOpState({ opIgnoreEmptyChars: e.target.checked })} /> 忽略空字符</label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default OperationPanel;