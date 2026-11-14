// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RuleSetAccordion, { type RuleSetAccordionProps } from './RuleSetAccordion';

type Item = { id: string; name: string };

type SortableMockProps = {
  items: Item[];
  renderItem: (item: Item, index: number, handle: ReactNode) => ReactNode;
};

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../shared/SortableEditorList', () => ({
  default: ({ items, renderItem }: SortableMockProps) => createElement(
    'div',
    { 'data-testid': 'sortable-list' },
    items.map((item, index) => createElement('div', { key: item.id }, renderItem(item, index, createElement('button', { type: 'button', 'aria-label': 'drag' })))),
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const items: Item[] = [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }];
let root: Root;
let container: HTMLDivElement;

function props(overrides: Partial<RuleSetAccordionProps<Item>> = {}): RuleSetAccordionProps<Item> {
  return {
    title: 'Title',
    description: 'Description',
    addLabel: 'Add',
    emptyText: 'Empty',
    items,
    selectedId: null,
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onInsert: vi.fn(),
    onReorder: vi.fn(),
    onDelete: vi.fn(),
    onSave: vi.fn(async () => true),
    onDiscard: vi.fn(),
    onRename: vi.fn(),
    dirty: false,
    isDirty: () => false,
    saving: false,
    error: null,
    renderEditor: () => null,
    ...overrides,
  };
}

function render(overrides: Partial<RuleSetAccordionProps<Item>> = {}) {
  act(() => { root.render(createElement(RuleSetAccordion, props(overrides))); });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe('RuleSetAccordion actions', () => {
  it('does not render clean page or row save/discard controls or a saved status', () => {
    render();

    expect(container.querySelector('.editor-status')).toBeNull();
    expect(container.querySelector('[aria-label="configModal.pageSave"]')).toBeNull();
    expect(container.querySelector('[aria-label="configModal.pageDiscard"]')).toBeNull();
    expect(container.querySelector('[aria-label="configModal.rowSave"]')).toBeNull();
    expect(container.querySelector('[aria-label="configModal.rowDiscard"]')).toBeNull();
    expect(container.textContent).not.toContain('editor.saved');
  });

  it('renders page actions for a dirty row and row actions only for dirty rows', () => {
    render({ dirty: true, isDirty: id => id === 'one' });

    expect(container.querySelector('.editor-status')).not.toBeNull();
    expect(container.querySelector('[aria-label="configModal.pageSave"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="configModal.pageDiscard"]')).not.toBeNull();
    expect(container.querySelectorAll('[aria-label="configModal.rowSave"]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-label="configModal.rowDiscard"]')).toHaveLength(1);
  });

  it('keeps page actions for a reorder even when no row is dirty', () => {
    render({ dirty: true });

    expect(container.querySelector('[aria-label="configModal.pageSave"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="configModal.pageDiscard"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="configModal.rowSave"]')).toBeNull();
    expect(container.querySelector('[aria-label="configModal.rowDiscard"]')).toBeNull();
  });

  it('keeps saving status and disables dirty actions while saving', () => {
    render({ dirty: true, isDirty: () => true, saving: true });

    expect(container.textContent).toContain('editor.saving');
    expect(container.querySelector<HTMLButtonElement>('[aria-label="configModal.pageSave"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="configModal.pageDiscard"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="configModal.rowSave"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="configModal.rowDiscard"]')?.disabled).toBe(true);
  });

  it('keeps the error alert visible for a failed save', () => {
    render({ error: 'editor.saveFailed' });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('editor.saveFailed');
  });
});
