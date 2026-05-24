import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from './useAppStore';
import type { SerialPort, PortGroup, TerminalLine } from '../types';

// Snapshot of initial state for reset between tests
const INITIAL_STATE = useAppStore.getState();

beforeEach(() => {
  // Reset to fresh initial state (immer-aware: replace whole top-level fields)
  useAppStore.setState({
    ports: [],
    groups: [],
    tabs: [],
    panes: [{ id: 'main', direction: 'vertical', tabIds: [], size: 1 }],
    activeTabId: null,
    focusedPaneId: 'main',
    terminals: {},
    highlightRuleSets: [],
    activeHighlightSetId: null,
    sendCommandSets: [],
    activeSendCommandSetId: null,
    trafficStats: {},
    simulationMode: false,
    config: INITIAL_STATE.config,
    systemStatus: INITIAL_STATE.systemStatus,
    ui: INITIAL_STATE.ui,
    opBaudRate: 115200,
    opDataBits: 8,
    opParity: 'None',
    opStopBits: 'One',
    opHandshake: 'None',
    opDtr: false,
    opRts: false,
    opIgnoreEmptyChars: false,
    opScrollLocked: true,
    opShowTimestamp: true,
    opDisplayFormat: 'string',
    opEncoding: 'ASCII',
    opSendIsHex: false,
    opSendAppendLineEnding: '\\r\\n',
    opSendInput: '',
    opIsLoopSending: false,
    opLoopInterval: 500,
  });
});

// Helpers
const makePort = (id: string, overrides?: Partial<SerialPort>): SerialPort => ({
  id, name: id, status: 'disconnected', type: 'real', isHidden: false, ...overrides,
});
const makeGroup = (id: string, portIds: string[] = []): PortGroup => ({
  id, name: id, isExpanded: true, portIds, order: 0,
});
const makeLine = (id: string, content = 'x'): TerminalLine => ({
  id, timestamp: 0, direction: 'RX', content, isHex: false,
});

// ==================== Group A: Port & Group ====================

describe('Port & Group actions', () => {
  it('movePortToGroup updates both port.groupId and group.portIds, and removes from old group', () => {
    useAppStore.setState({
      ports: [makePort('COM1', { groupId: 'g1' })],
      groups: [makeGroup('g1', ['COM1']), makeGroup('g2', [])],
    });
    useAppStore.getState().movePortToGroup('COM1', 'g2');
    const s = useAppStore.getState();
    expect(s.ports[0].groupId).toBe('g2');
    expect(s.groups.find(g => g.id === 'g1')!.portIds).toEqual([]);
    expect(s.groups.find(g => g.id === 'g2')!.portIds).toEqual(['COM1']);
  });

  it('removeGroup clears groupId on all member ports', () => {
    useAppStore.setState({
      ports: [makePort('COM1', { groupId: 'g1' }), makePort('COM2', { groupId: 'g1' })],
      groups: [makeGroup('g1', ['COM1', 'COM2'])],
    });
    useAppStore.getState().removeGroup('g1');
    const s = useAppStore.getState();
    expect(s.groups).toEqual([]);
    expect(s.ports.every(p => p.groupId === undefined)).toBe(true);
  });
});

// ==================== Group B: Tabs & Panes ====================

describe('Tab & Pane actions', () => {
  it('openTab creates tab, adds to focused pane, and initializes terminal state', () => {
    useAppStore.setState({ ports: [makePort('COM1')] });
    useAppStore.getState().openTab('COM1');
    const s = useAppStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].id).toBe('COM1');
    expect(s.tabs[0].isActive).toBe(true);
    expect(s.activeTabId).toBe('COM1');
    expect(s.panes[0].tabIds).toContain('COM1');
    expect(s.terminals['COM1']).toBeDefined();
    expect(s.terminals['COM1'].lines).toEqual([]);
  });

  it('openTab on existing tab reactivates it without duplicating', () => {
    useAppStore.setState({ ports: [makePort('COM1'), makePort('COM2')] });
    const o = useAppStore.getState().openTab;
    o('COM1'); o('COM2'); o('COM1');
    const s = useAppStore.getState();
    expect(s.tabs).toHaveLength(2);
    expect(s.activeTabId).toBe('COM1');
    expect(s.tabs.find(t => t.id === 'COM1')!.isActive).toBe(true);
    expect(s.tabs.find(t => t.id === 'COM2')!.isActive).toBe(false);
  });

  it('closeTab picks remaining tab as active and removes from pane', () => {
    useAppStore.setState({ ports: [makePort('COM1'), makePort('COM2')] });
    const { openTab, closeTab } = useAppStore.getState();
    openTab('COM1'); openTab('COM2');
    closeTab('COM2');
    const s = useAppStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].id).toBe('COM1');
    expect(s.activeTabId).toBe('COM1');
    expect(s.panes[0].tabIds).toEqual(['COM1']);
  });

  it('closeTabsToRight preserves pinned tabs to the right of target', () => {
    useAppStore.setState({ ports: ['A', 'B', 'C', 'D'].map(p => makePort(p)) });
    const { openTab, pinTab, closeTabsToRight } = useAppStore.getState();
    openTab('A'); openTab('B'); openTab('C'); openTab('D');
    pinTab('D'); // D is now pinned
    closeTabsToRight('B'); // should remove C but keep D
    const s = useAppStore.getState();
    expect(s.tabs.map(t => t.id)).toEqual(['A', 'B', 'D']);
  });

  it('closeOtherTabs preserves only the target and pinned tabs', () => {
    useAppStore.setState({ ports: ['A', 'B', 'C'].map(p => makePort(p)) });
    const { openTab, pinTab, closeOtherTabs } = useAppStore.getState();
    openTab('A'); openTab('B'); openTab('C');
    pinTab('A');
    closeOtherTabs('C');
    const s = useAppStore.getState();
    expect(s.tabs.map(t => t.id).sort()).toEqual(['A', 'C']);
    expect(s.activeTabId).toBe('C');
  });

  it('splitPane sets source size to 0.5, creates new pane with active tab', () => {
    useAppStore.setState({ ports: [makePort('A')] });
    useAppStore.getState().openTab('A');
    useAppStore.getState().splitPane('horizontal');
    const s = useAppStore.getState();
    expect(s.panes).toHaveLength(2);
    const main = s.panes.find(p => p.id === 'main')!;
    const newPane = s.panes.find(p => p.id !== 'main')!;
    expect(main.size).toBe(0.5);
    expect(newPane.size).toBe(0.5);
    expect(newPane.tabIds).toEqual(['A']);
    expect(main.tabIds).toEqual([]);
    expect(s.tabs.find(t => t.id === 'A')!.splitPaneId).toBe(newPane.id);
  });

  it('moveTabToPane removes empty source pane and migrates active state', () => {
    useAppStore.setState({ ports: [makePort('A'), makePort('B')] });
    const { openTab, splitPane, moveTabToPane } = useAppStore.getState();
    openTab('A'); openTab('B'); // both in 'main'
    splitPane('vertical'); // active tab B moves to new pane
    const newPaneId = useAppStore.getState().panes.find(p => p.id !== 'main')!.id;
    moveTabToPane('B', 'main'); // move B back; new pane becomes empty -> removed
    const s = useAppStore.getState();
    expect(s.panes).toHaveLength(1);
    expect(s.panes[0].id).toBe('main');
    expect([...s.panes[0].tabIds].sort()).toEqual(['A', 'B']);
    expect(s.tabs.find(t => t.id === 'B')!.splitPaneId).toBe('main');
    void newPaneId; // referenced for clarity, not asserted further
  });
});

