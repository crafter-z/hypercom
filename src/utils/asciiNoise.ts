/**
 * Pure, allocation-free heuristic for hiding binary-looking log lines.
 *
 * This deliberately targets ASCII logs rather than decoding bytes: UTF-8 and
 * GBK Chinese bytes are therefore treated as non-ASCII noise. The caller can
 * keep rawData unchanged and use this predicate only for a reversible view
 * decision.
 */

/** Minimum number of non-readable bytes required before a line can be noise. */
const MIN_NON_READABLE_BYTES = 4;
/** Minimum non-readable share required before a line can be noise. */
const MIN_NON_READABLE_RATIO = 0.3;
/** A run this long is substantial enough to protect an otherwise noisy line. */
const PROTECTED_TEXT_RUN_LENGTH = 12;
/** A protected run must contain this many letters or digits. */
const PROTECTED_ALPHANUMERIC_COUNT = 6;

/** ASCII printable byte, including spaces (but excluding TAB/CR/LF). */
function isPrintableAscii(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x7e;
}

/** ASCII letter or decimal digit used to distinguish text from spaces. */
function isAsciiAlphaNumeric(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a)
  );
}

/**
 * Whether a raw byte line is likely binary noise rather than an ASCII log.
 *
 * A line is hidden only when it has at least four non-readable bytes and they
 * make up at least 30% of the line. An uninterrupted printable-ASCII run of
 * at least twelve bytes containing at least six letters/digits protects the
 * complete line, even when the line also contains binary bytes. TAB, CR and
 * LF are readable separators but do not extend a printable-ASCII run. Other
 * controls (including NUL and DEL) count as unreadable even though their byte
 * values are below 0x80. Short lines and isolated bad bytes stay conservative.
 */
export function isLikelyAsciiNoise(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;

  let nonReadableCount = 0;
  let printableRunLength = 0;
  let printableRunAlphaNumericCount = 0;

  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];

    if (isPrintableAscii(byte)) {
      printableRunLength++;
      if (isAsciiAlphaNumeric(byte)) printableRunAlphaNumericCount++;
      continue;
    }

    if (
      printableRunLength >= PROTECTED_TEXT_RUN_LENGTH &&
      printableRunAlphaNumericCount >= PROTECTED_ALPHANUMERIC_COUNT
    ) {
      return false;
    }
    printableRunLength = 0;
    printableRunAlphaNumericCount = 0;

    // TAB, CR and LF are readable, while other controls and high bytes count
    // toward the binary/noise ratio.
    if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      nonReadableCount++;
    }
  }

  if (
    printableRunLength >= PROTECTED_TEXT_RUN_LENGTH &&
    printableRunAlphaNumericCount >= PROTECTED_ALPHANUMERIC_COUNT
  ) {
    return false;
  }

  if (nonReadableCount < MIN_NON_READABLE_BYTES) return false;
  return nonReadableCount / bytes.length >= MIN_NON_READABLE_RATIO;
}
