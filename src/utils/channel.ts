/**
 * 通道展示辅助（issue #12）
 *
 * 通道是运行时用户选择：自动检查走 `config.updateCheckMode`，手动检查在 About
 * 显式选，检查结果经 `UpdatePayload.channel` 携带——展示只需 i18n key 映射。
 * （复审修复：方案 §2.4 原拟按版本号后缀解析构建通道的 `detectChannel` /
 * `isPreviewVersion` 最终零生产引用，已删除。后端 tag 校验在 update.rs
 * `is_preview_tag`，语义更严格。）
 */
import type { ReleaseChannel } from '../types';

/** 通道的 i18n key（供 UI 徽标使用）。 */
export function channelLabelKey(channel: ReleaseChannel): string {
  return channel === 'preview' ? 'update.channel.preview' : 'update.channel.stable';
}
