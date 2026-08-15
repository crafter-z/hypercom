import { describe, expect, it } from 'vitest';
import { channelLabelKey, releaseUrl } from './channel';

describe('channelLabelKey (issue #12)', () => {
  it('maps channels to i18n keys', () => {
    expect(channelLabelKey('stable')).toBe('update.channel.stable');
    expect(channelLabelKey('preview')).toBe('update.channel.preview');
  });
});

describe('releaseUrl (issue #12 二轮)', () => {
  it('builds GitHub release page URLs (tag 约定 v<version>)', () => {
    expect(releaseUrl('0.6.0')).toBe('https://github.com/crafter-z/hypercom/releases/tag/v0.6.0');
    expect(releaseUrl('0.6.0-preview.1')).toBe(
      'https://github.com/crafter-z/hypercom/releases/tag/v0.6.0-preview.1',
    );
  });
});
