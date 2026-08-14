import { describe, it, expect, beforeEach } from 'vitest';
import { useOperationStore } from './useOperationStore';

beforeEach(() => {
  useOperationStore.setState({
    baudRate: 115200,
    dataBits: 8,
    parity: 'None',
    stopBits: 'One',
    handshake: 'None',
    dtr: false,
    rts: false,
    ignoreEmptyChars: false,
    sendIsHex: false,
    sendAppendLineEnding: '\\r\\n',
    sendInput: '',
    cyclicLoops: {},
  });
});

// ==================== Defaults ====================

describe('Operation store defaults', () => {
  it('has correct baudRate default', () => {
    expect(useOperationStore.getState().baudRate).toBe(115200);
  });

  it('has correct dataBits default', () => {
    expect(useOperationStore.getState().dataBits).toBe(8);
  });

  it('has correct parity default', () => {
    expect(useOperationStore.getState().parity).toBe('None');
  });

  it('has correct stopBits default', () => {
    expect(useOperationStore.getState().stopBits).toBe('One');
  });

  it('has correct handshake default', () => {
    expect(useOperationStore.getState().handshake).toBe('None');
  });

  it('has correct dtr/rts defaults (false)', () => {
    const s = useOperationStore.getState();
    expect(s.dtr).toBe(false);
    expect(s.rts).toBe(false);
  });

  it('has correct ignoreEmptyChars default (false)', () => {
    expect(useOperationStore.getState().ignoreEmptyChars).toBe(false);
  });

  it('has correct sendIsHex default (false)', () => {
    expect(useOperationStore.getState().sendIsHex).toBe(false);
  });

  it('has correct sendAppendLineEnding default', () => {
    expect(useOperationStore.getState().sendAppendLineEnding).toBe('\\r\\n');
  });

  it('has correct sendInput default (empty string)', () => {
    expect(useOperationStore.getState().sendInput).toBe('');
  });

  it('has empty cyclicLoops default ({} — per-port loop flags)', () => {
    expect(useOperationStore.getState().cyclicLoops).toEqual({});
  });
});

// ==================== setOpState ====================

describe('setOpState', () => {
  it('patches a single field (baudRate) and preserves others', () => {
    useOperationStore.getState().setOpState({ baudRate: 9600 });
    const s = useOperationStore.getState();
    expect(s.baudRate).toBe(9600);
    // Unchanged fields
    expect(s.dataBits).toBe(8);
    expect(s.parity).toBe('None');
    expect(s.stopBits).toBe('One');
    expect(s.handshake).toBe('None');
    expect(s.dtr).toBe(false);
    expect(s.rts).toBe(false);
  });

  it('patches multiple fields at once', () => {
    useOperationStore.getState().setOpState({
      baudRate: 38400,
      dataBits: 7,
      parity: 'Even',
      dtr: true,
    });
    const s = useOperationStore.getState();
    expect(s.baudRate).toBe(38400);
    expect(s.dataBits).toBe(7);
    expect(s.parity).toBe('Even');
    expect(s.dtr).toBe(true);
    // Unchanged
    expect(s.stopBits).toBe('One');
    expect(s.rts).toBe(false);
  });

  it('patches send-mode fields', () => {
    useOperationStore.getState().setOpState({
      sendIsHex: true,
      sendAppendLineEnding: '\\n',
      sendInput: 'AA BB CC',
    });
    const s = useOperationStore.getState();
    expect(s.sendIsHex).toBe(true);
    expect(s.sendAppendLineEnding).toBe('\\n');
    expect(s.sendInput).toBe('AA BB CC');
  });

  it('patches handshake and stopBits', () => {
    useOperationStore.getState().setOpState({
      handshake: 'RequestToSend',
      stopBits: 'Two',
    });
    const s = useOperationStore.getState();
    expect(s.handshake).toBe('RequestToSend');
    expect(s.stopBits).toBe('Two');
  });

  it('patches rts and ignoreEmptyChars', () => {
    useOperationStore.getState().setOpState({
      rts: true,
      ignoreEmptyChars: true,
    });
    const s = useOperationStore.getState();
    expect(s.rts).toBe(true);
    expect(s.ignoreEmptyChars).toBe(true);
  });

  it('empty patch is a no-op', () => {
    const before = { ...useOperationStore.getState() };
    useOperationStore.getState().setOpState({});
    const after = useOperationStore.getState();
    expect(after.baudRate).toBe(before.baudRate);
    expect(after.dataBits).toBe(before.dataBits);
    expect(after.parity).toBe(before.parity);
  });
});

// ==================== setCyclicLoop（每端口循环开关，issue #12）====================

describe('setCyclicLoop', () => {
  it('enables a loop for a port', () => {
    useOperationStore.getState().setCyclicLoop('COM3', true);
    expect(useOperationStore.getState().cyclicLoops['COM3']).toBe(true);
  });

  it('disables a loop for a port (removes key)', () => {
    useOperationStore.getState().setCyclicLoop('COM3', true);
    useOperationStore.getState().setCyclicLoop('COM3', false);
    expect(useOperationStore.getState().cyclicLoops['COM3']).toBeUndefined();
  });

  it('keeps per-port loops independent — multiple ports can run concurrently', () => {
    // 压测场景核心：COM3 循环运行期间启动 COM4 循环，两者互不影响。
    useOperationStore.getState().setCyclicLoop('COM3', true);
    useOperationStore.getState().setCyclicLoop('COM4', true);
    expect(useOperationStore.getState().cyclicLoops['COM3']).toBe(true);
    expect(useOperationStore.getState().cyclicLoops['COM4']).toBe(true);
    // 停止 COM4 不影响 COM3
    useOperationStore.getState().setCyclicLoop('COM4', false);
    expect(useOperationStore.getState().cyclicLoops['COM3']).toBe(true);
    expect(useOperationStore.getState().cyclicLoops['COM4']).toBeUndefined();
  });

  it('is a no-op for empty port id', () => {
    useOperationStore.getState().setCyclicLoop('', true);
    expect(useOperationStore.getState().cyclicLoops).toEqual({});
  });
});
