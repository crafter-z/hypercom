/**
 * Worker 可见的宿主能力描述（`host.info`，无权限、只读、无副作用）。
 *
 * 用途：插件需要探测某个**可选** Worker API 是否由当前宿主实现时使用，例如
 * `shell.start` 的 `options.serialLoan`。插件必须按 `features.<能力>` 的布尔值
 * 分支，**不要解析宿主应用版本字符串**：版本号会随发布漂移，同一版本也可能来自
 * 不同构建，不能作为能力证据。
 *
 * 契约稳定性：
 * - `apiVersion` 是载荷形状版本，只在出现不兼容变化时递增；新增能力用新字段，
 *   旧字段语义保持不变。插件应检查 `features` 中的具体能力，而不是要求精确的
 *   `apiVersion` 相等。
 * - 能力字段必须与同一次构建里的实际实现一致。`features.serialLoan` 对应
 *   `shell.start` 的 `options.serialLoan`（见 src-tauri/src/commands/plugin_shell_tasks.rs、
 *   src/utils/pluginProcess.ts）。若原生契约被移除或门控，必须同步删除该标志，
 *   不能继续声明一个不可用的能力——声明为 true 只会让插件在真实调用时收到
 *   native 拒绝，不会绕过任何授权或串口校验。
 * - 旧宿主没有该 op，会直接 reject；插件必须按「能力不可用」处理（fail closed），
 *   不得退回版本号猜测。
 */

/** `host.info` 载荷形状版本（不等于宿主应用版本，也不代表最低宿主版本）。 */
export const PLUGIN_HOST_API_VERSION = 1;

export interface PluginHostInfo {
  /** 载荷形状版本；当前为 1。 */
  readonly apiVersion: number;
  /** 可选 Worker 能力声明；插件只读取自己关心的字段。 */
  readonly features: {
    /** `shell.start(request, {serialLoan})` 接受串口借用并报告原生归还结果。 */
    readonly serialLoan: boolean;
    /** `plugin.serial.loan` 显式串口租约控制（acquire / heartbeat / release）。 */
    readonly portLease: boolean;
    // 未来能力在这里增量添加；不要复用/改变已有字段语义。
  };
}

/** 当前宿主构建的能力描述。返回值会被结构化克隆，插件得到普通对象。 */
export const PLUGIN_HOST_INFO: PluginHostInfo = Object.freeze({
  apiVersion: PLUGIN_HOST_API_VERSION,
  features: Object.freeze({ serialLoan: true, portLease: true }),
});