// ==================== Group C: Terminal lines ====================

describe('Terminal line actions', () => {
  it('appendTerminalLine pushes to lines array', () => {
    useAppStore.setState({
      ports: [makePort('COM1')],
    });
    useAppStore.getState().openTab('COM1');
    useAppStore.getState().appendTerminalLine('COM1', makeLine('l1'));
    useAppStore.getState().appendTerminalLine('COM1', makeLine('l2'));
    const lines = useAppStore.getState().terminals['COM1'].lines;
    expect(lines.map(l => l.id)).toEqual(['l1', 'l2']);
  });

  it('appendTerminalLine drops oldest when exceeding maxLines (ring buffer)', () => {
    useAppStore.setState({ ports: [makePort('COM1')] });
    useAppStore.getState().openTab('COM1');
    useAppStore.setState((state) => {
      state.terminals['COM1'].maxLines = 3;
    });
    const append = useAppStore.getState().appendTerminalLine;
    append('COM1', makeLine('l1'));
    append('COM1', makeLine('l2'));
    append('COM1', makeLine('l3'));
    append('COM1', makeLine('l4')); // l1 should be evicted
    const lines = useAppStore.getState().terminals['COM1'].lines;
    expect(lines.map(l => l.id)).toEqual(['l2', 'l3', 'l4']);
  });

  it('clearTerminal empties lines but preserves config (scrollLocked, displayFormat)', () => {
    useAppStore.setState({ ports: [makePort('COM1')] });
    useAppStore.getState().openTab('COM1');
    const { setTerminalConfig, appendTerminalLine, clearTerminal } = useAppStore.getState();
    setTerminalConfig('COM1', { scrollLocked: false, displayFormat: 'hex' });
    appendTerminalLine('COM1', makeLine('l1'));
    clearTerminal('COM1');
    const t = useAppStore.getState().terminals['COM1'];
    expect(t.lines).toEqual([]);
    expect(t.scrollLocked).toBe(false);
    expect(t.displayFormat).toBe('hex');
  });
});

// ==================== Group D: Misc ====================

describe('Misc actions', () => {
  it('setTrafficStats auto-initializes entry when port is new', () => {
    useAppStore.getState().setTrafficStats('COM1', { txTotal: 100 });
    const stats = useAppStore.getState().trafficStats['COM1'];
    expect(stats).toBeDefined();
    expect(stats.txTotal).toBe(100);
    expect(stats.rxTotal).toBe(0); // default
    expect(stats.portId).toBe('COM1');
  });

  it('pinTab toggles isPinned on/off', () => {
    useAppStore.setState({ ports: [makePort('COM1')] });
    useAppStore.getState().openTab('COM1');
    const { pinTab } = useAppStore.getState();
    expect(useAppStore.getState().tabs[0].isPinned).toBe(false);
    pinTab('COM1');
    expect(useAppStore.getState().tabs[0].isPinned).toBe(true);
    pinTab('COM1');
    expect(useAppStore.getState().tabs[0].isPinned).toBe(false);
  });

  it('reorderPorts swaps positions correctly', () => {
    useAppStore.setState({
      ports: ['A', 'B', 'C', 'D'].map(p => makePort(p)),
    });
    useAppStore.getState().reorderPorts(0, 2); // move A to index 2
    const ids = useAppStore.getState().ports.map(p => p.id);
    expect(ids).toEqual(['B', 'C', 'A', 'D']);
  });
});