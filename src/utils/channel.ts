/**
 * 通道检测（issue #12）
 * 运行中的构建属于哪个通道由版本号后缀决定：`0.x.y-preview.N` → preview，否则 stable。
 * 纯函数，无副作用，便于单测。
 */
import type { ReleaseChannel } from '../types';

/**
 * 版本号是否属于 preview 通道。
 * 匹配 `v?0.x.y-preview.N`（版本号可带可不带 v 前缀，如 `0.6.0-preview.2`）。
 */
export function isPreviewVersion(version: string): boolean {
  return /-preview(\.|$|-)/.test(version);
}

/** 按版本号推断构建通道。 */
export function detectChannel(version: string): ReleaseChannel {
  return isPreviewVersion(version) ? 'preview' : 'stable';
}

/** 通道的 i18n key（供 UI 徽标使用）。 */
export function channelLabelKey(channel: ReleaseChannel): string {
  return channel === 'preview' ? 'update.channel.preview' : 'update.channel.stable';
}