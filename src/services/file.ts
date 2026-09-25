/**
 * 通用文件命令（配置导入导出 / 背景图读取）。
 *
 * 参数约定见 `./tauri.ts` 文件头。
 */
import { invoke } from '@tauri-apps/api/core';

export const fileService = {
  /** 将文本内容写入指定路径（配置导出）。路径来自 save() 对话框。 */
  writeTextFile: (path: string, content: string): Promise<void> => {
    return invoke<void>('write_text_file', { path, content });
  },

  /** 读取文本文件内容（配置导入）。路径来自 open() 对话框。 */
  readTextFile: (path: string): Promise<string> => {
    return invoke<string>('read_text_file', { path });
  },

  /** 读取图片文件为 base64 data URL（自定义背景图，issue #13）。失败/非图片 → ''。 */
  readImageDataUrl: (path: string): Promise<string> => {
    return invoke<string>('read_image_data_url', { path });
  },
};
