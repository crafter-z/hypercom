// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../stores/useAppStore';
import { useOperationStore } from '../../stores/useOperationStore';
import { useSystemStore } from '../../stores/useSystemStore';
import { resetStoresForTests } from '../../stores/resetStores';
import { resetFlowRuntime, setFlowStatus } from '../../utils/flowRuntime';
import OperationPanel, { FlowRunningBadge } from './OperationPanel';
import { serialService } from '../../services/tauri';

/**
 * 折叠态流程徽标：操作面板收起后，运行中的增强流程必须仍然可见并可停止。
 * 这些 mock 只为把 OperationPanel 之外的副作用挡掉；被断言的是折叠态接线本身。
 */
// i18n 由 `src/i18n.ts` 在模块加载时初始化（经 useToastStore 传递进来），
// 所以 mock 必须同时提供 `initReactI18next` 这个插件桩。
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../hooks', () => ({
  useSerialSend: () => ({ sendData: vi.fn(async () => 0), historyUp: () => null, historyDown: () => null }),
  useSerialConnection: () => ({ toggleConnection: vi.fn(async () => {}) }),
}));
vi.mock('./hooks/useCyclicSend', () => ({ useCyclicSend: () => undefined }));
vi.mock('../MainDisplay/hooks/useLogReplay', () => ({
  useLogReplay: () => ({
    picked: null, isImporting: false, isPicking: false,
    startImport: vi.fn(), confirmImport: vi.fn(), cancelImport: vi.fn(),
  }),
}));
vi.mock('../../services/tauri', () => ({
  serialService: { setSerialParams: vi.fn(async () => {}), setFlowControl: vi.fn(async () => {}) },
  logService: { pickAndSaveLog: vi.fn(), getLogFiles: vi.fn(async () => []), openPath: vi.fn(), openLogDirectory: vi.fn() },
}));
vi.mock('./SendSection', () => ({ default: () => null }));
vi.mock('./ParamsSection', () => ({ default: () => null }));
vi.mock('./ReplayImportDialog', () => ({ default: () => null }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

const runningFlow = (step?: number, totalSteps?: number) => ({
  portId: 'COM1', runId: 'run-1', phase: 'running' as const, exclusive: true, step, totalSteps,
});

function renderPanel(): Promise<void> {
  return act(async () => { root.render(createElement(OperationPanel)); });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStoresForTests();
  resetFlowRuntime();
  useAppStore.setState({
    ports: [{ id: 'COM1', name: 'COM1', status: 'connected', type: 'real', isHidden: false, mode: 'trx' }],
  });
  useAppStore.setState({ activeTabId: useAppStore.getState().openTab('COM1') });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  resetFlowRuntime();
  vi.useRealTimers();
});

describe('FlowRunningBadge', () => {
  it('renders the badge with step progress and an accessible stop button', async () => {
    const stop = vi.fn();
    await act(async () => {
      root.render(createElement(FlowRunningBadge, { step: 2, totalSteps: 5, onStop: stop }));
    });
    expect(container.textContent).toContain('operationPanel.flowBadge');
    expect(container.textContent).toContain('operationPanel.flowBadgeStep');
    const button = container.querySelector<HTMLButtonElement>('[aria-label="operationPanel.flowStop"]');
    expect(button?.type).toBe('button');
    expect(button?.title).toBe('operationPanel.flowStop');
    await act(async () => { button!.click(); });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('shows the badge text only when no step progress is published', async () => {
    await act(async () => {
      root.render(createElement(FlowRunningBadge, { onStop: vi.fn() }));
    });
    expect(container.textContent).toContain('operationPanel.flowBadge');
    expect(container.textContent).not.toContain('operationPanel.flowBadgeStep');
  });

  it('does not bubble the stop click into the header collapse handler', async () => {
    const collapse = vi.fn();
    const stop = vi.fn();
    await act(async () => {
      root.render(createElement('div', { onClick: collapse },
        createElement(FlowRunningBadge, { step: 1, totalSteps: 3, onStop: stop })));
    });
    const button = container.querySelector<HTMLButtonElement>('[aria-label="operationPanel.flowStop"]')!;
    await act(async () => { button.click(); });
    expect(stop).toHaveBeenCalledTimes(1);
    // 关键：停止流程不能顺带把面板展开/收起。
    expect(collapse).not.toHaveBeenCalled();

    // 徽标文本本身仍属于 header（点它会切换收起），这是有意的。
    await act(async () => { (container.querySelector('.op-flow-badge-text') as HTMLElement).click(); });
    expect(collapse).toHaveBeenCalledTimes(1);
  });
});

describe('OperationPanel collapsed flow badge', () => {
  it('appears while collapsed with a running flow and stops the focused port loop', async () => {
    useSystemStore.getState().setUIState({ isOperationPanelCollapsed: true });
    useOperationStore.getState().setCyclicLoop('COM1', true);
    setFlowStatus(runningFlow(2, 5));

    await renderPanel();
    expect(container.querySelector('.op-flow-badge')).not.toBeNull();
    expect(container.textContent).toContain('operationPanel.flowBadgeStep');

    const button = container.querySelector<HTMLButtonElement>('[aria-label="operationPanel.flowStop"]')!;
    await act(async () => { button.click(); });
    expect(useOperationStore.getState().cyclicLoops.COM1).toBeFalsy();
    // 点停止不应把面板展开（header 的 onClick 必须被挡掉）。
    expect(useSystemStore.getState().ui.isOperationPanelCollapsed).toBe(true);
  });

  it('appears when the flow starts after the panel was already collapsed', async () => {
    useSystemStore.getState().setUIState({ isOperationPanelCollapsed: true });
    await renderPanel();
    expect(container.querySelector('.op-flow-badge')).toBeNull();

    await act(async () => { setFlowStatus(runningFlow(1, 4)); });
    expect(container.querySelector('.op-flow-badge')).not.toBeNull();
  });

  it('renders nothing while collapsed without a running flow', async () => {
    useSystemStore.getState().setUIState({ isOperationPanelCollapsed: true });
    await renderPanel();
    expect(container.querySelector('.op-flow-badge')).toBeNull();

    // 终止态（已完成/已失败）不属于「正在运行」，折叠态同样不显示。
    await act(async () => {
      setFlowStatus({ portId: 'COM1', runId: 'run-2', phase: 'completed', exclusive: true });
    });
    expect(container.querySelector('.op-flow-badge')).toBeNull();
  });

  it('keeps the active target context visible in the panel header', async () => {
    await renderPanel();
    expect(container.querySelector('.operation-panel-port-name')?.textContent).toBe('COM1');
    expect(container.querySelector('.operation-panel-port-meta')?.textContent).toContain('paramsSection.baudRateLabel');
  });

  it('does not duplicate the badge in the expanded panel', async () => {
    useSystemStore.getState().setUIState({ isOperationPanelCollapsed: false });
    setFlowStatus(runningFlow(1, 4));
    await renderPanel();
    // 展开态由 SendSection 的 `.op-flow-status` 承担，这里不重复。
    expect(container.querySelector('.op-flow-badge')).toBeNull();
  });
});

describe('confirmed command parameter updates', () => {
  async function setupParams() {
    vi.useFakeTimers();
    useAppStore.getState().updatePort('COM1', { baudRate: 9600, dataBits: 8, parity: 'None', stopBits: 'One', handshake: 'None', connectionGeneration: 7 });
    await renderPanel();
  }

  it('adopts an executor confirmation without applying the same baud again after debounce', async () => {
    await setupParams();
    await act(async () => {
      useAppStore.getState().updatePort('COM1', { baudRate: 230400 });
      useOperationStore.getState().setOpState({ baudRate: 230400 });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(serialService.setSerialParams).not.toHaveBeenCalled();
    expect(serialService.setFlowControl).not.toHaveBeenCalled();
  });

  it('still applies a real manual edit once, with its captured connection generation', async () => {
    await setupParams();
    await act(async () => { useOperationStore.getState().setOpState({ baudRate: 230400 }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(serialService.setSerialParams).toHaveBeenCalledExactlyOnceWith('COM1', expect.objectContaining({ baudRate: 230400, expectedGeneration: 7 }));
  });

  it('does not mistake missing framing metadata for confirmation of a manual data-bit edit', async () => {
    await setupParams();
    await act(async () => { useAppStore.getState().updatePort('COM1', { dataBits: undefined }); });
    await act(async () => { useOperationStore.getState().setOpState({ dataBits: 7 }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(serialService.setSerialParams).toHaveBeenCalledExactlyOnceWith('COM1', expect.objectContaining({ baudRate: 9600, dataBits: 7 }));
  });

  it.each(['flow', 'reconnect'])('retires a queued manual edit before %s can be affected', async reason => {
    await setupParams();
    await act(async () => { useOperationStore.getState().setOpState({ baudRate: 230400 }); });
    await act(async () => {
      if (reason === 'flow') setFlowStatus({ portId: 'COM1', runId: 'quick', phase: 'applyingParams', exclusive: true });
      else useAppStore.getState().updatePort('COM1', { connectionGeneration: 8 });
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(serialService.setSerialParams).not.toHaveBeenCalled();
  });
});
