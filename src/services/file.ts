/**
 * 通用文件命令（配置导入导出 / 背景图读取）。
 *
 * 参数约定见 `./tauri.ts` 文件头。
 */
import { invoke } from '@tauri-apps/api/core';

export interface TextFileDialogOptions {
  title?: string;
  defaultFileName?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export const fileService = {
  /** 宿主原生 save 对话框 + 写入；前端不提供路径。取消返回 null。 */
  pickTextFileAndWrite: (content: string, options: TextFileDialogOptions): Promise<string | null> => {
    return invoke<string | null>('pick_text_file_and_write', { content, options });
  },

  /** 宿主原生 open 对话框 + 读取；前端不提供路径。取消返回 null。 */
  pickTextFileAndRead: (options: TextFileDialogOptions): Promise<string | null> => {
    return invoke<string | null>('pick_text_file_and_read', { options });
  },

  /** 读取应用日志文件回放（后端限定在配置的日志根目录内）。 */
  readTextFile: (path: string): Promise<string> => {
    return invoke<string>('read_text_file', { path });
  },
  /** 后端显示文件选择器并只读取本次选中的文件；不接受前端提供的路径。 */
  pickPluginFiles: (pluginId: string, options: {
    multiple: boolean;
    filters?: Array<{ name: string; extensions: string[] }>;
    title?: string;
  }): Promise<{ files: Array<{ path: string; base64: string }> }> => {
    return invoke('plugin_pick_files', { pluginId, options });
  },

  /** 读取图片文件为 base64 data URL（自定义背景图，issue #13）。失败/非图片 → ''。 */
  readImageDataUrl: (path: string): Promise<string> => {
    return invoke<string>('read_image_data_url', { path });
  },
};
