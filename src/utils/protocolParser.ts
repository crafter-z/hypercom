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
 * Attempt to parse a single complete frame from the START of `bytes`.
 * Returns null if not enough bytes for a complete frame, or if header/footer mismatch.
 *
 * The length field value represents the frame size excluding the length field
 * bytes themselves: totalFrameLength = lengthValue - lengthAdjust + lengthFieldSize
 */
export function parseFrameBytes(
  bytes: number[],
  template: ProtocolTemplate
): ParsedFrame | null {
  const headerBytes = parseHexString(template.headerBytes);
  const footerBytes = parseHexString(template.footerBytes);
  const headerLength = headerBytes.length;
  const footerLength = footerBytes.length;

  // If header is defined, verify bytes start with header
  if (headerLength > 0) {
    if (bytes.length < headerLength) return null;
    for (let i = 0; i < headerLength; i++) {
      if (bytes[i] !== headerBytes[i]) return null;
    }
  }

  // Read length field
  const lengthFieldEnd = template.lengthFieldOffset + template.lengthFieldSize;
  if (bytes.length < lengthFieldEnd) return null;

  const lengthValue = readLengthValue(
    bytes,
    template.lengthFieldOffset,
    template.lengthFieldSize,
    template.lengthEndian
  );

  // totalFrameLength = lengthValue - lengthAdjust + lengthFieldSize
  const totalFrameLength = lengthValue - template.lengthAdjust + template.lengthFieldSize;
  if (totalFrameLength <= 0) return null;

  // Check if we have enough bytes for the complete frame
  if (bytes.length < totalFrameLength) return null;

  // Verify footer if defined
  if (footerLength > 0) {
    const footerStart = totalFrameLength - footerLength;
    for (let i = 0; i < footerLength; i++) {
      if (bytes[footerStart + i] !== footerBytes[i]) return null;
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
    bytes: bytes.slice(0, totalFrameLength),
    fields,
    isValid,
  };
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

// ==================== ProtocolFrameReassembler ====================

/**
 * Stateful frame reassembler. Maintains a byte buffer across feeds.
 * Call `feed()` with incoming byte chunks; it returns complete frames
 * and any non-frame bytes that were flushed.
 */
export class ProtocolFrameReassembler {
  private buffer: number[] = [];
  private template: ProtocolTemplate;

  constructor(template: ProtocolTemplate) {
    this.template = template;
  }

  /**
   * Feed incoming bytes and return complete frames plus any flushed non-frame bytes.
   * Non-frame bytes (header search failures, corrupt frames) are returned in flushedBytes.
   */
  feed(bytes: number[]): { frames: ParsedFrame[]; flushedBytes: number[] } {
    const frames: ParsedFrame[] = [];
    const flushedBytes: number[] = [];

    // Append incoming bytes to buffer
    this.buffer.push(...bytes);

    const headerBytes = parseHexString(this.template.headerBytes);

    // Main parsing loop
    while (this.buffer.length > 0) {
      // Safety: prevent unbounded buffer growth
      if (this.buffer.length > MAX_FRAME_SIZE) {
        flushedBytes.push(...this.buffer);
        this.buffer = [];
        break;
      }

      if (headerBytes.length > 0) {
        // Scan for header
        const headerPos = findHeader(this.buffer, headerBytes);
        if (headerPos === -1) {
          // No header found — flush all buffer as non-frame bytes
          flushedBytes.push(...this.buffer);
          this.buffer = [];
          break;
        }
        // Flush bytes before header match
        if (headerPos > 0) {
          flushedBytes.push(...this.buffer.slice(0, headerPos));
          this.buffer = this.buffer.slice(headerPos);
        }
      }

      // Try to parse a frame from the current buffer start
      const frame = parseFrameBytes(this.buffer, this.template);
      if (frame === null) {
        // Incomplete frame — need more bytes
        break;
      }

      // Extract frame bytes from buffer
      frames.push(frame);
      this.buffer = this.buffer.slice(frame.bytes.length);
    }

    return { frames, flushedBytes };
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
