// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SendCommand } from '../../../types';
import { createCommandStep } from '../../../utils/commandSteps';
import SendCmdEditor from './SendCmdEditor';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const change = vi.fn();
const remove = vi.fn();
const legacy: SendCommand = { id: 's', name: 'Old', order: 0, delay: 100, type: 'string', content: 'AT', appendLineEnding: '\\r\\n' };

function render(cmd: SendCommand, props: { isRoundFinal?: boolean; loops?: boolean; onFoldIntoRoundGap?: () => void } = {}): void {
  act(() => { root.render(createElement(SendCmdEditor, { cmd, cmdIdx: 0, onChange: change, onDelete: remove, ...props })); });
}
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('command step editor', () => {
  it('renders legacy commands as sends without rewriting them on mount', () => {
    render(legacy);
    expect(container.querySelector<HTMLSelectElement>('[aria-label="sendCmdEditor.stepKind"]')?.value).toBe('send');
    expect(container.querySelector<HTMLInputElement>('[aria-label="sendCmdEditor.contentPlaceholder"]')?.value).toBe('AT');
    expect(change).not.toHaveBeenCalled();
  });

  it('labels the bare delay as a readable "wait after" with unit and consequence', () => {
    render(legacy);
    // 用户不该看到一个没有含义的 100：控件有标签、有单位，并读成一句人话。
    const delay = container.querySelector<HTMLInputElement>('[aria-label="sendCmdEditor.afterDelayLabel"]');
    expect(delay?.value).toBe('100');
    expect(container.textContent).toContain('sendCmdEditor.afterDelayLabel');
    expect(container.textContent).toContain('sendCmdEditor.delayUnit');
    expect(container.textContent).toContain('sendCmdEditor.gapAnnotation');
  });

  it('keeps normal wait explanations accessible without spending another visible row', () => {
    render(legacy);
    const delay = container.querySelector<HTMLInputElement>('[aria-label="sendCmdEditor.afterDelayLabel"]')!;
    const hint = document.getElementById(delay.getAttribute('aria-describedby')!);
    expect(hint?.className).toBe('command-sr-only');
    expect(hint?.textContent).toContain('sendCmdEditor.gapAnnotation');
    expect(container.querySelector('.after-delay-field-compact')).not.toBeNull();
    render(legacy, { isRoundFinal: true, loops: true, onFoldIntoRoundGap: vi.fn() });
    expect(container.querySelector('.command-delay-note')?.textContent).toContain('sendCmdEditor.roundFinalDelayInactive');
    expect(container.querySelector('.command-delay-note')?.textContent).toContain('sendCmdEditor.foldIntoRoundGap');
  });

  it('says "continue immediately" when there is no wait', () => {
    render({ ...legacy, delay: 0 });
    expect(container.textContent).toContain('sendCmdEditor.gapImmediate');
    expect(container.textContent).not.toContain('sendCmdEditor.gapAnnotation');
  });

  it('explains why the round-final wait does not apply, per round policy', () => {
    // 会跑多轮：轮末边界用「轮间间隔」。
    render(legacy, { isRoundFinal: true, loops: true });
    expect(container.textContent).toContain('sendCmdEditor.roundFinalDelayInactive');
    expect(container.textContent).not.toContain('sendCmdEditor.gapAnnotation');
    // 只跑一轮：流程到此结束，这个值同样无处生效。
    render(legacy, { isRoundFinal: true, loops: false });
    expect(container.textContent).toContain('sendCmdEditor.roundFinalDelayRunEnds');
    // 轮末且 delay 为 0 时不必再解释什么。
    render({ ...legacy, delay: 0 }, { isRoundFinal: true, loops: true });
    expect(container.textContent).not.toContain('sendCmdEditor.roundFinalDelayInactive');
  });

  it('offers folding the round-final wait into the round gap only when it can apply', () => {
    const fold = vi.fn();
    const foldButton = () => Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('sendCmdEditor.foldIntoRoundGap'));

    render(legacy, { isRoundFinal: true, loops: true, onFoldIntoRoundGap: fold });
    const button = foldButton();
    expect(button).toBeDefined();
    act(() => button!.click());
    expect(fold).toHaveBeenCalledOnce();

    // 单轮集合没有轮间间隔；非轮末步骤也不该出现这个动作。
    render(legacy, { isRoundFinal: true, loops: false, onFoldIntoRoundGap: fold });
    expect(foldButton()).toBeUndefined();
    render(legacy, { isRoundFinal: false, loops: true, onFoldIntoRoundGap: fold });
    expect(foldButton()).toBeUndefined();
  });

  it('labels the send fields and patches format and line ending without changing content', () => {
    render(legacy);
    const format = container.querySelector<HTMLSelectElement>('[aria-label="quickSend.format"]')!;
    const ending = container.querySelector<HTMLSelectElement>('[aria-label="quickSend.lineEnding"]')!;
    expect(format.closest('label')?.textContent).toContain('quickSend.format');
    expect(ending.closest('label')?.textContent).toContain('quickSend.lineEnding');
    expect(ending.value).toBe(legacy.appendLineEnding);
    act(() => { format.value = 'hex'; format.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(change).toHaveBeenLastCalledWith({ type: 'hex' });
    act(() => { ending.value = 'None'; ending.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(change).toHaveBeenLastCalledWith({ appendLineEnding: 'None' });
  });

  it('keeps the content input and focus stable while its draft rerenders', () => {
    render(legacy);
    const content = container.querySelector<HTMLInputElement>('[aria-label="sendCmdEditor.contentPlaceholder"]')!;
    content.focus();
    render({ ...legacy, content: 'AT+VERSION' });
    expect(container.querySelector('[aria-label="sendCmdEditor.contentPlaceholder"]')).toBe(content);
    expect(document.activeElement).toBe(content);
    expect(content.value).toBe('AT+VERSION');
  });

  it('changes action kind explicitly and keeps the step timing', () => {
    render(legacy);
    const select = container.querySelector<HTMLSelectElement>('[aria-label="sendCmdEditor.stepKind"]')!;
    act(() => { select.value = 'setParams'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    // delay 是位置属性，不随动作类型切换被清除（这里不改写 cmd，故不含 delay 键）。
    expect(change).toHaveBeenCalledWith({ kind: 'setParams', baudRate: 230400 });
  });

  it('shows the local baud field and still exposes timing for parameter steps', () => {
    render(createCommandStep('setParams', 'p', 'Params'));
    expect(container.querySelector<HTMLInputElement>('[aria-label="sendCmdEditor.baudRate"]')?.value).toBe('230400');
    expect(container.querySelector<HTMLInputElement>('[aria-label="sendCmdEditor.afterDelayLabel"]')?.value).toBe('0');
    expect(container.querySelector('[aria-label="sendCmdEditor.contentPlaceholder"]')).toBeNull();
    expect(container.textContent).toContain('sendCmdEditor.paramsHint');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="sendCmdEditor.delete"]')!.click());
    expect(remove).toHaveBeenCalledOnce();
  });

  it('does not render an unknown imported action as a send', () => {
    render({ ...legacy, kind: 'future' } as unknown as SendCommand);
    expect(container.querySelector('[aria-label="sendCmdEditor.contentPlaceholder"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('editor.unknownCommandStep');
    expect(container.querySelector('[aria-label="sendCmdEditor.afterDelayLabel"]')).toBeNull();
  });

  it('does not offer the removed standalone wait action', () => {
    render(legacy);
    const kind = container.querySelector<HTMLSelectElement>('[aria-label="sendCmdEditor.stepKind"]')!;
    expect(Array.from(kind.options).map(option => option.value)).toEqual(['send', 'setParams']);
  });
});
