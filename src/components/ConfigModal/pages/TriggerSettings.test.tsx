// @vitest-environment jsdom
/**
 * Trigger settings UI contract tests.
 *
 * These tests intentionally describe the target trigger-page refactor rather than
 * the pre-refactor accordion. The page currently has no search/filter/duplicate
 * controls, so a red run is expected until the new UI is integrated.
 *
 * Target DOM assumptions (kept deliberately small and semantic):
 * - one search input: data-testid="trigger-search";
 * - one select with values all/enabled/disabled: data-testid="trigger-filter";
 * - each visible rule has data-testid="trigger-rule-<id>";
 * - each rule's duplicate action is data-testid="trigger-duplicate-<id>";
 * - the explicit page save action keeps aria-label="configModal.pageSave"
 *   (data-testid="trigger-save" is also accepted by the helper).
 *
 * Duplicate means creating a new draft entity; it must not use the system
 * clipboard. Editing, enabling, reordering, and duplication remain drafts until
 * the explicit page save action is clicked. The mocked entity-page boundary below
 * lets this test stay independent of persistence and Tauri IPC.
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriggerRule } from '../../../types';
import TriggerSettings from './TriggerSettings';

interface MockPage {
  items: TriggerRule[];
  expandedId: string | null;
  toggleExpanded: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  reorder: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  discard: ReturnType<typeof vi.fn>;
  dirty: boolean;
  isDirty: ReturnType<typeof vi.fn>;
  saving: boolean;
  error: string | null;
}

const mocks = vi.hoisted(() => ({
  page: null as MockPage | null,
  ports: [] as Array<{ id: string; name: string; alias?: string }>,
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../stores/useAppStore', () => ({
  useAppStore: (selector: (state: { ports: typeof mocks.ports }) => unknown) => selector({ ports: mocks.ports }),
}));
vi.mock('../hooks/useEntityPage', () => ({
  useEntityPage: () => mocks.page,
}));
// Keep row rendering deterministic and avoid coupling this contract suite to dnd-kit.
vi.mock('../../shared/SortableEditorList', () => ({
  default: ({ items, renderItem }: {
    items: TriggerRule[];
    renderItem: (item: TriggerRule, index: number, handle: ReactNode) => ReactNode;
  }) => createElement(
    'div',
    { 'data-testid': 'sortable-list' },
    items.map((item, index) => createElement(
      'div',
      { key: item.id, 'data-testid': `trigger-rule-${item.id}` },
      renderItem(item, index, createElement('button', { type: 'button', 'aria-label': `drag-${item.id}` })),
    )),
  ),
}));

const makeRule = (id: string, overrides: Partial<TriggerRule> = {}): TriggerRule => ({
  id,
  name: id === 'alpha' ? 'Error Alert' : id === 'beta' ? 'Timeout Reply' : 'Protocol Warning',
  pattern: id === 'alpha' ? 'ERROR' : id === 'beta' ? 'TIMEOUT' : 'WARN',
  isRegex: false,
  matchType: 'contains',
  actionType: id === 'beta' ? 'respond' : 'alert',
  actionContent: id === 'beta' ? 'retry' : id === 'alpha' ? 'notify' : 'audit',
  actionIsHex: false,
  isEnabled: id !== 'beta',
  ...overrides,
});

let container: HTMLDivElement;
let root: Root;

function createPage(items = [makeRule('alpha'), makeRule('beta'), makeRule('gamma')]): MockPage {
  const page: MockPage = {
    items,
    expandedId: 'alpha',
    toggleExpanded: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    reorder: vi.fn(),
    save: vi.fn(async () => true),
    discard: vi.fn(),
    dirty: true,
    isDirty: vi.fn(() => true),
    saving: false,
    error: null,
  };
  // The mock boundary is intentionally callback-based: production owns draft
  // insertion; the test only verifies the new entity passed to that boundary.
  return page;
}

function required(selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector);
  expect(element, `expected ${selector}`).not.toBeNull();
  return element!;
}

function requiredTestId(id: string): HTMLElement {
  return required(`[data-testid="${id}"]`);
}

async function render(): Promise<void> {
  await act(async () => root.render(createElement(TriggerSettings)));
}

async function changeInput(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function changeSelect(element: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  mocks.page = createPage();
  mocks.ports = [{ id: 'COM1', name: 'COM1' }];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  mocks.page = null;
});

describe('search and filtering', () => {
  it('searches rule name/pattern/action text without mutating drafts', async () => {
    await render();
    const search = requiredTestId('trigger-search') as HTMLInputElement;

    await changeInput(search, 'timeout');

    expect(container.querySelector('[data-testid="trigger-rule-beta"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="trigger-rule-alpha"]')).toBeNull();
    expect(container.querySelector('[data-testid="trigger-rule-gamma"]')).toBeNull();
    expect(mocks.page!.update).not.toHaveBeenCalled();
    expect(mocks.page!.save).not.toHaveBeenCalled();
  });

  it('filters by enabled state while retaining all rules as drafts', async () => {
    await render();
    const filter = requiredTestId('trigger-filter') as HTMLSelectElement;

    await changeSelect(filter, 'enabled');

    expect(container.querySelector('[data-testid="trigger-rule-alpha"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="trigger-rule-gamma"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="trigger-rule-beta"]')).toBeNull();
    expect(mocks.page!.update).not.toHaveBeenCalled();
    expect(mocks.page!.save).not.toHaveBeenCalled();
  });
});

describe('duplicate and explicit save', () => {
  it('duplicates a rule into a new draft entity rather than using the clipboard', async () => {
    await render();
    const source = mocks.page!.items[0];
    const duplicate = requiredTestId(`trigger-duplicate-${source.id}`);

    await act(async () => duplicate.click());

    expect(mocks.page!.create).toHaveBeenCalledTimes(1);
    const [copy] = mocks.page!.create.mock.calls[0] as [TriggerRule, string?];
    expect(copy.id).toEqual(expect.any(String));
    expect(copy.id).not.toBe(source.id);
    expect(copy).toMatchObject({
      pattern: source.pattern,
      isRegex: source.isRegex,
      matchType: source.matchType,
      actionType: source.actionType,
      actionContent: source.actionContent,
      actionIsHex: source.actionIsHex,
      isEnabled: source.isEnabled,
    });
    expect(copy).not.toBe(source);
    expect(mocks.page!.save).not.toHaveBeenCalled();
  });

  it('keeps edits staged and only calls collection save from the explicit save action', async () => {
    await render();
    const pattern = required(`input#trigger-pattern-${mocks.page!.items[0].id}`) as HTMLInputElement;

    await changeInput(pattern, 'FATAL');
    await Promise.resolve();
    expect(mocks.page!.update).toHaveBeenCalledWith(mocks.page!.items[0].id, { pattern: 'FATAL' });
    expect(mocks.page!.save).not.toHaveBeenCalled();

    const save = container.querySelector<HTMLElement>('[data-testid="trigger-save"]')
      ?? container.querySelector<HTMLElement>('[aria-label="configModal.pageSave"]');
    expect(save, 'expected explicit trigger page save control').not.toBeNull();
    await act(async () => save!.click());
    expect(mocks.page!.save).toHaveBeenCalledTimes(1);
    expect(mocks.page!.save.mock.calls[0]).toEqual([]);
  });
});

it('does not save a dirty draft merely because the page unmounts', async () => {
  await render();
  const pattern = required(`input#trigger-pattern-${mocks.page!.items[0].id}`) as HTMLInputElement;
  await changeInput(pattern, 'FATAL');
  expect(mocks.page!.save).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  expect(mocks.page!.save).not.toHaveBeenCalled();
});

