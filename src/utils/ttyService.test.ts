/**
 * ttyService — TTY 模式模块单例测试（issue #11）。
 *
 * 覆盖（不依赖真实 xterm 实例，用 `{ write: vi.fn(), clear: vi.fn() }` mock）：
 * 1. 流式 UTF-8 解码：多字节字符跨两次 feed 分片能拼回完整字符；
 * 2. attach 后 feed → 批写（visibility-aware 调度 → node 环境走 setTimeout 兜底）；
 * 3. 队列上限：未 attach 时入队不丢、超 MAX_TTY_QUEUE 丢最旧；
 * 4. disconnect 同步 flush 且保留 term（视图跨重连挂载）；
 * 5. send 走 serialService 并更新流量统计；失败仅 console.error；
 * 6. resize 仅对 GIT: 端口路由到后端 pty resize。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { useAppStore } from '../stores/useAppStore';
import { serialService, gitBashSimService } from '../services/tauri';
import { ttyService, MAX_TTY_QUEUE } from './ttyService';
import type { Terminal } from '@xterm/xterm';

vi.mock('../services/tauri', () => ({
  serialService: {
    listAvailablePorts: vi.fn(),
    sendSerialData: vi.fn(),
  },
  gitBashSimService: {
    enableGitBashSim: vi.fn(),
    disableGitBashSim: vi.fn(),
    resizeGitBashSim: vi.fn(async () => {}),
  },
}));

/** 最小可用的 xterm mock（ttyService 只用到 write/clear）。 */
const mockTerm = (): { term: Terminal; write: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> } => {
  const write = vi.fn();
  const clear = vi.fn();
  return { term: { write, clear } as unknown as Terminal, write, clear };
};

describe('ttyService — streaming UTF-8 decode', () => {
  it('decodes a whole multi-byte char fed in one call', () => {
    const { term, write } = mockTerm();
    ttyService.attach('P1', term);
    // 你 = E4 BD A0（UTF-8 3 字节）
    ttyService.feed('P1', [0xe4, 0xbd, 0xa0]);
    vi.advanceTimersByTime(16);
    expect(write).toHaveBeenCalledWith('你');
    ttyService.detach('P1');
  });

  it('reassembles a multi-byte char split across two feeds', () => {
    const { term, write } = mockTerm();
    ttyService.attach('P1', term);
    ttyService.feed('P1', [0xe4]); // 首字节：解码器缓冲，无输出
    ttyService.feed('P1', [0xbd, 0xa0]); // 剩余字节：拼回完整字符
    vi.advanceTimersByTime(16);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('你');
    ttyService.detach('P1');
  });

  it('unknown bytes decode as U+FFFD without throwing', () => {
    const { term, write } = mockTerm();
    ttyService.attach('P1', term);
    ttyService.feed('P1', [0xff, 0xfe]);
    vi.advanceTimersByTime(16);
    expect(write).toHaveBeenCalled();
    ttyService.detach('P1');
  });
});

describe('ttyService — batched write', () => {
  it('writes decoded text to the attached term', () => {
    const { term, write } = mockTerm();
    ttyService.attach('P1', term);
    ttyService.feed('P1', [0x68, 0x69]); // 'hi'
    vi.advanceTimersByTime(16);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('hi');
    ttyService.detach('P1');
  });

  it('batches multiple feeds into one write', () => {
    const { term, write } = mockTerm();
    ttyService.attach('P1', term);
    ttyService.feed('P1', [0x68]); // 'h'
    ttyService.feed('P1', [0x69]); // 'i'
    ttyService.feed('P1', [0x21]); // '!'
    vi.advanceTimersByTime(16);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('hi!');
    ttyService.detach('P1');
  });

  it('ignores empty byte payloads', () => {
    const { term, write } = mockTerm();
    ttyService.attach('P1', term);
    ttyService.feed('P1', []);
    vi.advanceTimersByTime(16);
    expect(write).not.toHaveBeenCalled();
    ttyService.detach('P1');
  });
});

