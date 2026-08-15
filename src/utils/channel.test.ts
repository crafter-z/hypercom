import { describe, expect, it } from 'vitest';
import { detectChannel, isPreviewVersion } from './channel';

describe('channel.ts (issue #12)', () => {
  it('detects preview from version suffix', () => {
    expect(detectChannel('0.6.0-preview.2')).toBe('preview');
    expect(detectChannel('0.5.2-preview.1')).toBe('preview');
    expect(detectChannel('1.0.0-preview.100')).toBe('preview');
  });

  it('detects stable for plain versions', () => {
    expect(detectChannel('0.5.2')).toBe('stable');
    expect(detectChannel('1.0.0')).toBe('stable');
    expect(detectChannel('0.10.2')).toBe('stable');
  });

  it('handles empty string as stable (fallback)', () => {
    expect(detectChannel('')).toBe('stable');
  });

  it('isPreviewVersion boundary cases', () => {
    expect(isPreviewVersion('0.6.0-preview.1')).toBe(true);
    expect(isPreviewVersion('0.6.0-preview')).toBe(true); // 后缀无 .N 也识别为 preview
    expect(isPreviewVersion('0.6.0')).toBe(false);
    expect(isPreviewVersion('0.6.0-alpha.1')).toBe(false);
    expect(isPreviewVersion('')).toBe(false);
  });
});