import { describe, expect, it } from 'vitest';
import { channelLabelKey } from './channel';

describe('channelLabelKey (issue #12)', () => {
  it('maps channels to i18n keys', () => {
    expect(channelLabelKey('stable')).toBe('update.channel.stable');
    expect(channelLabelKey('preview')).toBe('update.channel.preview');
  });
});
