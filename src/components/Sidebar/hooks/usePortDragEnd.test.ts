import { beforeEach, describe, expect, it } from 'vitest';
import type { DragEndEvent } from '@dnd-kit/core';
import type { PortGroup, SerialPort } from '../../../types';
import { resetStoresForTests } from '../../../stores/resetStores';
import { useAppStore } from '../../../stores/useAppStore';
import { handlePortDragEnd, UNGROUPED_DROPPABLE_ID } from './usePortDragEnd';

const makePort = (id: string, groupId?: string): SerialPort => ({
  id,
  name: id,
  status: 'disconnected',
  type: 'real',
  isHidden: false,
  groupId,
});

const makeGroup = (id: string, portIds: string[]): PortGroup => ({
  id,
  name: id,
  isExpanded: true,
  portIds,
  order: 0,
});

const drag = (active: string, over: string): DragEndEvent => ({
  active: { id: active } as DragEndEvent['active'],
  over: { id: over } as NonNullable<DragEndEvent['over']>,
  activatorEvent: new Event('pointerdown'),
  collisions: null,
  delta: { x: 0, y: 0 },
});

describe('sidebar port drag ordering', () => {
  beforeEach(() => resetStoresForTests());

  it('updates authoritative group.portIds when reordering within a group', () => {
    useAppStore.setState({
      ports: [makePort('COM1', 'g1'), makePort('COM2', 'g1'), makePort('COM3', 'g1')],
      groups: [makeGroup('g1', ['COM1', 'COM2', 'COM3'])],
    });

    handlePortDragEnd(drag('COM3', 'COM1'));

    const state = useAppStore.getState();
    expect(state.groups[0].portIds).toEqual(['COM3', 'COM1', 'COM2']);
    // The global rack ordering is separate from a group's persisted ordering.
    expect(state.ports.map(port => port.id)).toEqual(['COM1', 'COM2', 'COM3']);
  });

  it('continues to reorder the global port list for ungrouped ports', () => {
    useAppStore.setState({
      ports: [makePort('COM1'), makePort('COM2'), makePort('COM3')],
      groups: [],
    });

    handlePortDragEnd(drag('COM3', 'COM1'));

    expect(useAppStore.getState().ports.map(port => port.id)).toEqual(['COM3', 'COM1', 'COM2']);
  });

  it('moves a grouped port to ungrouped when dropped onto the ungrouped drop zone', () => {
    useAppStore.setState({
      ports: [makePort('COM1', 'g1')],
      groups: [makeGroup('g1', ['COM1'])],
    });

    handlePortDragEnd(drag('COM1', UNGROUPED_DROPPABLE_ID));

    const state = useAppStore.getState();
    expect(state.ports[0].groupId).toBeUndefined();
    expect(state.groups[0].portIds).toEqual([]);
  });
});