describe('ttyService — queue cap before attach', () => {
  it('buffers into the queue while unattached, replaying on attach', () => {
    // 未 attach：term 为 null → 只入队不调度
    for (let i = 0; i < 3; i++) ttyService.feed('P1', [0x41]); // 'AAA'
    expect(ttyService.get('P1')?.queue).toEqual(['A', 'A', 'A']);
    const { term, write } = mockTerm();
    ttyService.attach('P1', term);
    // attach 时一次性 replay
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('AAA');
    expect(ttyService.get('P1')?.queue).toEqual([]);
    ttyService.detach('P1');
  });

  it('drops the oldest entries beyond MAX_TTY_QUEUE', () => {
    // 前 5 条 'X'（最旧），随后灌满队列 'Y'
    for (let i = 0; i < 5; i++) ttyService.feed('P1', [0x58]);
    for (let i = 0; i < MAX_TTY_QUEUE; i++) ttyService.feed('P1', [0x59]);
    const state = ttyService.get('P1');
    expect(state?.queue.length).toBe(MAX_TTY_QUEUE);
    const { term, write } = mockTerm();
    ttyService.attach('P1', term);
    const written = write.mock.calls[0][0] as string;
    expect(written.length).toBe(MAX_TTY_QUEUE);
    expect(written).toContain('Y');
    expect(written).not.toContain('X'); // 最旧的 X 已被丢弃
    ttyService.detach('P1');
  });
});

describe('ttyService — disconnect / clear', () => {
  it('flushes pending queue on disconnect but keeps the term alive', () => {
    const { term, write } = mockTerm();
    ttyService.attach('P1', term);
    ttyService.feed('P1', [0x68, 0x69]); // 'hi'（有 pending 批写）
    ttyService.disconnect('P1');
    // 同步 flush 队列；保留端口状态与 term（视图跨重连挂载）
    expect(write).toHaveBeenCalledWith('hi');
    expect(ttyService.get('P1')?.term).toBe(term);
    expect(ttyService.get('P1')?.queue).toEqual([]);
    ttyService.detach('P1');
  });

  it('drops the queue on disconnect while keeping the (unattached) state', () => {
    ttyService.feed('P1', [0x68, 0x69]);
    ttyService.disconnect('P1');
    // 状态保留（视图跨重连挂载），队列清空、term 仍为 null
    const state = ttyService.get('P1');
    expect(state).toBeDefined();
    expect(state?.queue).toEqual([]);
    expect(state?.term).toBeNull();
  });

  it('clear() calls term.clear()', () => {
    const { term, clear } = mockTerm();
    ttyService.attach('P1', term);
    ttyService.clear('P1');
    expect(clear).toHaveBeenCalled();
    ttyService.detach('P1');
  });

  it('disconnect resets the streaming decoder (stale partial char cannot corrupt the next connection)', () => {
    const { term, write } = mockTerm();
    ttyService.attach('P1', term);
    ttyService.feed('P1', [0xe4]); // 多字节字符首字节：解码器缓冲，无输出
    ttyService.disconnect('P1'); // 断线：解码器重建
    ttyService.feed('P1', [0x41]); // 重连后新流的首字节 'A'——若解码器未重建，
    // 0xe4 会与 0x41 拼成残缺序列输出 U+FFFD，而非干净的 'A'
    vi.advanceTimersByTime(16);
    expect(write).toHaveBeenCalledWith('A');
    ttyService.detach('P1');
  });

  it('detach preserves lastCols/lastRows for re-open but drops queue/term/decoder', () => {
    const { term } = mockTerm();
    ttyService.attach('P1', term);
    ttyService.resize('P1', 100, 30);
    ttyService.feed('P1', [0x68, 0x69]); // 'hi' 入队（有 pending 批写）
    ttyService.detach('P1');
    const state = ttyService.get('P1');
    // 尺寸保留：同端口再次挂载/打开 GIT:BASH 时以正确尺寸 spawn pty
    expect(state?.lastCols).toBe(100);
    expect(state?.lastRows).toBe(30);
    // Terminal 由视图拥有并 dispose；队列/解码器丢弃，不污染下次挂载
    expect(state?.term).toBeNull();
    expect(state?.queue).toEqual([]);
    expect(state?.decoder).toBeNull();
  });
});

