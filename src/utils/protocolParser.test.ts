import { describe, expect, it } from 'vitest';
import type { ProtocolTemplate } from '../types';
import { ProtocolFrameReassembler, crc8, parseFrameBytes, sum8, xor8 } from './protocolParser';

const template = (overrides: Partial<ProtocolTemplate> = {}): ProtocolTemplate => ({
  id: 'tpl1',
  name: 'Test Protocol',
  isEnabled: true,
  headerBytes: 'AA BB',
  lengthFieldOffset: 2,
  lengthFieldSize: 1,
  lengthEndian: 'little',
  lengthAdjust: 0,
  checksumAlgorithm: 'none',
  checksumOffset: 0,
  footerBytes: '0D 0A',
  colorHeader: '#111111',
  colorLength: '#222222',
  colorPayload: '#333333',
  colorChecksum: '#444444',
  colorFooter: '#555555',
  ...overrides,
});

describe('ProtocolFrameReassembler', () => {
  it('returns no frames and no flushed bytes when feeding an empty buffer', () => {
    const reassembler = new ProtocolFrameReassembler(template());

    const result = reassembler.feed([]);

    expect(result.frames).toHaveLength(0);
    expect(result.flushedBytes).toEqual([]);
  });

  it('flushes a non-matching single byte when a header is required', () => {
    const reassembler = new ProtocolFrameReassembler(template());

    const result = reassembler.feed([0x00]);

    expect(result.frames).toHaveLength(0);
    expect(result.flushedBytes).toEqual([0x00]);
  });

  it('parses a complete frame from a single feed', () => {
    const reassembler = new ProtocolFrameReassembler(template());
    const bytes = [0xaa, 0xbb, 0x06, 0x01, 0x02, 0x0d, 0x0a];

    const result = reassembler.feed(bytes);

    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]?.bytes).toEqual(bytes);
  });

  it('reassembles a frame split across feeds', () => {
    const reassembler = new ProtocolFrameReassembler(template());

    const first = reassembler.feed([0xaa, 0xbb, 0x06]);
    const second = reassembler.feed([0x01, 0x02, 0x0d, 0x0a]);

    expect(first.frames).toHaveLength(0);
    expect(second.frames).toHaveLength(1);
    expect(second.frames[0]?.bytes).toEqual([0xaa, 0xbb, 0x06, 0x01, 0x02, 0x0d, 0x0a]);
  });

  it('parses a no-header template from byte zero', () => {
    const reassembler = new ProtocolFrameReassembler(template({
      headerBytes: '',
      lengthFieldOffset: 0,
      footerBytes: '',
    }));

    const result = reassembler.feed([0x03, 0x41, 0x42, 0x43]);

    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]?.bytes).toEqual([0x03, 0x41, 0x42, 0x43]);
  });

  it('parses a template without a footer', () => {
    const reassembler = new ProtocolFrameReassembler(template({
      headerBytes: 'AA',
      lengthFieldOffset: 1,
      footerBytes: '',
    }));

    const result = reassembler.feed([0xaa, 0x03, 0x01, 0x02]);

    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]?.bytes).toEqual([0xaa, 0x03, 0x01, 0x02]);
  });

  it('validates a sum8 checksum in a frame', () => {
    const reassembler = new ProtocolFrameReassembler(template({ checksumAlgorithm: 'sum8' }));
    const frameWithoutChecksum = [0xaa, 0xbb, 0x07, 0x01, 0x02];
    const checksum = sum8(frameWithoutChecksum);

    const result = reassembler.feed([...frameWithoutChecksum, checksum, 0x0d, 0x0a]);

    expect(result.frames[0]?.isValid).toBe(true);
  });

  it('flushes oversized garbage to avoid unbounded buffering', () => {
    const reassembler = new ProtocolFrameReassembler(template({ headerBytes: 'AA' }));

    const result = reassembler.feed(Array.from({ length: 70_000 }, () => 0x00));

    expect(result.frames).toHaveLength(0);
    expect(result.flushedBytes).toHaveLength(70_000);
    expect(reassembler.getBufferedLength()).toBe(0);
  });

  it('flushes non-frame bytes between complete frames', () => {
    const reassembler = new ProtocolFrameReassembler(template());
    const bytes = [0xaa, 0xbb, 0x06, 0x01, 0x02, 0x0d, 0x0a, 0xff, 0xaa, 0xbb, 0x06, 0x03, 0x04, 0x0d, 0x0a];

    const result = reassembler.feed(bytes);

    expect(result.frames).toHaveLength(2);
    expect(result.flushedBytes).toEqual([0xff]);
  });

  it('parses 2-byte little-endian lengths', () => {
    const reassembler = new ProtocolFrameReassembler(template({ lengthFieldSize: 2 }));

    const result = reassembler.feed([0xaa, 0xbb, 0x06, 0x00, 0x01, 0x02, 0x0d, 0x0a]);

    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]?.bytes).toHaveLength(8);
  });

  it('parses 2-byte big-endian lengths', () => {
    const reassembler = new ProtocolFrameReassembler(template({ lengthFieldSize: 2, lengthEndian: 'big' }));

    const result = reassembler.feed([0xaa, 0xbb, 0x00, 0x06, 0x01, 0x02, 0x0d, 0x0a]);

    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]?.bytes).toHaveLength(8);
  });

  it('applies positive lengthAdjust before extracting payload fields', () => {
    const reassembler = new ProtocolFrameReassembler(template({ lengthAdjust: 2 }));

    const result = reassembler.feed([0xaa, 0xbb, 0x08, 0x01, 0x02, 0x0d, 0x0a]);
    const payload = result.frames[0]?.fields.find((field) => field.name === 'Payload');

    expect(result.frames).toHaveLength(1);
    expect(payload).toMatchObject({ byteStart: 3, byteEnd: 5 });
  });
});

describe('protocol checksum functions', () => {
  it('computes sum8 by summing bytes and masking to 8 bits', () => {
    expect(sum8([0xff, 0x02, 0x03])).toBe(0x04);
  });

  it('computes xor8 over all bytes', () => {
    expect(xor8([0xaa, 0xbb, 0x11])).toBe(0x00);
  });

  it('computes the CRC-8-MAXIM check value for 123456789', () => {
    expect(crc8([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39])).toBe(0xa1);
  });
});

describe('parseFrameBytes', () => {
  it('parses a complete frame without reassembler state', () => {
    const bytes = [0xaa, 0xbb, 0x06, 0x01, 0x02, 0x0d, 0x0a];

    const result = parseFrameBytes(bytes, template());

    expect(result?.bytes).toEqual(bytes);
    expect(result?.fields.map((field) => field.name)).toEqual(['Header', 'Length', 'Payload', 'Footer']);
  });

  it('returns checksum-mismatched frames with a red checksum field', () => {
    const result = parseFrameBytes([0xaa, 0xbb, 0x07, 0x01, 0x02, 0x00, 0x0d, 0x0a], template({ checksumAlgorithm: 'sum8' }));
    const checksum = result?.fields.find((field) => field.name === 'Checksum');

    expect(result?.isValid).toBe(false);
    expect(checksum).toMatchObject({ color: '#f48771' });
  });
});
