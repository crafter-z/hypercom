/**
 * Protocol frame parser engine
 *
 * Reassembles incoming serial data chunks into complete protocol frames
 * based on a ProtocolTemplate definition (header/length/checksum/footer).
 *
 * The length field value represents the frame size EXCLUDING the length field
 * bytes themselves. Therefore:
 *   totalFrameLength = lengthValue - lengthAdjust + lengthFieldSize
 */

import type { ProtocolTemplate, ParsedField } from '../types';

/** A complete parsed frame with field annotations */
export interface ParsedFrame {
  bytes: number[];
  fields: ParsedField[];
  isValid: boolean;
}

/** Maximum buffer size before flushing as non-frame (guards against corrupt length fields) */
const MAX_FRAME_SIZE = 65536;

// ==================== Hex string parsing ====================

/**
 * Parse a hex string like "AA BB" or "AABB" or "0xAA 0xBB" into a byte array.
 * Returns empty array for empty or invalid input.
 */
function parseHexString(hex: string): number[] {
  const cleaned = hex.replace(/\s+/g, '').replace(/0x/gi, '');
  if (cleaned.length === 0) return [];
  if (cleaned.length % 2 !== 0) return [];
  const result: number[] = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    const byte = parseInt(cleaned.substr(i, 2), 16);
    if (isNaN(byte)) return [];
    result.push(byte);
  }
  return result;
}

// ==================== Checksum functions ====================

/** Sum all bytes, mask to 8 bits */
export function sum8(bytes: number[]): number {
  let sum = 0;
  for (const b of bytes) {
    sum += b;
  }
  return sum & 0xFF;
}

/** XOR all bytes */
export function xor8(bytes: number[]): number {
  let result = 0;
  for (const b of bytes) {
    result ^= b;
  }
  return result;
}

/**
 * CRC-8-MAXIM: poly=0x31 (reflected=0x8C), init=0x00,
 * refin=true, refout=true, xorout=0x00
 * Check value for "123456789" is 0xA1
 */
export function crc8(bytes: number[]): number {
  let crc = 0x00;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x01) {
        crc = (crc >> 1) ^ 0x8C;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc;
}

/** Compute checksum based on algorithm name */
function computeChecksum(bytes: number[], algorithm: string): number {
  switch (algorithm) {
    case 'sum8':
      return sum8(bytes);
    case 'xor':
      return xor8(bytes);
    case 'crc8':
      return crc8(bytes);
    default:
      return 0;
  }
}

// ==================== Length field reading ====================

/** Read a multi-byte length value from the byte array */
function readLengthValue(
  bytes: number[],
  offset: number,
  size: number,
  endian: string
): number {
  let value = 0;
  if (endian === 'big') {
    for (let i = 0; i < size; i++) {
      value = (value << 8) | (bytes[offset + i] & 0xFF);
    }
  } else {
    // little-endian
    for (let i = 0; i < size; i++) {
      value |= (bytes[offset + i] & 0xFF) << (8 * i);
    }
  }
  return value;
}

// ==================== Frame parsing ====================

/**
 * Discriminated result of attempting to parse a frame at the start of a buffer.
 *
 * - `complete`:   a full frame was parsed; `frame` holds it.
 * - `incomplete`: the buffer starts plausibly but lacks enough bytes — wait for more data.
 * - `corrupt`:    the header matched and enough bytes are present, but the frame is
 *                 invalid (bad length field or footer mismatch). The reassembler must
 *                 advance the buffer by `skip` bytes and keep scanning, NOT stall.
 */
type FrameParseOutcome =
  | { status: 'complete'; frame: ParsedFrame }
  | { status: 'incomplete' }
  | { status: 'corrupt'; skip: number };

/**
 * Internal parser that distinguishes "need more data" from "corrupt frame".
 *
 * The length field value represents the frame size excluding the length field
 * bytes themselves: totalFrameLength = lengthValue - lengthAdjust + lengthFieldSize
 */
