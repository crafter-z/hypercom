// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimelineButton, TimelineWorkspace, openTimelinePanel } from './TimelineControls';
import { timelineCoordinator, HOST_CLOCK_ID, type TimelineParticipant } from '../../utils/timeline';
import { useAppStore } from '../../stores/useAppStore';
import { resetStoresForTests } from '../../stores/resetStores';
import type { TabItem } from '../../types';

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../shared/usePluginViewOverlay', () => ({ usePluginViewOverlay: () => true }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tab = (id: string): TabItem => ({ id, title: id.toUpperCase(), isPinned: false, splitPaneId: 'main', kind: 'serial', portId: `PORT:${id}` });
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetStoresForTests();
  useAppStore.setState({ tabs: [tab('a'), tab('b'), tab('c')], ports: [] });
  // The timeline scheduler wakes on rAF; keep every publish inside `act` instead of
  // letting a scheduled frame land after the assertions.
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const group of timelineCoordinator.getSnapshot().groups) timelineCoordinator.deleteGroup(group.id);
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(slot: string) {
  await act(async () => { openTimelinePanel(slot); root.render(createElement(TimelineWorkspace)); });
}
const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === text);

describe('time group lifecycle stays in the panel body', () => {
  it('offers dissolution without expanding Advanced', async () => {
    const id = timelineCoordinator.createGroup({ name: 'G1', memberSlots: ['a', 'b'] });
    await mount('a');
    const advanced = container.querySelector('details.timeline-advanced');
    expect(advanced).not.toBeNull();
    expect(advanced!.hasAttribute('open')).toBe(false);
    const dissolve = button('timeline.deleteGroup');
    expect(dissolve).toBeDefined();
    // The dissolve control lives in the group bar, not behind the collapsed disclosure.
    expect(advanced!.contains(dissolve!)).toBe(false);
    await act(async () => dissolve!.click());
    expect(timelineCoordinator.getSnapshot().groups.some(group => group.id === id)).toBe(false);
  });

  it('removes only the current view when the group keeps at least two members', async () => {
    const id = timelineCoordinator.createGroup({ name: 'G1', memberSlots: ['a', 'b', 'c'] });
    await mount('a');
    await act(async () => button('timeline.leaveGroup')!.click());
    const group = timelineCoordinator.getSnapshot().groups.find(item => item.id === id);
    expect(group?.memberSlots).toEqual(['b', 'c']);
  });

  it('dissolves instead of stranding a one-member group', async () => {
    timelineCoordinator.createGroup({ name: 'G1', memberSlots: ['a', 'b'] });
    await mount('a');
    expect(button('timeline.leaveGroup')).toBeUndefined();
    await act(async () => button('timeline.deleteGroup')!.click());
    expect(timelineCoordinator.getSnapshot().groups).toHaveLength(0);
  });

  it('explains an empty member selection instead of leaving a dead save button', async () => {
    timelineCoordinator.createGroup({ name: 'G1', memberSlots: ['a', 'b'] });
    await mount('a');
    expect(container.querySelector('.timeline-footer-hint')).toBeNull();
    const boxes = () => [...container.querySelectorAll<HTMLInputElement>('.timeline-member-row input')];
    while (boxes().some(box => box.checked)) {
      const box = boxes().find(item => item.checked)!;
      await act(async () => box.click());
    }
    expect(container.querySelector('.timeline-footer-hint')?.textContent).toBe('timeline.noMembersHint');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  });
});

