import { describe, it, expect } from 'vitest';
import { naturalCompare, sortPortsByNatural } from './portSort';

describe('naturalCompare', () => {
  it('orders COM ports by numeric part: COM1 < COM2 < COM12 (issue #2-4)', () => {
    expect(naturalCompare('COM1', 'COM2')).toBeLessThan(0);
    expect(naturalCompare('COM2', 'COM12')).toBeLessThan(0);
    expect(naturalCompare('COM12', 'COM2')).toBeGreaterThan(0);
  });

  it('orders multi-digit numbers by value, not lexicographically', () => {
    expect(naturalCompare('COM2', 'COM10')).toBeLessThan(0);
    expect(naturalCompare('COM9', 'COM10')).toBeLessThan(0);
    expect(naturalCompare('COM100', 'COM99')).toBeGreaterThan(0);
  });

  it('is case-insensitive on the alphabetic part', () => {
    expect(naturalCompare('com3', 'COM12')).toBeLessThan(0);
    expect(naturalCompare('COM3', 'com3')).toBe(0);
  });

  it('handles multiple digit runs', () => {
    expect(naturalCompare('ttyUSB1', 'ttyUSB10')).toBeLessThan(0);
    expect(naturalCompare('/dev/ttyS1', '/dev/ttyS2')).toBeLessThan(0);
  });

  it('compares mixed letter-digit patterns chunk by chunk', () => {
    expect(naturalCompare('PORT1A', 'PORT1B')).toBeLessThan(0);
    expect(naturalCompare('PORT2A', 'PORT10A')).toBeLessThan(0);
  });

  it('puts the shorter string first when it is a prefix', () => {
    expect(naturalCompare('COM1', 'COM1X')).toBeLessThan(0);
    expect(naturalCompare('', 'COM1')).toBeLessThan(0);
  });

  it('returns 0 for identical names', () => {
    expect(naturalCompare('COM5', 'COM5')).toBe(0);
  });

  it('is deterministic for leading-zero variants with equal numeric value', () => {
    // 数值相同 → 原始写法短的在前（COM1 先于 COM01），排序结果稳定可预期
    expect(naturalCompare('COM1', 'COM01')).toBeLessThan(0);
    expect(naturalCompare('COM01', 'COM1')).toBeGreaterThan(0);
  });

  it('falls back to alphabetic comparison when no digits exist', () => {
    expect(naturalCompare('/dev/ttyACMa', '/dev/ttyACMb')).toBeLessThan(0);
  });
});

describe('sortPortsByNatural', () => {
  const port = (id: string) => ({ id });

  it('sorts an enumeration-ordered list (COM1,COM12,COM2…) into intuitive order', () => {
    const input = ['COM1', 'COM12', 'COM2', 'COM10', 'COM3'].map(port);
    expect(sortPortsByNatural(input).map(p => p.id)).toEqual([
      'COM1', 'COM2', 'COM3', 'COM10', 'COM12',
    ]);
  });

  it('does not mutate the input array', () => {
    const input = ['COM2', 'COM1'].map(port);
    sortPortsByNatural(input);
    expect(input.map(p => p.id)).toEqual(['COM2', 'COM1']);
  });

  it('handles a stable full-list example across prefixes', () => {
    const input = ['COM10', 'COM1', 'ttyUSB0', 'COM2', 'ttyUSB10', 'ttyUSB2'].map(port);
    expect(sortPortsByNatural(input).map(p => p.id)).toEqual([
      'COM1', 'COM2', 'COM10', 'ttyUSB0', 'ttyUSB2', 'ttyUSB10',
    ]);
  });
});
