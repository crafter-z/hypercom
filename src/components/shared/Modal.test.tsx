// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Modal from './Modal';

let host: HTMLDivElement;
let root: Root;
const key = async (target: HTMLElement, value: string, shiftKey = false) => {
  const event = new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true });
  await act(async () => target.dispatchEvent(event));
  return event;
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('shared dialog lifecycle', () => {
  it('excludes hidden ancestors and collapsed details from its Tab cycle, but includes summary', async () => {
    await act(async () => root.render(<Modal open label="test">
      <button id="first">first</button>
      <details><summary id="summary">details</summary><button id="collapsed">collapsed</button></details>
      <div hidden><button>hidden</button></div>
      <div style={{ display: 'none' }}><button>display none</button></div>
      <div aria-hidden="true"><button>aria hidden</button></div>
    </Modal>));
    const first = host.querySelector<HTMLButtonElement>('#first')!;
    const summary = host.querySelector<HTMLElement>('#summary')!;
    expect(document.activeElement).toBe(first);
    await key(first, 'Tab', true);
    expect(document.activeElement).toBe(summary);
    await key(summary, 'Tab');
    expect(document.activeElement).toBe(first);
  });

  it('keeps a simultaneously mounted child in charge and restores its parent on close', async () => {
    function Example() {
      const [child, setChild] = useState(true);
      return <Modal open label="parent"><button id="parent">parent</button>
        <Modal open={child} label="child" onClose={() => setChild(false)}><button id="child">child</button></Modal>
      </Modal>;
    }
    await act(async () => root.render(<Example />));
    expect(document.activeElement).toBe(host.querySelector('#child'));
    await key(document.activeElement as HTMLElement, 'Escape');
    expect(host.querySelector('[aria-label="child"]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('#parent'));
  });

  it('lets only the newest dialog handle Escape even if focus was moved outside', async () => {
    const parentClose = vi.fn(), childClose = vi.fn();
    await act(async () => root.render(<><Modal open label="parent" onClose={parentClose}><button>parent</button></Modal>
      <Modal open label="child" onClose={childClose}><button>child</button></Modal></>));
    document.body.tabIndex = -1;
    document.body.focus();
    await key(document.body, 'Escape');
    expect(childClose).toHaveBeenCalledOnce();
    expect(parentClose).not.toHaveBeenCalled();
    document.body.removeAttribute('tabindex');
  });

  it('consumes disabled Escape rather than leaking it to another handler', async () => {
    const close = vi.fn();
    await act(async () => root.render(<Modal open label="working" disableEscape onClose={close}><button>working</button></Modal>));
    const event = await key(document.activeElement as HTMLElement, 'Escape');
    expect(event.defaultPrevented).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });

  it('respects a descendant that already consumed Tab', async () => {
    await act(async () => root.render(<Modal open label="test"><button>first</button>
      <button id="last" onKeyDown={event => event.preventDefault()}>last</button></Modal>));
    const last = host.querySelector<HTMLButtonElement>('#last')!;
    last.focus();
    await key(last, 'Tab');
    expect(document.activeElement).toBe(last);
  });
});
