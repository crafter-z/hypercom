import { describe, it, expect } from 'vitest';
import { partitionGroupPorts } from './groupTool';
import type { PortGroup, PortToolConfig, SerialPort } from '../types';

function makePort(id: string, overrides: Partial<SerialPort> = {}): SerialPort {
  return { id, name: id, status: 'disconnected', type: 'real', isHidden: false, ...overrides };
}

function makeConfig(portId: string, command = 'flash {port}'): PortToolConfig {
  return { id: `cfg-${portId}`, name: 'tool', portId, command, workdir: '' };
}

const group: PortGroup = {
  id: 'g1',
  name: 'Group 1',
  isExpanded: true,
  portIds: ['COM1', 'COM2', 'COM3'],
  order: 0,
};

const groupPorts = [makePort('COM1'), makePort('COM2'), makePort('COM3')];

const ids = (arr: SerialPort[]) => arr.map((p) => p.id);

describe('partitionGroupPorts (issue #5-7)', () => {
  it('all configured → everything lands in configured, nothing in unconfigured', () => {
    const result = partitionGroupPorts(groupPorts, group, [
      makeConfig('COM1'),
      makeConfig('COM2'),
      makeConfig('COM3'),
    ]);
    expect(ids(result.configured)).toEqual(['COM1', 'COM2', 'COM3']);
    expect(result.unconfigured).toEqual([]);
  });

  it('none configured → everything lands in unconfigured', () => {
    const result = partitionGroupPorts(groupPorts, group, []);
    expect(result.configured).toEqual([]);
    expect(ids(result.unconfigured)).toEqual(['COM1', 'COM2', 'COM3']);
  });

  it('mixed → only configured ports in configured, the rest unconfigured', () => {
    const result = partitionGroupPorts(groupPorts, group, [makeConfig('COM2')]);
    expect(ids(result.configured)).toEqual(['COM2']);
    expect(ids(result.unconfigured)).toEqual(['COM1', 'COM3']);
  });

  it('hidden group ports are excluded from both buckets', () => {
    const ports = [
      makePort('COM1', { isHidden: true }),
      makePort('COM2', { isHidden: true }),
      makePort('COM3'),
    ];
    const result = partitionGroupPorts(ports, group, [makeConfig('COM1'), makeConfig('COM3')]);
    expect(ids(result.configured)).toEqual(['COM3']);
    expect(result.unconfigured).toEqual([]);
  });

  it('empty/whitespace-only command counts as unconfigured; trimmed non-empty counts as configured', () => {
    const result = partitionGroupPorts(groupPorts, group, [
      makeConfig('COM1', '   '),
      makeConfig('COM2', ''),
      makeConfig('COM3', '  flash {port}  '),
    ]);
    expect(ids(result.configured)).toEqual(['COM3']);
    expect(ids(result.unconfigured)).toEqual(['COM1', 'COM2']);
  });

  it('config for a different port is ignored (group member without config stays unconfigured)', () => {
    const result = partitionGroupPorts(groupPorts, group, [makeConfig('COM99')]);
    expect(result.configured).toEqual([]);
    expect(ids(result.unconfigured)).toEqual(['COM1', 'COM2', 'COM3']);
  });

  it('ports outside the group are ignored even when configured', () => {
    const result = partitionGroupPorts([...groupPorts, makePort('COM5')], group, [
      makeConfig('COM5'),
    ]);
    expect(result.configured).toEqual([]);
    expect(ids(result.unconfigured)).toEqual(['COM1', 'COM2', 'COM3']);
  });
});
