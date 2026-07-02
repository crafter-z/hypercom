import { describe, it, expect } from 'vitest';
import { renderProtocolLine } from './protocolRenderer';
import type { TerminalLine, ParsedField } from '../types';

const makeField = (overrides?: Partial<ParsedField>): ParsedField => ({
  name: 'TestField',
  byteStart: 0,
  byteEnd: 1,
  color: '#ff0000',
  ...overrides,
});

const makeLine = (overrides?: Partial<TerminalLine>): TerminalLine => ({
  id: 'test-line',
  timestamp: 0,
  direction: 'RX',
  content: '',
  isHex: false,
  ...overrides,
});

describe('renderProtocolLine', () => {
  // ==================== Hex mode ====================

  it('renders hex mode with a single field spanning all bytes', () => {
    const line = makeLine({
      isHex: true,
      rawData: [0xFF, 0x00, 0xAB],
      parsedFields: [makeField({ name: 'Payload', byteStart: 0, byteEnd: 3, color: '#ff0000' })],
      content: 'FF 00 AB',
    });
    const result = renderProtocolLine(line);
    expect(result).toContain('<span style="color:#ff0000">');
    expect(result).toContain('FF 00 AB');
    // No stray unstyled hex bytes
    expect(result).not.toContain('>FF</span>');
    expect(result).not.toContain('>00</span>');
    expect(result).not.toContain('>AB</span>');
  });

  it('renders hex mode with multiple adjacent fields in distinct colors', () => {
    const line = makeLine({
      isHex: true,
      rawData: [0xAA, 0xBB, 0x01, 0x02, 0x0D, 0x0A],
      parsedFields: [
        { name: 'Header', byteStart: 0, byteEnd: 2, color: '#ff0000' },
        { name: 'Payload', byteStart: 2, byteEnd: 4, color: '#00ff00' },
        { name: 'Footer', byteStart: 4, byteEnd: 6, color: '#0000ff' },
      ],
      content: 'AA BB 01 02 0D 0A',
    });
    const result = renderProtocolLine(line);
    // Each field's hex bytes wrapped in its respective color
    expect(result).toContain('<span style="color:#ff0000">AA BB</span>');
    expect(result).toContain('<span style="color:#00ff00">01 02</span>');
    expect(result).toContain('<span style="color:#0000ff">0D 0A</span>');
    // Verify the three spans are separated by spaces (not concatenated)
    expect(result).toMatch(
      /<span style="color:#ff0000">AA BB<\/span> <span style="color:#00ff00">01 02<\/span> <span style="color:#0000ff">0D 0A<\/span>/
    );
  });

  // ==================== Text mode ====================

  it('renders text mode with a single field spanning all bytes', () => {
    const line = makeLine({
      isHex: false,
      rawData: [0x48, 0x65, 0x6C, 0x6C, 0x6F], // "Hello"
      parsedFields: [makeField({ name: 'Payload', byteStart: 0, byteEnd: 5, color: '#00ff00' })],
      content: 'Hello',
    });
    const result = renderProtocolLine(line);
    expect(result).toContain('<span style="color:#00ff00">Hello</span>');
  });

  it('renders text mode with non-ASCII CJK characters correctly decoded', () => {
    const cjkBytes = [0xE4, 0xBD, 0xA0, 0xE5, 0xA5, 0xBD]; // "你好"
    const line = makeLine({
      isHex: false,
      rawData: cjkBytes,
      parsedFields: [makeField({ name: 'Payload', byteStart: 0, byteEnd: 6, color: '#00ff00' })],
      content: '你好',
    });
    const result = renderProtocolLine(line);
    expect(result).toContain('<span style="color:#00ff00">你好</span>');
  });

  // ==================== Edge cases ====================

  it('returns empty string when rawData is empty and parsedFields is empty', () => {
    const line = makeLine({
      rawData: [],
      parsedFields: [],
      content: '',
    });
    const result = renderProtocolLine(line);
    expect(result).toBe('');
  });

  it('falls back to escapeHtml(content) when parsedFields is undefined', () => {
    const line = makeLine({
      rawData: [0xFF],
      parsedFields: undefined,
      content: 'some & text',
    });
    const result = renderProtocolLine(line);
    expect(result).toBe('some &amp; text');
  });

  it('renders gap bytes between fields without color styling', () => {
    const line = makeLine({
      isHex: true,
      rawData: [0xAA, 0xBB, 0xFF, 0xCC],
      parsedFields: [
        makeField({ name: 'Header', byteStart: 0, byteEnd: 2, color: '#ff0000' }),
        makeField({ name: 'Footer', byteStart: 3, byteEnd: 4, color: '#00ff00' }),
      ],
      content: 'AA BB FF CC',
    });
    const result = renderProtocolLine(line);
    // Header bytes in color
    expect(result).toContain('<span style="color:#ff0000">AA BB</span>');
    // Footer bytes in color
    expect(result).toContain('<span style="color:#00ff00">CC</span>');
    // Gap byte (0xFF at index 2) rendered without color span
    expect(result).toContain('>AA BB</span> FF <span');
    // FF is NOT in any span with a color style
    expect(result).not.toContain('>FF</span>');
  });

  it('applies checksum error color to a field', () => {
    const line = makeLine({
      isHex: true,
      rawData: [0xAA, 0xBB, 0xCC],
      parsedFields: [
        makeField({ name: 'Header', byteStart: 0, byteEnd: 2, color: '#00ff00' }),
        makeField({ name: 'Checksum', byteStart: 2, byteEnd: 3, color: '#f48771' }),
      ],
      content: 'AA BB CC',
    });
    const result = renderProtocolLine(line);
    expect(result).toContain('<span style="color:#f48771">CC</span>');
    // Header still has its own color
    expect(result).toContain('<span style="color:#00ff00">AA BB</span>');
  });
});