describe('ttyService — send (TX path)', () => {
  it('encodes UTF-8 and routes through serialService, updating traffic stats', async () => {
    vi.mocked(serialService.sendSerialData).mockResolvedValue(2);
    await ttyService.send('COM1', 'ab');
    expect(serialService.sendSerialData).toHaveBeenCalledWith({
      port_id: 'COM1',
      data: 'ab',
      is_hex: false,
      append_line_ending: 'None',
    });
    expect(useAppStore.getState().trafficStats.COM1?.txTotal).toBe(2);
  });

  it('accumulates txTotal across sends', async () => {
    vi.mocked(serialService.sendSerialData).mockResolvedValue(3);
    await ttyService.send('COM1', 'abc');
    await ttyService.send('COM1', 'def');
    expect(useAppStore.getState().trafficStats.COM1?.txTotal).toBe(6);
  });

  it('logs and swallows send errors (no toast / no throw)', async () => {
    vi.mocked(serialService.sendSerialData).mockRejectedValue(new Error('port closed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(ttyService.send('COM1', 'x')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('no-ops on empty text', async () => {
    await ttyService.send('COM1', '');
    expect(serialService.sendSerialData).not.toHaveBeenCalled();
  });
});

describe('ttyService — resize', () => {
  beforeEach(() => {
    useAppStore.setState({ ports: [] });
  });

  it('routes resize to git bash sim backend for GIT: ports', () => {
    useAppStore.setState({
      ports: [{ id: 'GIT:BASH', name: 'GIT:BASH', status: 'disconnected', type: 'sim', isHidden: false }],
    });
    ttyService.resize('GIT:BASH', 80, 24);
    expect(gitBashSimService.resizeGitBashSim).toHaveBeenCalledWith('GIT:BASH', 80, 24);
  });

  it('does not touch the backend for real serial ports', () => {
    useAppStore.setState({
      ports: [{ id: 'COM1', name: 'COM1', status: 'disconnected', type: 'real', isHidden: false }],
    });
    ttyService.resize('COM1', 80, 24);
    expect(gitBashSimService.resizeGitBashSim).not.toHaveBeenCalled();
  });

  it('does nothing when the port is unknown', () => {
    ttyService.resize('NOPE', 80, 24);
    expect(gitBashSimService.resizeGitBashSim).not.toHaveBeenCalled();
  });

  it('stores the last known size for reuse at open/resync', () => {
    ttyService.feed('COM1', [0x68]); // create state
    ttyService.resize('COM1', 132, 43);
    const state = ttyService.get('COM1');
    expect(state?.lastCols).toBe(132);
    expect(state?.lastRows).toBe(43);
  });

  it('ignores invalid sizes (NaN / non-positive) and does not store them', () => {
    ttyService.feed('COM1', [0x68]);
    ttyService.resize('COM1', Number.NaN, 43);
    ttyService.resize('COM1', 0, -1);
    ttyService.resize('COM1', 132, 43);
    const state = ttyService.get('COM1');
    expect(state?.lastCols).toBe(132); // 仅最后一次合法尺寸被记录
    expect(state?.lastRows).toBe(43);
    expect(gitBashSimService.resizeGitBashSim).not.toHaveBeenCalled();
  });

  it('resync pushes the stored size to the backend for GIT: ports', () => {
    useAppStore.setState({
      ports: [{ id: 'GIT:BASH', name: 'GIT:BASH', status: 'disconnected', type: 'sim', isHidden: false }],
    });
    ttyService.feed('GIT:BASH', [0x68]);
    ttyService.resize('GIT:BASH', 100, 30);
    vi.clearAllMocks();
    ttyService.resync('GIT:BASH');
    expect(gitBashSimService.resizeGitBashSim).toHaveBeenCalledWith('GIT:BASH', 100, 30);
  });

  it('resync is a no-op without a stored size or for non-GIT ports', () => {
    useAppStore.setState({
      ports: [
        { id: 'GIT:BASH', name: 'GIT:BASH', status: 'disconnected', type: 'sim', isHidden: false },
        { id: 'COM1', name: 'COM1', status: 'disconnected', type: 'real', isHidden: false },
      ],
    });
    ttyService.resync('GIT:BASH'); // 无 stored size
    ttyService.feed('COM1', [0x68]);
    ttyService.resize('COM1', 80, 24);
    vi.clearAllMocks();
    ttyService.resync('COM1'); // 非 GIT: 端口
    expect(gitBashSimService.resizeGitBashSim).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  ttyService.reset();
  useAppStore.setState({ trafficStats: {}, ports: [] });
});

afterEach(() => {
  ttyService.reset();
  vi.useRealTimers();
});