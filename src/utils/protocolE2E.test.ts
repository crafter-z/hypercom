/**
 * Protocol E2E integration test (Phase F.7)
 *
 * Verifies the full pipeline:
 *   raw bytes → ProtocolFrameReassembler → ParsedFrame → TerminalLine → renderProtocolLine → HTML
 *
 * Frame format for the test template:
 *   [AA 55] [len] [payload...] [sum8] [0D 0A]
 *   totalFrameLength = lengthValue + 1  (lengthFieldSize=1, lengthAdjust=0)
 *   checksumPos = totalFrameLength - footerLength - 1  (auto, before footer)
 *   checksum = sum8(all bytes before checksumPos)
 */
import { describe, expect, it } from 'vitest';
import type { ProtocolTemplate, TerminalLine } from '../types';
import { ProtocolFrameReassembler } from './protocolParser';
import type { ParsedFrame, ReassemblerSegment } from './protocolParser';
import { renderProtocolLine } from './protocolRenderer';

/** 从有序段数组中提取帧 */
const extractFrames = (segments: ReassemblerSegment[]): ParsedFrame[] =>
  segments.filter((s): s is Extract<ReassemblerSegment, { kind: 'frame' }> => s.kind === 'frame').map((s) => s.frame);

/** 从有序段数组中收集所有裸字节 */
const extractRaw = (segments: ReassemblerSegment[]): number[] => {
  const raw: number[] = [];
  for (const s of segments) {
    if (s.kind === 'raw') raw.push(...s.bytes);
  }
  return raw;
};

const COLORS = {
  header: '#4fc3f7',
  length: '#ce9178',
  payload: '#dcdcaa',
  checksum: '#b5cea8',
  footer: '#6a9955',
};

function makeTemplate(overrides: Partial<ProtocolTemplate> = {}): ProtocolTemplate {
  return {
    id: 'e2e-tpl',
    name: 'E2E Test Protocol',
    isEnabled: true,
    headerBytes: 'AA 55',
    lengthFieldOffset: 2,
    lengthFieldSize: 1,
    lengthEndian: 'little',
    lengthAdjust: 0,
    checksumAlgorithm: 'sum8',
    checksumOffset: 0,
    footerBytes: '0D 0A',
    colorHeader: COLORS.header,
    colorLength: COLORS.length,
    colorPayload: COLORS.payload,
    colorChecksum: COLORS.checksum,
    colorFooter: COLORS.footer,
    ...overrides,
  };
}

function frameToLine(
  frame: { bytes: number[]; fields: { name: string; byteStart: number; byteEnd: number; color: string }[]; isValid: boolean },
  isHex: boolean
): TerminalLine {
  return {
    timestamp: Date.now(),
    direction: 'RX',
    content: frame.bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
    rawData: new Uint8Array(frame.bytes),
    isHex,
    parsedFields: frame.fields,
  };
}

// Valid frame: AA 55 08 01 02 03 0D 0D 0A  (9 bytes)
// header(AA 55) + len(08 → total=8+1=9) + payload(01 02 03) + checksum(0D) + footer(0D 0A)
// checksum = sum8(AA+55+08+01+02+03) & 0xFF = 269 & 0xFF = 0x0D
const VALID_FRAME = [0xaa, 0x55, 0x08, 0x01, 0x02, 0x03, 0x0d, 0x0d, 0x0a];

