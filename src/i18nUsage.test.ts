/**
 * i18n 用法契约：**代码里引用的字面量键必须真实存在于 `src/i18n.ts`**。
 *
 * 为什么需要这条守卫：`i18n.test.ts` 只保证 zh-CN / en-US 两份翻译互为镜像；
 * 组件测试普遍把 `react-i18next` mock 成 `t: key => key`（断言也因此比对 key）。
 * 两边都成立时，一个**根本没写进 i18n 的键**会一路绿到用户面前，界面直接显示
 * `commandSettings.somethingMissing` 这样的原始 key。
 *
 * 覆盖面与边界：
 * - 只扫描生产代码（排除 `*.test.*`）中 `t('literal')` 与 `messageKey` /
 *   `notifySuccess` / `notifyInfo` / `fallbackKey` 的字面量实参；
 * - 变量、模板字符串拼接出来的键（如 `flow.status.${phase}`）天然扫不到，
 *   所以下面另加两条「动态族必须完整」的断言；
 * - 新增动态键族时，请在此补一条覆盖断言，而不是放宽字面量检查。
 */
import { describe, it, expect } from 'vitest';
import type { FlowPhase } from './utils/flowRuntime';

const sources = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const isTestFile = (path: string): boolean => /\.test\.(ts|tsx)$/.test(path) || /\.d\.ts$/.test(path);
const productionFiles = Object.entries(sources).filter(([path]) => !isTestFile(path));

/** i18n 源文本里的全部键（两种语言同名，Set 去重）。 */
const i18nKeys = new Set(
  [...(sources['./i18n.ts'] ?? '').matchAll(/^\s*'([^']+)':/gm)].map((match) => match[1]),
);

interface Reference {
  file: string;
  key: string;
}

function collectReferences(): Reference[] {
  const references: Reference[] = [];
  const push = (file: string, key: string) => references.push({ file, key });
  for (const [file, text] of productionFiles) {
    for (const match of text.matchAll(/\bt\(\s*(['"])([^'"]+)\1/g)) push(file, match[2]);
    for (const match of text.matchAll(/\b(?:messageKey|notifySuccess|notifyInfo|fallbackKey)\s*:?\s*\(?\s*(['"])([^'"]+)\1/g)) {
      push(file, match[2]);
    }
  }
  return references;
}

describe('i18n 用法契约', () => {
  it('扫到了 i18n 源与生产文件（防止 glob 失效让断言空过）', () => {
    expect(i18nKeys.size).toBeGreaterThan(500);
    expect(productionFiles.length).toBeGreaterThan(100);
  });

  it('代码引用的每个字面量键都存在于 i18n', () => {
    const missing = collectReferences()
      .filter(({ key }) => !i18nKeys.has(key))
      .map(({ file, key }) => `${file} → ${key}`);
    expect([...new Set(missing)]).toEqual([]);
  });

  it('flow.status.* 覆盖 FlowPhase 的每一个取值', () => {
    // 主窗状态条按阶段拼 key（flowPhaseKey），漏一个用户就会看到原始键。
    const phases: FlowPhase[] = ['starting', 'initializing', 'running', 'waiting', 'applyingParams', 'stopping', 'completed', 'stopped', 'failed'];
    expect(phases.filter((phase) => !i18nKeys.has(`flow.status.${phase}`))).toEqual([]);
  });

  it('sendCmdEditor.kind.* 覆盖所有动作类型（含未知类型提示）', () => {
    expect(['send', 'setParams', 'unknown'].filter((kind) => !i18nKeys.has(`sendCmdEditor.kind.${kind}`))).toEqual([]);
  });
});
