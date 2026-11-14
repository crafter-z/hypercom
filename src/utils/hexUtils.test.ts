import { describe, expect, it } from 'vitest';
import { hexToString, stringToHex, isValidHexInput, parseHexBytes } from './hexUtils';
import { hexInputError, hexToTextPreview, textToHexPreview } from './sendUtils';
import { isValidHexLine } from './textSend';

const validInputs = ['', ' \t\r\n\v\f', '41', '4142', '41 42', '4 1\t4\n2', 'e4b8ad'];
const invalidInputs = ['4', '41 4', '41 ZZ 42', '0x41', '41-42', '41\u00a042', '41\u200342'];

describe('shared HEX input and UTF-8 conversion', () => {
  it.each(validInputs)('uses the same valid input contract in every entry: %j', input => {
    expect(isValidHexInput(input)).toBe(true);
    expect(hexInputError(input)).toBeNull();
    expect(isValidHexLine(input)).toBe(parseHexBytes(input).length > 0);
    expect(hexToString(input)).toBe(hexToTextPreview(input));
  });

  it.each(invalidInputs)('rejects the entire invalid input instead of skipping bytes: %j', input => {
    expect(isValidHexInput(input)).toBe(false);
    expect(hexInputError(input)).not.toBeNull();
    expect(isValidHexLine(input)).toBe(false);
    expect(parseHexBytes(input)).toEqual([]);
    expect(hexToString(input)).toBe('');
    expect(hexToTextPreview(input)).toBe('');
  });

  it('shares conversion functions rather than separate preview implementations', () => {
    expect(hexToTextPreview).toBe(hexToString);
    expect(textToHexPreview).toBe(stringToHex);
  });

  it('decodes compact and spaced UTF-8 using the shared BOM policy', () => {
    expect(hexToString('4142')).toBe('AB');
    expect(hexToString('E4 B8 AD')).toBe('中');
    expect(hexToString('EF BB BF 41')).toBe('A');
    expect(hexToString('FF')).toBe('\ufffd');
  });

  it.each(['', 'AT+OK', '你好🙂', 'a\r\nb'])('round-trips UTF-8 text: %j', text => {
    expect(hexToString(stringToHex(text))).toBe(text);
  });
});