function parseFrameOutcome(
  bytes: number[],
  template: ProtocolTemplate
): FrameParseOutcome {
  const headerBytes = parseHexString(template.headerBytes);
  const footerBytes = parseHexString(template.footerBytes);
  const headerLength = headerBytes.length;
  const footerLength = footerBytes.length;
  // On a corrupt frame, resync just past the matched header (at least 1 byte)
  // so the scanner can look for the next frame instead of re-finding this one.
  const skipPastHeader = Math.max(1, headerLength);

  // If header is defined, verify bytes start with header
  if (headerLength > 0) {
    if (bytes.length < headerLength) return { status: 'incomplete' };
    for (let i = 0; i < headerLength; i++) {
      if (bytes[i] !== headerBytes[i]) return { status: 'corrupt', skip: skipPastHeader };
    }
  }

  // Read length field
  const lengthFieldEnd = template.lengthFieldOffset + template.lengthFieldSize;
  if (bytes.length < lengthFieldEnd) return { status: 'incomplete' };

  const lengthValue = readLengthValue(
    bytes,
    template.lengthFieldOffset,
    template.lengthFieldSize,
    template.lengthEndian
  );

  // totalFrameLength = lengthValue - lengthAdjust + lengthFieldSize
  const totalFrameLength = lengthValue - template.lengthAdjust + template.lengthFieldSize;
  if (totalFrameLength <= 0) return { status: 'corrupt', skip: skipPastHeader };

  // Check if we have enough bytes for the complete frame
  if (bytes.length < totalFrameLength) return { status: 'incomplete' };

  // Verify footer if defined
  if (footerLength > 0) {
    const footerStart = totalFrameLength - footerLength;
    for (let i = 0; i < footerLength; i++) {
      if (bytes[footerStart + i] !== footerBytes[i]) {
        return { status: 'corrupt', skip: skipPastHeader };
      }
    }
  }

  // Checksum validation
  let isValid = true;
  let checksumPos = -1;
  const hasChecksum = template.checksumAlgorithm !== 'none';

  if (hasChecksum) {
    const checksumSize = 1;
    if (template.checksumOffset > 0) {
      checksumPos = template.checksumOffset;
    } else {
      // Auto: right before footer
      checksumPos = totalFrameLength - footerLength - checksumSize;
    }

    if (checksumPos < 0 || checksumPos >= totalFrameLength) {
      isValid = false;
    } else {
      const computed = computeChecksum(
        bytes.slice(0, checksumPos),
        template.checksumAlgorithm
      );
      const stored = bytes[checksumPos];
      isValid = computed === stored;
    }
  }

  // Build fields
  const fields: ParsedField[] = [];

  // Header field
  if (headerLength > 0) {
    fields.push({
      name: 'Header',
      byteStart: 0,
      byteEnd: headerLength,
      color: template.colorHeader,
    });
  }

  // Length field
  fields.push({
    name: 'Length',
    byteStart: template.lengthFieldOffset,
    byteEnd: lengthFieldEnd,
    color: template.colorLength,
  });

  // Determine payload range (gap between length field and checksum/footer)
  const payloadStart = Math.max(headerLength, lengthFieldEnd);
  let payloadEnd: number;
  if (hasChecksum) {
    payloadEnd = checksumPos;
  } else if (footerLength > 0) {
    payloadEnd = totalFrameLength - footerLength;
  } else {
    payloadEnd = totalFrameLength;
  }

  // Payload field (only if there's a non-empty gap)
  if (payloadStart < payloadEnd) {
    fields.push({
      name: 'Payload',
      byteStart: payloadStart,
      byteEnd: payloadEnd,
      color: template.colorPayload,
    });
  }

  // Checksum field
  if (hasChecksum && checksumPos >= 0) {
    fields.push({
      name: 'Checksum',
      byteStart: checksumPos,
      byteEnd: checksumPos + 1,
      color: isValid ? template.colorChecksum : '#f48771',
    });
  }

  // Footer field
  if (footerLength > 0) {
    fields.push({
      name: 'Footer',
      byteStart: totalFrameLength - footerLength,
      byteEnd: totalFrameLength,
      color: template.colorFooter,
    });
  }

  return {
    status: 'complete',
    frame: {
      bytes: bytes.slice(0, totalFrameLength),
      fields,
      isValid,
    },
  };
}

/**
 * Attempt to parse a single complete frame from the START of `bytes`.
 * Returns null if not enough bytes for a complete frame, or if the frame is
 * corrupt (header/footer mismatch or invalid length).
 *
 * The length field value represents the frame size excluding the length field
 * bytes themselves: totalFrameLength = lengthValue - lengthAdjust + lengthFieldSize
 */
export function parseFrameBytes(
  bytes: number[],
  template: ProtocolTemplate
): ParsedFrame | null {
  const outcome = parseFrameOutcome(bytes, template);
  return outcome.status === 'complete' ? outcome.frame : null;
}

// ==================== Header search ====================

