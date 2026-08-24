/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // 处理 CSS 导入（默认 false 会把 .css 导入 stub 成空模块）——issue #9 的
    // terminalNoWrap.test.ts 在 jsdom 下导入 terminal-view.css 并用
    // getComputedStyle 断言「终端行不换行」契约。
    css: true,
  },
}));