describe('misalignment stays visible in the panel body', () => {
  const participant = (slotId: string, clockId: string): TimelineParticipant => ({
    participantId: `p-${slotId}`, slotId, sourceId: `serial:PORT:${slotId}`, sourceKind: 'live',
    generation: 1, sourceGeneration: 1, clockId,
    capabilities: { preview: 'bounded', canDrive: true },
    readAnchor: () => null,
    seek: () => ({ status: 'exact' as const, actualTimeMs: 0 }),
  });

  it('reports an unusable group instead of a silent no-op', async () => {
    timelineCoordinator.createGroup({ name: 'G1', memberSlots: ['a', 'b'] });
    await mount('a');
    expect(container.querySelector('.timeline-notice')?.textContent).toBe('timeline.allUnavailable');
    expect(container.querySelector('.timeline-group-status')?.textContent).toBe('timeline.misalignedCount');
  });

  it('keeps a clock mismatch a behavioural fallback instead of a panel prompt', async () => {
    const host = timelineCoordinator.registerParticipant(participant('a', HOST_CLOCK_ID));
    const device = timelineCoordinator.registerParticipant(participant('b', 'device-uptime'));
    timelineCoordinator.createGroup({ name: 'G1', memberSlots: ['a', 'b'] });
    await mount('a');
    // No prompt: the mismatch only shows up as this member not following, with a neutral chip.
    expect(container.querySelectorAll('.timeline-notice')).toHaveLength(0);
    const chip = [...container.querySelectorAll('.timeline-member-status')]
      .find(node => node.textContent === 'timeline.status.unavailable');
    expect(chip).toBeDefined();
    // The machine reason is not surfaced in the panel body; Advanced diagnostics keep it.
    expect(chip?.getAttribute('title')).toBeNull();
    expect(container.querySelector('.timeline-group-status')?.textContent).toBe('timeline.misalignedCount');
    await act(async () => { host.dispose(); device.dispose(); });
  });

  it('stays silent when the whole group is unusable only because clocks differ', async () => {
    const host = timelineCoordinator.registerParticipant(participant('a', HOST_CLOCK_ID));
    const device = timelineCoordinator.registerParticipant(participant('b', HOST_CLOCK_ID));
    timelineCoordinator.createGroup({ name: 'G1', memberSlots: ['a', 'b'] });
    await mount('a');
    expect(container.querySelectorAll('.timeline-notice')).toHaveLength(0);
    // A clock reset on every source leaves the group unusable, which stays a behavioural state.
    await act(async () => {
      host.updateSourceGeneration(2, 'reset-1');
      device.updateSourceGeneration(2, 'reset-1');
    });
    expect(container.querySelectorAll('.timeline-notice')).toHaveLength(0);
    expect(container.querySelector('.timeline-group-status')?.textContent).toBe('timeline.misalignedCount');
    await act(async () => { host.dispose(); device.dispose(); });
  });

  it('keeps a settled status while a new seek is queued, so the badge cannot flicker', async () => {
    // A LIVE group re-enqueues a seek every ~66ms, so `pending`/`inFlight` toggle
    // constantly: the badge must be driven by settled fields only.
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    const drain = async () => {
      await act(async () => {
        for (let round = 0; round < 8; round++) {
          for (const callback of [...frames.values()]) callback(0);
          frames.clear();
          await Promise.resolve();
        }
      });
    };
    const seek = () => ({ status: 'before-range' as const, actualTimeMs: 0 });
    const host = timelineCoordinator.registerParticipant({ ...participant('a', HOST_CLOCK_ID), seek });
    const follower = timelineCoordinator.registerParticipant({ ...participant('b', HOST_CLOCK_ID), seek });
    const id = timelineCoordinator.createGroup({ name: 'G1', memberSlots: ['a', 'b'], anchor: { timeMs: 100 } });
    await mount('a');
    await drain();
    const chips = () => [...container.querySelectorAll<HTMLElement>('.timeline-member-status')]
      .map(node => `${node.textContent}|misaligned=${node.classList.contains('is-misaligned')}`);
    // Both the text and the tone class must stay put: only the class flips first, and that
    // is what made the badge blink between「对齐中…」and its real status.
    const settled = ['timeline.status.before-range|misaligned=true', 'timeline.status.before-range|misaligned=true'];
    expect(chips()).toEqual(settled);
    await act(async () => { timelineCoordinator.seek(id, 500); });
    expect(timelineCoordinator.getSnapshot().groups[0].members.some(member => member.pending || member.inFlight)).toBe(true);
    expect(chips()).toEqual(settled);
    await drain();
    expect(chips()).toEqual(settled);
    await act(async () => { host.dispose(); follower.dispose(); });
  });

  it('stays silent for a group that never got an anchor instead of an endless "aligning"', async () => {
    // A group created on an empty (or fully filtered) terminal samples no anchor, so the
    // coordinator never broadcasts: no member gets a status and no seek is ever queued.
    const seek = () => ({ status: 'before-range' as const, actualTimeMs: 0 });
    const host = timelineCoordinator.registerParticipant({ ...participant('a', HOST_CLOCK_ID), seek });
    const follower = timelineCoordinator.registerParticipant({ ...participant('b', HOST_CLOCK_ID), seek });
    const id = timelineCoordinator.createGroup({ name: 'G1', memberSlots: ['a', 'b'] });
    await mount('a');
    expect(timelineCoordinator.getSnapshot().groups[0].committedAnchor).toBeNull();
    expect(container.querySelectorAll('.timeline-member-status')).toHaveLength(0);
    expect(container.querySelectorAll('.timeline-group-status')).toHaveLength(0);
    // Once a real seek is queued the transient is legitimate: this is an actual
    // in-flight navigation, not the endless state an anchor-less group used to show.
    await act(async () => { timelineCoordinator.seek(id, 100); });
    expect(container.querySelector('.timeline-group-status')?.textContent).toBe('timeline.aligning');
    await act(async () => { host.dispose(); follower.dispose(); });
  });

  it('keeps the compact tab label traceable to the persisted group name', async () => {
    timelineCoordinator.createGroup({ name: '设备对照', memberSlots: ['a', 'b'] });
    const host = document.createElement('div');
    document.body.append(host);
    const buttonRoot = createRoot(host);
    await act(async () => buttonRoot.render(createElement(TimelineButton, { tabId: 'a' })));
    expect(host.querySelector('.timeline-entry')?.getAttribute('title')).toBe('G1 · 设备对照 · timeline.manage');
    await act(async () => buttonRoot.unmount());
    host.remove();
  });
});