/** Find the first occurrence of header pattern in buffer. Returns -1 if not found. */
function findHeader(buffer: number[], header: number[]): number {
  if (header.length === 0) return 0;
  if (buffer.length < header.length) return -1;
  for (let i = 0; i <= buffer.length - header.length; i++) {
    let match = true;
    for (let j = 0; j < header.length; j++) {
      if (buffer[i + j] !== header[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

// ==================== ReassemblerSegment ====================

/**
 * 有序段（流顺序）：帧段或裸字节段。
 *
 * 旧 API `{ frames, flushedBytes }` 把**所有**帧与**所有**裸字节分开返回——
 * 但裸字节可能出现在第一帧**之前**（header 搜索跳过的非帧前缀）、两帧**之间**
 * （垃圾数据）或损坏帧跳过后。调用方把全部 frames 追加后才追加 flushedBytes，
 * 导致字节流顺序错乱（先帧后裸，而实际应先裸后帧）。
 *
 * 新 API 返回按流位置排列的段数组：裸字节 flushed 在扫描到 header 之前
 * 就排在对应帧之前，下游按段顺序入队即可保持字节流时序。
 */
export type ReassemblerSegment =
  | { kind: 'frame'; frame: ParsedFrame }
  | { kind: 'raw'; bytes: number[] };

// ==================== ProtocolFrameReassembler ====================

/**
 * Stateful frame reassembler. Maintains a byte buffer across feeds.
 * Call `feed()` with incoming byte chunks; it returns an ORDERED stream of
 * segments (frames and raw bytes in byte-stream order).
 */
export class ProtocolFrameReassembler {
  private buffer: number[] = [];
  private template: ProtocolTemplate;

  constructor(template: ProtocolTemplate) {
    this.template = template;
  }

  /**
   * Feed incoming bytes and return an ordered array of segments.
   *
   * Raw bytes that appear BEFORE a frame in the stream (header-scan skips,
   * inter-frame garbage, corrupt-frame skips) are emitted as `{kind:'raw'}`
   * segments ordered relative to `{kind:'frame'}` segments. Adjacent raw
   * segments are merged so the caller gets at most one raw between two frames.
   */
  feed(bytes: number[]): ReassemblerSegment[] {
    const segments: ReassemblerSegment[] = [];

    // Append incoming bytes to buffer
    this.buffer.push(...bytes);

    const headerBytes = parseHexString(this.template.headerBytes);

    // emitRaw: push a raw segment, merging with the previous if it is also raw
    const emitRaw = (rawBytes: number[]): void => {
      if (rawBytes.length === 0) return;
      const last = segments[segments.length - 1];
      if (last && last.kind === 'raw') {
        last.bytes.push(...rawBytes);
      } else {
        segments.push({ kind: 'raw', bytes: [...rawBytes] });
      }
    };

    // Main parsing loop
    while (this.buffer.length > 0) {
      // Safety: prevent unbounded buffer growth
      if (this.buffer.length > MAX_FRAME_SIZE) {
        emitRaw(this.buffer);
        this.buffer = [];
        break;
      }

      if (headerBytes.length > 0) {
        // Scan for header
        const headerPos = findHeader(this.buffer, headerBytes);
        if (headerPos === -1) {
          // No header found — flush all buffer as non-frame bytes
          emitRaw(this.buffer);
          this.buffer = [];
          break;
        }
        // Flush bytes before header match
        if (headerPos > 0) {
          emitRaw(this.buffer.slice(0, headerPos));
          this.buffer = this.buffer.slice(headerPos);
        }
      }

      // Try to parse a frame from the current buffer start
      const outcome = parseFrameOutcome(this.buffer, this.template);
      if (outcome.status === 'incomplete') {
        // Genuinely not enough bytes — wait for more data
        break;
      }

      if (outcome.status === 'corrupt') {
        // Header matched but the frame is invalid (bad length / footer mismatch).
        // Advance past the matched header and keep scanning for the next frame,
        // instead of stalling on the same bytes forever.
        const skip = Math.min(Math.max(1, outcome.skip), this.buffer.length);
        emitRaw(this.buffer.slice(0, skip));
        this.buffer = this.buffer.slice(skip);
        continue;
      }

      // Extract complete frame bytes from buffer
      segments.push({ kind: 'frame', frame: outcome.frame });
      this.buffer = this.buffer.slice(outcome.frame.bytes.length);
    }

    return segments;
  }

  /** Reset the internal buffer (e.g., when template changes or port disconnects) */
  reset(): void {
    this.buffer = [];
  }

  /** Get the current number of buffered bytes */
  getBufferedLength(): number {
    return this.buffer.length;
  }
}
