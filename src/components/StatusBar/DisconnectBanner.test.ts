import { describe, it, expect } from 'vitest';
import { getUnexpectedDisconnectedTabIds } from './DisconnectBanner';
import type { TabItem, SerialPort } from '../../types';

const makeTab = (id: string): TabItem => ({
  id,
  title: id,
  isPinned: false,
  isActive: false,
  splitPaneId: 'main',
});

const makePort = (id: string, status: SerialPort['status']): SerialPort => ({
  id,
  name: id,
  status,
  type: 'real',
  isHidden: false,
});

describe('getUnexpectedDisconnectedTabIds', () => {
  it('returns tab ids for ports with status disconnected (not user-initiated)', () => {
    const tabs = [
      makeTab('COM3'),
      makeTab('COM4'),
      makeTab('COM5'),
    ];
    const ports = [
      makePort('COM3', 'disconnected'),
      makePort('COM4', 'connected'),
      makePort('COM5', 'connecting'),
    ];
    const userClosing = new Set<string>();
    expect(getUnexpectedDisconnectedTabIds(tabs, ports, userClosing)).toEqual(['COM3']);
  });

  it('returns tab ids when port is missing from ports list (USB unplug)', () => {
    const tabs = [makeTab('COM3'), makeTab('COM4')];
    const ports = [makePort('COM4', 'connected')];
    const userClosing = new Set<string>();
    expect(getUnexpectedDisconnectedTabIds(tabs, ports, userClosing)).toEqual(['COM3']);
  });

  it('excludes tabs whose portId is in the userClosingPortIds set', () => {
    const tabs = [makeTab('COM3'), makeTab('COM4')];
    const ports = [
      makePort('COM3', 'disconnected'),
      makePort('COM4', 'disconnected'),
    ];
    const userClosing = new Set<string>(['COM3']);
    expect(getUnexpectedDisconnectedTabIds(tabs, ports, userClosing)).toEqual(['COM4']);
  });

  it('returns empty array when all ports are connected', () => {
    const tabs = [makeTab('COM3'), makeTab('COM4')];
    const ports = [
      makePort('COM3', 'connected'),
      makePort('COM4', 'connected'),
    ];
    const userClosing = new Set<string>();
    expect(getUnexpectedDisconnectedTabIds(tabs, ports, userClosing)).toEqual([]);
  });

  it('returns empty array when all disconnected ports are user-initiated', () => {
    const tabs = [makeTab('COM3'), makeTab('COM4')];
    const ports = [
      makePort('COM3', 'disconnected'),
      makePort('COM4', 'disconnected'),
    ];
    const userClosing = new Set<string>(['COM3', 'COM4']);
    expect(getUnexpectedDisconnectedTabIds(tabs, ports, userClosing)).toEqual([]);
  });

  it('returns multiple tab ids when multiple ports are unexpectedly disconnected', () => {
    const tabs = [makeTab('COM3'), makeTab('COM4'), makeTab('COM5')];
    const ports = [
      makePort('COM3', 'disconnected'),
      makePort('COM4', 'connected'),
      // COM5 missing from ports list
    ];
    const userClosing = new Set<string>();
    expect(getUnexpectedDisconnectedTabIds(tabs, ports, userClosing)).toEqual(['COM3', 'COM5']);
  });

  it('returns empty array for empty tabs', () => {
    expect(getUnexpectedDisconnectedTabIds([], [], new Set<string>())).toEqual([]);
  });

  it('does not treat error status as disconnected', () => {
    const tabs = [makeTab('COM3')];
    const ports = [makePort('COM3', 'error')];
    const userClosing = new Set<string>();
    expect(getUnexpectedDisconnectedTabIds(tabs, ports, userClosing)).toEqual([]);
  });
});