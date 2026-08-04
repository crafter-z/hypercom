/**
 * 调试专用特性开关（issue #2-9）。
 *
 * `npm run tauri dev` 走 Vite dev server → `import.meta.env.DEV === true`；
 * `npm run tauri build` 产出的 release 安装包走 production 构建 → `false`。
 * 模拟串口（SIM:Loopback）按钮及其全部功能仅在调试模式可用；
 * 后端侧 `enable_simulation` / `disable_simulation` 在 release 构建下同样拒绝
 * （`cfg(not(debug_assertions))`），双层门控。
 */
export const DEV_FEATURES_ENABLED: boolean = import.meta.env.DEV;