describe('Protocol E2E: bytes → reassembler → renderer', () => {
  it('parses a complete frame in one feed and renders colored hex HTML', () => {
    const reassembler = new ProtocolFrameReassembler(makeTemplate());
    const segments = reassembler.feed(VALID_FRAME);
    const frames = extractFrames(segments);

    expect(extractRaw(segments)).toEqual([]);
    expect(frames).toHaveLength(1);

    const frame = frames[0]!;
    expect(frame.bytes).toEqual(VALID_FRAME);
    expect(frame.isValid).toBe(true);

    const fieldNames = frame.fields.map(f => f.name);
    expect(fieldNames).toContain('Header');
    expect(fieldNames).toContain('Length');
    expect(fieldNames).toContain('Payload');
    expect(fieldNames).toContain('Checksum');
    expect(fieldNames).toContain('Footer');

    const html = renderProtocolLine(frameToLine(frame, true));
    expect(html).toContain(COLORS.header);
    expect(html).toContain(COLORS.length);
    expect(html).toContain(COLORS.payload);
    expect(html).toContain(COLORS.checksum);
    expect(html).toContain(COLORS.footer);
    expect(html).toContain('AA');
    expect(html).toContain('55');
  });

  it('reassembles a frame split across 3 serial reads and renders correctly', () => {
    const reassembler = new ProtocolFrameReassembler(makeTemplate());

    const chunk1 = reassembler.feed([0xaa, 0x55]);
    const chunk2 = reassembler.feed([0x08, 0x01, 0x02]);
    const chunk3 = reassembler.feed([0x03, 0x0d, 0x0d, 0x0a]);

    expect(extractFrames(chunk1)).toHaveLength(0);
    expect(extractFrames(chunk2)).toHaveLength(0);
    const chunk3Frames = extractFrames(chunk3);
    expect(chunk3Frames).toHaveLength(1);

    const frame = chunk3Frames[0]!;
    expect(frame.bytes).toEqual(VALID_FRAME);

    const html = renderProtocolLine(frameToLine(frame, true));
    expect(html).toContain('<span');
    expect(html).toContain(COLORS.header);
  });

  it('flushes garbage before a valid frame and still renders the frame', () => {
    const reassembler = new ProtocolFrameReassembler(makeTemplate());
    const garbage = [0x00, 0xff, 0x42];
    const segments = reassembler.feed([...garbage, ...VALID_FRAME]);
    const frames = extractFrames(segments);

    expect(extractRaw(segments)).toEqual(garbage);
    expect(frames).toHaveLength(1);

    const html = renderProtocolLine(frameToLine(frames[0]!, true));
    expect(html).toContain(COLORS.payload);
  });

  it('renders text mode (non-hex) with field colors', () => {
    // No-footer template: AA 55 [len] [payload] [sum8]
    // payload = 48 69 ("Hi"), total = 2+1+2+1 = 6, len = 5
    // checksum = sum8(AA+55+05+48+69) & 0xFF = 437 & 0xFF = 0xB5
    const tpl = makeTemplate({ footerBytes: '' });
    const reassembler = new ProtocolFrameReassembler(tpl);
    const frameBytes = [0xaa, 0x55, 0x05, 0x48, 0x69, 0xb5];
    const frames = extractFrames(reassembler.feed(frameBytes));

    expect(frames).toHaveLength(1);
    expect(frames[0]!.isValid).toBe(true);

    const html = renderProtocolLine(frameToLine(frames[0]!, false));
    expect(html).toContain(COLORS.header);
    expect(html).toContain(COLORS.payload);
  });

  it('falls back to plain content when parsedFields are missing', () => {
    const line: TerminalLine = {
      timestamp: Date.now(),
      direction: 'RX',
      content: 'plain text line',
      isHex: false,
    };
    expect(renderProtocolLine(line)).toBe('plain text line');
  });

  it('handles two consecutive frames in a single feed', () => {
    const reassembler = new ProtocolFrameReassembler(makeTemplate());
    // frame2: payload 04 05 06, checksum = sum8(AA+55+08+04+05+06) & 0xFF = 278 & 0xFF = 0x16
    const frame2 = [0xaa, 0x55, 0x08, 0x04, 0x05, 0x06, 0x16, 0x0d, 0x0a];
    const frames = extractFrames(reassembler.feed([...VALID_FRAME, ...frame2]));

    expect(frames).toHaveLength(2);

    const html1 = renderProtocolLine(frameToLine(frames[0]!, true));
    const html2 = renderProtocolLine(frameToLine(frames[1]!, true));
    expect(html1).toContain(COLORS.header);
    expect(html2).toContain(COLORS.header);
    expect(html1).toContain('01');
    expect(html2).toContain('04');
  });

  it('marks a frame with bad checksum as invalid but still renders it', () => {
    const reassembler = new ProtocolFrameReassembler(makeTemplate());
    const badFrame = [...VALID_FRAME];
    badFrame[6] = 0xff; // corrupt checksum
    const frames = extractFrames(reassembler.feed(badFrame));

    expect(frames).toHaveLength(1);
    expect(frames[0]!.isValid).toBe(false);

    const html = renderProtocolLine(frameToLine(frames[0]!, true));
    expect(html).toContain('<span');
  });
});