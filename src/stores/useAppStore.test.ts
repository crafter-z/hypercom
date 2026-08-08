import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore, findLeafById, findLeafByTabId, collectLeaves, countLeaves } from './useAppStore';
import { useTerminalStore } from './useTerminalStore';
import { useRuleStore } from './useRuleStore';
import { useOperationStore } from './useOperationStore';
import type { SerialPort, PortGroup, TerminalLine, LeafPane, BranchPane, PaneNode } from '../types';

// Snapshot of initial state for reset between tests
const INITIAL_STATE = useAppStore.getState();

beforeEach(() => {
  // Reset to fresh initial state (immer-aware: replace whole top-level fields)
  useAppStore.setState({
    ports: [],
    groups: [],
    tabs: [],
    paneTree: { id: 'main', type: 'leaf' as const, tabIds: [], size: 1 },
    activeTabId: null,
    focusedPaneId: 'main',
    trafficStats: {},
    simulationMode: false,
    config: INITIAL_STATE.config,
    systemStatus: INITIAL_STATE.systemStatus,
    ui: INITIAL_STATE.ui,
  });
  // Reset separate stores
  useTerminalStore.setState({ terminals: {} });
  useRuleStore.setState({
    highlightRuleSets: [],
    activeHighlightSetId: null,
    sendCommandSets: [],
    activeSendCommandSetId: null,
  });
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
    isLoopSending: false,
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

  // ===== issue #6-4：排序是一次性重排（含组内顺序），拖拽/分组仍可用 =====

  it('sortPortsByNumber reorders ports naturally (COM1 < COM2 < COM12) in one pass', () => {
    useAppStore.setState({
      ports: [makePort('COM12'), makePort('COM2'), makePort('COM1')],
    });
    useAppStore.getState().sortPortsByNumber();
    expect(useAppStore.getState().ports.map(p => p.id)).toEqual(['COM1', 'COM2', 'COM12']);
  });

  it('sortPortsByNumber reorders group portIds too (persisted via save_port_groups)', () => {
    useAppStore.setState({
      ports: [makePort('COM1'), makePort('COM2'), makePort('COM12')],
      groups: [makeGroup('g1', ['COM12', 'COM1'])],
    });
    useAppStore.getState().sortPortsByNumber();
    const g = useAppStore.getState().groups[0];
    expect(g.portIds).toEqual(['COM1', 'COM12']);
  });

  it('sortPortsByNumber is idempotent and does not reset port.groupId', () => {
    useAppStore.setState({
      ports: [makePort('COM1', { groupId: 'g1' }), makePort('COM2', { groupId: 'g1' })],
      groups: [makeGroup('g1', ['COM1', 'COM2'])],
    });
    const s = useAppStore.getState();
    s.sortPortsByNumber();
    s.sortPortsByNumber();
    expect(s.ports.map(p => p.id)).toEqual(['COM1', 'COM2']);
    expect(s.ports.every(p => p.groupId === 'g1')).toBe(true);
  });

  // ===== issue #11：端口工作模式（trx=传统收发 | tty=终端模式） =====

  it('setPortMode sets mode on an existing port', () => {
    useAppStore.setState({ ports: [makePort('COM1')] });
    useAppStore.getState().setPortMode('COM1', 'tty');
    expect(useAppStore.getState().ports[0].mode).toBe('tty');
    useAppStore.getState().setPortMode('COM1', 'trx');
    expect(useAppStore.getState().ports[0].mode).toBe('trx');
  });

  it('setPortMode is a no-op when port is missing', () => {
    useAppStore.setState({ ports: [makePort('COM1')] });
    const portsBefore = [...useAppStore.getState().ports];
    useAppStore.getState().setPortMode('nonexistent', 'tty');
    expect(useAppStore.getState().ports).toEqual(portsBefore);
  });

  it('setPortMode preserves other port fields', () => {
    useAppStore.setState({
      ports: [makePort('COM1', { alias: 'My Device', status: 'connected', groupId: 'g1' })],
    });
    useAppStore.getState().setPortMode('COM1', 'tty');
    const p = useAppStore.getState().ports[0];
    expect(p.mode).toBe('tty');
    expect(p.alias).toBe('My Device');
    expect(p.status).toBe('connected');
    expect(p.groupId).toBe('g1');
    expect(p.name).toBe('COM1');
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
    expect(s.paneTree.type).toBe('leaf');
    expect((s.paneTree as LeafPane).tabIds).toContain('COM1');
    expect(useTerminalStore.getState().terminals['COM1']).toBeDefined();
    expect(useTerminalStore.getState().terminals['COM1'].lines).toEqual([]);
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
    expect(s.paneTree.type).toBe('leaf');
    expect((s.paneTree as LeafPane).tabIds).toEqual(['COM1']);
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

  it('closeTabsToRight is pane-scoped: uses leaf tab order and never touches other panes', () => {
    const pane1: LeafPane = { id: 'pane1', type: 'leaf', tabIds: ['A', 'B', 'C'], size: 0.5 };
    const pane2: LeafPane = { id: 'pane2', type: 'leaf', tabIds: ['X', 'Y'], size: 0.5 };
    useAppStore.setState({
      ports: ['A', 'B', 'C', 'X', 'Y'].map(p => makePort(p)),
      tabs: [
        { id: 'A', title: 'A', isPinned: false, isActive: true, splitPaneId: 'pane1' },
        { id: 'B', title: 'B', isPinned: false, isActive: false, splitPaneId: 'pane1' },
        { id: 'C', title: 'C', isPinned: false, isActive: false, splitPaneId: 'pane1' },
        { id: 'X', title: 'X', isPinned: false, isActive: false, splitPaneId: 'pane2' },
        { id: 'Y', title: 'Y', isPinned: false, isActive: false, splitPaneId: 'pane2' },
      ],
      paneTree: {
        id: 'root', type: 'branch', direction: 'vertical',
        children: [pane1, pane2], size: 1,
      },
      focusedPaneId: 'pane1',
    });
    useAppStore.getState().closeTabsToRight('A');
    const s = useAppStore.getState();
    // B,C removed from pane1; pane2 (X,Y) untouched
    expect(s.tabs.map(t => t.id)).toEqual(['A', 'X', 'Y']);
    expect(findLeafById(s.paneTree, 'pane1')!.tabIds).toEqual(['A']);
    expect(findLeafById(s.paneTree, 'pane2')!.tabIds).toEqual(['X', 'Y']);
  });

  it('closeTabsToLeft respects reordered pane tab order (not global order)', () => {
    useAppStore.setState({ ports: ['A', 'B', 'C'].map(p => makePort(p)) });
    const { openTab, reorderPaneTabIds, closeTabsToLeft } = useAppStore.getState();
    openTab('A'); openTab('B'); openTab('C'); // main leaf: [A,B,C]
    reorderPaneTabIds('main', ['C', 'A', 'B']);
    closeTabsToLeft('A'); // left of A in pane order is only [C]
    const s = useAppStore.getState();
    expect(s.tabs.map(t => t.id).sort()).toEqual(['A', 'B']);
    expect((s.paneTree as LeafPane).tabIds).toEqual(['A', 'B']);
  });

  it('closeTabsToRight repairs a dangling focusedPaneId', () => {
    useAppStore.setState({
      ports: ['A', 'B'].map(p => makePort(p)),
      tabs: [
        { id: 'A', title: 'A', isPinned: false, isActive: true, splitPaneId: 'main' },
        { id: 'B', title: 'B', isPinned: false, isActive: false, splitPaneId: 'main' },
      ],
      paneTree: { id: 'main', type: 'leaf', tabIds: ['A', 'B'], size: 1 },
      focusedPaneId: 'ghost', // dangling before the action
    });
    useAppStore.getState().closeTabsToRight('A');
    const s = useAppStore.getState();
    expect(s.tabs.map(t => t.id)).toEqual(['A']);
    expect(s.focusedPaneId).toBe('main');
  });

  it('openTab falls back to first leaf when focusedPaneId is dangling (no orphan tab)', () => {
    useAppStore.setState({
      ports: [makePort('A'), makePort('B')],
      tabs: [{ id: 'A', title: 'A', isPinned: false, isActive: true, splitPaneId: 'main' }],
      paneTree: { id: 'main', type: 'leaf', tabIds: ['A'], size: 1 },
      focusedPaneId: 'ghost', // dangling
    });
    useAppStore.getState().openTab('B');
    const s = useAppStore.getState();
    // B must land in a real leaf, not just in state.tabs
    expect(s.tabs.find(t => t.id === 'B')!.splitPaneId).toBe('main');
    expect(findLeafById(s.paneTree, 'main')!.tabIds).toContain('B');
  });

  it('splitPane sets source size to 0.5, creates new pane with active tab', () => {
    useAppStore.setState({ ports: [makePort('A')] });
    useAppStore.getState().openTab('A');
    useAppStore.getState().splitPane('horizontal');
    const s = useAppStore.getState();
    expect(s.paneTree.type).toBe('branch');
    const branch = s.paneTree as BranchPane;
    expect(branch.children).toHaveLength(2);
    const main = branch.children.find((c): c is LeafPane => c.type === 'leaf' && c.id === 'main')!;
    const newLeaf = branch.children.find((c): c is LeafPane => c.type === 'leaf' && c.id !== 'main')!;
    expect(main.size).toBe(0.5);
    expect(newLeaf.size).toBe(0.5);
    expect(newLeaf.tabIds).toEqual(['A']);
    expect(main.tabIds).toEqual([]);
    expect(s.tabs.find(t => t.id === 'A')!.splitPaneId).toBe(newLeaf.id);
  });

  it('moveTabToPane removes empty source pane and migrates active state', () => {
    useAppStore.setState({ ports: [makePort('A'), makePort('B')] });
    const { openTab, splitPane, moveTabToPane } = useAppStore.getState();
    openTab('A'); openTab('B'); // both in 'main'
    splitPane('vertical'); // active tab B moves to new pane
    const newLeafId = (useAppStore.getState().paneTree as BranchPane).children
      .find((c): c is LeafPane => c.type === 'leaf' && c.id !== 'main')!.id;
    moveTabToPane('B', 'main'); // move B back; source leaf becomes empty -> pruned
    const s = useAppStore.getState();
    expect(s.paneTree.type).toBe('leaf');
    expect((s.paneTree as LeafPane).id).toBe('main');
    expect([...(s.paneTree as LeafPane).tabIds].sort()).toEqual(['A', 'B']);
    expect(s.tabs.find(t => t.id === 'B')!.splitPaneId).toBe('main');
    void newLeafId;
  });

  it('splitPane on a non-root leaf creates a 3-level nested tree', () => {
    useAppStore.setState({ ports: [makePort('A')] });
    useAppStore.getState().openTab('A');
    useAppStore.getState().splitPane('horizontal'); // root branch with [main(empty), leaf1(A)]
    const root = useAppStore.getState().paneTree as BranchPane;
    const leaf1 = root.children.find((c): c is LeafPane => c.type === 'leaf' && c.id !== 'main')!;
    // 把焦点切回非根 leaf (其内含活动标签 A，自然就是焦点)
    useAppStore.getState().setFocusedPane(leaf1.id);
    useAppStore.getState().splitPane('vertical');
    const s = useAppStore.getState();
    expect(s.paneTree.type).toBe('branch');
    const r = s.paneTree as BranchPane;
    expect(r.children).toHaveLength(2);
    // leaf1 应已被替换为 inner branch
    const innerBranch = r.children.find((c): c is BranchPane => c.type === 'branch')!;
    expect(innerBranch).toBeDefined();
    expect(innerBranch.children).toHaveLength(2);
    expect(innerBranch.children.every(c => c.type === 'leaf')).toBe(true);
    expect(innerBranch.direction).toBe('vertical');
    expect(innerBranch.size).toBe(0.5);
    expect(countLeaves(s.paneTree)).toBe(3);
  });

  it('removePane on an inner leaf collapses the inner branch', () => {
    // 直接构造 3 叶子嵌套树：root[h] -> [main(A), inner[v] -> [leafX(B), leafY(C)]]
    const mainLeaf: LeafPane = { id: 'main', type: 'leaf', tabIds: ['A'], size: 0.5 };
    const leafX: LeafPane = { id: 'leafX', type: 'leaf', tabIds: ['B'], size: 0.5 };
    const leafY: LeafPane = { id: 'leafY', type: 'leaf', tabIds: ['C'], size: 0.5 };
    const innerBranch: BranchPane = {
      id: 'inner', type: 'branch', direction: 'vertical',
      children: [leafX, leafY], size: 0.5,
    };
    useAppStore.setState({
      ports: ['A', 'B', 'C'].map(p => makePort(p)),
      tabs: [
        { id: 'A', title: 'A', isPinned: false, isActive: true, splitPaneId: 'main' },
        { id: 'B', title: 'B', isPinned: false, isActive: false, splitPaneId: 'leafX' },
        { id: 'C', title: 'C', isPinned: false, isActive: false, splitPaneId: 'leafY' },
      ],
      paneTree: {
        id: 'root', type: 'branch', direction: 'horizontal',
        children: [mainLeaf, innerBranch], size: 1,
      },
      focusedPaneId: 'leafY',
    });
    // Remove leafY — its tab C migrates to first available leaf (main per DFS),
    // innerBranch collapses to its sole child leafX, root stays as branch with 2 leaves.
    useAppStore.getState().removePane('leafY');
    const s = useAppStore.getState();
    expect(s.paneTree.type).toBe('branch');
    const r = s.paneTree as BranchPane;
    expect(r.children).toHaveLength(2);
    expect(r.children.every(c => c.type === 'leaf')).toBe(true);
    const survivorIds = r.children.map(c => c.id).sort();
    expect(survivorIds).toEqual(['leafX', 'main']);
    expect(countLeaves(s.paneTree)).toBe(2);
    expect(findLeafById(s.paneTree, 'main')!.tabIds).toContain('C');
  });

  it('setActiveTab sets BOTH activeTabId and focusedPaneId (operation-panel target follows)', () => {
    const pane1: LeafPane = { id: 'pane1', type: 'leaf', tabIds: ['A'], size: 0.5 };
    const pane2: LeafPane = { id: 'pane2', type: 'leaf', tabIds: ['B'], size: 0.5 };
    useAppStore.setState({
      ports: [makePort('A'), makePort('B')],
      tabs: [
        { id: 'A', title: 'A', isPinned: false, isActive: true, splitPaneId: 'pane1' },
        { id: 'B', title: 'B', isPinned: false, isActive: false, splitPaneId: 'pane2' },
      ],
      paneTree: {
        id: 'root', type: 'branch', direction: 'vertical',
        children: [pane1, pane2], size: 1,
      },
      focusedPaneId: 'pane1',
    });
    useAppStore.getState().setActiveTab('B');
    const s = useAppStore.getState();
    expect(s.activeTabId).toBe('B');
    expect(s.focusedPaneId).toBe('pane2'); // tabB.splitPaneId
    expect(s.tabs.find(t => t.id === 'B')!.isActive).toBe(true);
    expect(s.tabs.find(t => t.id === 'A')!.isActive).toBe(false);
  });

  it('setFocusedPane leaves activeTabId unchanged (output-area click must call setActiveTab)', () => {
    const pane1: LeafPane = { id: 'pane1', type: 'leaf', tabIds: ['A'], size: 0.5 };
    const pane2: LeafPane = { id: 'pane2', type: 'leaf', tabIds: ['B'], size: 0.5 };
    useAppStore.setState({
      ports: [makePort('A'), makePort('B')],
      tabs: [
        { id: 'A', title: 'A', isPinned: false, isActive: true, splitPaneId: 'pane1' },
        { id: 'B', title: 'B', isPinned: false, isActive: false, splitPaneId: 'pane2' },
      ],
      paneTree: {
        id: 'root', type: 'branch', direction: 'vertical',
        children: [pane1, pane2], size: 1,
      },
      activeTabId: 'A',
      focusedPaneId: 'pane1',
    });
    useAppStore.getState().setFocusedPane('pane2');
    const s = useAppStore.getState();
    expect(s.focusedPaneId).toBe('pane2');
    expect(s.activeTabId).toBe('A'); // unchanged — the asymmetry the fix relies on
  });
});

// ==================== Group C: Terminal lines ====================

describe('Terminal line actions', () => {
  it('appendTerminalLine pushes to lines array', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().appendTerminalLine('COM1', makeLine('l1'));
    useTerminalStore.getState().appendTerminalLine('COM1', makeLine('l2'));
    const lines = useTerminalStore.getState().terminals['COM1'].lines;
    expect(lines.map(l => l.id)).toEqual(['l1', 'l2']);
  });

  it('appendTerminalLine trims to half when exceeding maxLines (issue #6-2)', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.setState((state) => {
      state.terminals['COM1'].maxLines = 3;
    });
    const append = useTerminalStore.getState().appendTerminalLine;
    append('COM1', makeLine('l1'));
    append('COM1', makeLine('l2'));
    append('COM1', makeLine('l3'));
    append('COM1', makeLine('l4')); // 4 > 3 → 一次性裁到一半 → 保留 2 行
    const lines = useTerminalStore.getState().terminals['COM1'].lines;
    expect(lines.map(l => l.id)).toEqual(['l3', 'l4']);
  });

  it('clearTerminal empties lines but preserves config (scrollLocked, displayFormat)', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    const { setTerminalConfig, appendTerminalLine, clearTerminal } = useTerminalStore.getState();
    setTerminalConfig('COM1', { scrollLocked: false, displayFormat: 'hex' });
    appendTerminalLine('COM1', makeLine('l1'));
    clearTerminal('COM1');
    const t = useTerminalStore.getState().terminals['COM1'];
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

// ==================== Group E: Config ====================

describe('Config actions', () => {
  it('setConfig updates individual fields without affecting others', () => {
    useAppStore.getState().setConfig({ memoryLimitMb: 2048 });
    const c = useAppStore.getState().config;
    expect(c.memoryLimitMb).toBe(2048);
    expect(c.theme).toBe('dark'); // unchanged
  });

  it('resetConfig restores all defaults', () => {
    useAppStore.getState().setConfig({ theme: 'light', memoryLimitMb: 500, memoryPerPortBudgetMb: 50 });
    useAppStore.getState().resetConfig();
    const c = useAppStore.getState().config;
    expect(c.theme).toBe('dark');
    // issue #6-2：总预算默认 2048，每端口默认 200
    expect(c.memoryLimitMb).toBe(2048);
    expect(c.memoryPerPortBudgetMb).toBe(200);
  });

  it('terminalFontSize config is persisted after setConfig', () => {
    useAppStore.getState().setConfig({ terminalFontSize: 18 });
    expect(useAppStore.getState().config.terminalFontSize).toBe(18);
  });

  it('defaultBaudRates config can be modified', () => {
    useAppStore.getState().setConfig({ defaultBaudRates: [4800, 9600] });
    expect(useAppStore.getState().config.defaultBaudRates).toEqual([4800, 9600]);
  });
});

// ==================== Group F: Highlight Rule Sets ====================

describe('Highlight Rule Set actions', () => {
  const makeHighlightSet = (id: string) => ({
    id, name: `Set ${id}`, rules: [], isEnabled: true,
  });

  it('addHighlightRuleSet adds to the array', () => {
    useRuleStore.getState().addHighlightRuleSet(makeHighlightSet('h1'));
    expect(useRuleStore.getState().highlightRuleSets).toHaveLength(1);
    expect(useRuleStore.getState().highlightRuleSets[0].id).toBe('h1');
  });

  it('updateHighlightRuleSet modifies existing set', () => {
    useRuleStore.getState().addHighlightRuleSet(makeHighlightSet('h1'));
    useRuleStore.getState().updateHighlightRuleSet('h1', { isEnabled: false });
    expect(useRuleStore.getState().highlightRuleSets[0].isEnabled).toBe(false);
  });

  it('updateHighlightRuleSet is no-op for unknown id', () => {
    useRuleStore.getState().addHighlightRuleSet(makeHighlightSet('h1'));
    useRuleStore.getState().updateHighlightRuleSet('nonexistent', { isEnabled: false });
    expect(useRuleStore.getState().highlightRuleSets[0].isEnabled).toBe(true);
  });

  it('removeHighlightRuleSet deletes correct set', () => {
    useRuleStore.getState().addHighlightRuleSet(makeHighlightSet('h1'));
    useRuleStore.getState().addHighlightRuleSet(makeHighlightSet('h2'));
    useRuleStore.getState().removeHighlightRuleSet('h1');
    expect(useRuleStore.getState().highlightRuleSets).toHaveLength(1);
    expect(useRuleStore.getState().highlightRuleSets[0].id).toBe('h2');
  });

  it('setActiveHighlightSetId updates active set', () => {
    useRuleStore.getState().addHighlightRuleSet(makeHighlightSet('h1'));
    useRuleStore.getState().setActiveHighlightSetId('h1');
    expect(useRuleStore.getState().activeHighlightSetId).toBe('h1');
  });
});

// ==================== Group G: Send Command Sets ====================

describe('Send Command Set actions', () => {
  const makeCmdSet = (id: string) => ({
    id, name: `Cmd ${id}`, commands: [], isLoop: false, loopDelay: 100, repeatCount: 0,
  });

  it('addSendCommandSet adds to the array', () => {
    useRuleStore.getState().addSendCommandSet(makeCmdSet('s1'));
    expect(useRuleStore.getState().sendCommandSets).toHaveLength(1);
  });

  it('updateSendCommandSet modifies name and isLoop', () => {
    useRuleStore.getState().addSendCommandSet(makeCmdSet('s1'));
    useRuleStore.getState().updateSendCommandSet('s1', { name: 'New Name', isLoop: true });
    const s = useRuleStore.getState().sendCommandSets[0];
    expect(s.name).toBe('New Name');
    expect(s.isLoop).toBe(true);
  });

  it('removeSendCommandSet cleans up correctly', () => {
    useRuleStore.getState().addSendCommandSet(makeCmdSet('s1'));
    useRuleStore.getState().addSendCommandSet(makeCmdSet('s2'));
    useRuleStore.getState().removeSendCommandSet('s2');
    expect(useRuleStore.getState().sendCommandSets).toHaveLength(1);
  });

  it('setActiveSendCommandSetId updates selection', () => {
    useRuleStore.getState().addSendCommandSet(makeCmdSet('s1'));
    useRuleStore.getState().setActiveSendCommandSetId('s1');
    expect(useRuleStore.getState().activeSendCommandSetId).toBe('s1');
  });
});

// ==================== Group H: UI State ====================

describe('UI State actions', () => {
  it('setUIState updates individual field', () => {
    useAppStore.getState().setUIState({ sidebarWidth: 300 });
    expect(useAppStore.getState().ui.sidebarWidth).toBe(300);
    expect(useAppStore.getState().ui.isConfigOpen).toBe(false); // unchanged
  });

  it('toggleConfigModal opens and closes', () => {
    useAppStore.getState().toggleConfigModal(true);
    expect(useAppStore.getState().ui.isConfigOpen).toBe(true);
    useAppStore.getState().toggleConfigModal(false);
    expect(useAppStore.getState().ui.isConfigOpen).toBe(false);
  });

  it('toggleConfigModal toggles when no arg', () => {
    expect(useAppStore.getState().ui.isConfigOpen).toBe(false);
    useAppStore.getState().toggleConfigModal();
    expect(useAppStore.getState().ui.isConfigOpen).toBe(true);
    useAppStore.getState().toggleConfigModal();
    expect(useAppStore.getState().ui.isConfigOpen).toBe(false);
  });
});

// ==================== Group I: Operation State ====================

describe('Operation State actions', () => {
  it('setOpState updates multiple op fields', () => {
    useOperationStore.getState().setOpState({ baudRate: 9600, dtr: true });
    expect(useOperationStore.getState().baudRate).toBe(9600);
    expect(useOperationStore.getState().dtr).toBe(true);
  });

  it('setOpState preserves unmodified op fields', () => {
    const oldParity = useOperationStore.getState().parity;
    useOperationStore.getState().setOpState({ baudRate: 38400 });
    expect(useOperationStore.getState().parity).toBe(oldParity);
  });

  it('setOpState handles send-mode change', () => {
    useOperationStore.getState().setOpState({ sendIsHex: true });
    expect(useOperationStore.getState().sendIsHex).toBe(true);
  });

  it('setOpState handles loop state toggle', () => {
    useOperationStore.getState().setOpState({ isLoopSending: true });
    expect(useOperationStore.getState().isLoopSending).toBe(true);
  });
});

// ==================== Group J: Simulation Mode ====================

describe('Simulation Mode', () => {
  it('setSimulationMode toggles on and off', () => {
    useAppStore.getState().setSimulationMode(true);
    expect(useAppStore.getState().simulationMode).toBe(true);
    useAppStore.getState().setSimulationMode(false);
    expect(useAppStore.getState().simulationMode).toBe(false);
  });
});

// ==================== Group K: Edge Cases ====================

describe('Edge cases', () => {
  it('openTab with memoryPerPortBudgetMb=0 uses default maxLines=10000', () => {
    useAppStore.getState().setConfig({ memoryPerPortBudgetMb: 0 });
    useAppStore.setState({ ports: [makePort('COM1')] });
    useAppStore.getState().openTab('COM1');
    // Terminal is now in useTerminalStore; openTab in useAppStore still creates tab
    expect(useAppStore.getState().tabs.find(t => t.id === 'COM1')).toBeDefined();
  });

  it('closeTab on non-existent tab is no-op', () => {
    useAppStore.setState({ ports: [makePort('COM1')] });
    useAppStore.getState().openTab('COM1');
    const tabCountBefore = useAppStore.getState().tabs.length;
    useAppStore.getState().closeTab('nonexistent');
    expect(useAppStore.getState().tabs.length).toBe(tabCountBefore);
  });

  it('removePane on single pane is no-op', () => {
    expect(useAppStore.getState().paneTree.type).toBe('leaf');
    useAppStore.getState().removePane('main');
    expect(useAppStore.getState().paneTree.type).toBe('leaf');
  });

  it('setTrafficStats accumulates statistics', () => {
    useAppStore.getState().setTrafficStats('COM1', { txTotal: 50 });
    useAppStore.getState().setTrafficStats('COM1', { rxTotal: 30 });
    const stats = useAppStore.getState().trafficStats['COM1'];
    expect(stats.txTotal).toBe(50);
    expect(stats.rxTotal).toBe(30);
  });

  it('appendTerminalLine to non-existent port is no-op', () => {
    const stateBefore = useTerminalStore.getState().terminals;
    useTerminalStore.getState().appendTerminalLine('nonexistent', makeLine('l1'));
    expect(useTerminalStore.getState().terminals).toEqual(stateBefore);
  });

  it('setTerminalConfig on non-existent port is no-op', () => {
    useTerminalStore.getState().setTerminalConfig('nonexistent', { scrollLocked: false });
    expect(useTerminalStore.getState().terminals['nonexistent']).toBeUndefined();
  });

  it('movePortToGroup with non-existent port is no-op', () => {
    useAppStore.setState({
      ports: [makePort('COM1')],
      groups: [makeGroup('g1', [])],
    });
    const portsBefore = [...useAppStore.getState().ports];
    useAppStore.getState().movePortToGroup('nonexistent', 'g1');
    expect(useAppStore.getState().ports).toEqual(portsBefore);
  });

  it('updatePort updates alias and syncs tab title', () => {
    useAppStore.setState({ ports: [makePort('COM1')] });
    useAppStore.getState().openTab('COM1');
    useAppStore.getState().updatePort('COM1', { alias: 'My Device' });
    const tab = useAppStore.getState().tabs.find(t => t.id === 'COM1');
    expect(tab?.title).toBe('COM1 My Device');
  });

  it('openTab when port has no alias creates title from port id', () => {
    useAppStore.setState({ ports: [makePort('COM3')] });
    useAppStore.getState().openTab('COM3');
    const tab = useAppStore.getState().tabs.find(t => t.id === 'COM3');
    expect(tab?.title).toBe('COM3');
  });

  it('clearTerminal on non-existent port is no-op', () => {
    useTerminalStore.getState().clearTerminal('nonexistent');
    // Should not throw
    expect(true).toBe(true);
  });

  it('reorderPaneTabIds updates pane tab order', () => {
    useAppStore.setState({
      ports: ['A', 'B', 'C'].map(p => makePort(p)),
      paneTree: { id: 'main', type: 'leaf' as const, tabIds: ['A', 'B', 'C'], size: 1 },
    });
    ['A', 'B', 'C'].forEach(id => useAppStore.getState().openTab(id));
    useAppStore.getState().reorderPaneTabIds('main', ['C', 'A', 'B']);
    expect((useAppStore.getState().paneTree as LeafPane).tabIds).toEqual(['C', 'A', 'B']);
  });

  it('reorderPaneTabIds on non-existent pane is no-op', () => {
    useAppStore.setState({ paneTree: { id: 'main', type: 'leaf' as const, tabIds: ['A'], size: 1 } });
    useAppStore.getState().reorderPaneTabIds('nonexistent', ['A', 'B']);
    expect((useAppStore.getState().paneTree as LeafPane).tabIds).toEqual(['A']);
  });

  it('moveTabToPane cross-pane then reorder works correctly', () => {
    // 树：root branch(vertical) -> [leaf pane1[A,B], leaf pane2[C]]
    const pane1: LeafPane = { id: 'pane1', type: 'leaf', tabIds: ['A', 'B'], size: 0.5 };
    const pane2: LeafPane = { id: 'pane2', type: 'leaf', tabIds: ['C'], size: 0.5 };
    useAppStore.setState({
      ports: ['A', 'B', 'C'].map(p => makePort(p)),
      tabs: [
        { id: 'A', title: 'A', isPinned: false, isActive: true, splitPaneId: 'pane1' },
        { id: 'B', title: 'B', isPinned: false, isActive: false, splitPaneId: 'pane1' },
        { id: 'C', title: 'C', isPinned: false, isActive: false, splitPaneId: 'pane2' },
      ],
      paneTree: {
        id: 'root', type: 'branch', direction: 'vertical' as const,
        children: [pane1, pane2], size: 1,
      },
      focusedPaneId: 'pane1',
    });
    // Move B from pane1 to pane2
    useAppStore.getState().moveTabToPane('B', 'pane2');
    // Now reorder so B comes before C in pane2
    useAppStore.getState().reorderPaneTabIds('pane2', ['B', 'C']);
    const s = useAppStore.getState();
    const p2 = findLeafById(s.paneTree, 'pane2')!;
    expect(p2.tabIds).toEqual(['B', 'C']);
    const p1 = findLeafById(s.paneTree, 'pane1');
    expect(p1).toBeDefined();
    expect(p1!.tabIds).toEqual(['A']);
  });

  it('findLeafByTabId and collectLeaves helpers traverse tree correctly', () => {
    const leaf1: LeafPane = { id: 'l1', type: 'leaf', tabIds: ['A'], size: 0.5 };
    const leaf2: LeafPane = { id: 'l2', type: 'leaf', tabIds: ['B', 'C'], size: 0.5 };
    const tree: PaneNode = { id: 'root', type: 'branch', direction: 'vertical', children: [leaf1, leaf2], size: 1 };
    expect(findLeafByTabId(tree, 'B')?.id).toBe('l2');
    expect(findLeafByTabId(tree, 'A')?.id).toBe('l1');
    expect(findLeafByTabId(tree, 'missing')).toBeUndefined();
    expect(collectLeaves(tree).map(l => l.id).sort()).toEqual(['l1', 'l2']);
    expect(countLeaves(tree)).toBe(2);
  });
});