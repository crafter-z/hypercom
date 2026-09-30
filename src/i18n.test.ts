/**
 * i18n 契约测试：`src/i18n.ts` 里 zh-CN / en-US 两份翻译必须逐键镜像。
 *
 * 为什么不直接断言 import 出来的对象：
 * 1) 对象字面量中的重复键会被后者静默覆盖，只有源文本能发现「同一个键写了两遍」；
 * 2) 运行时对象丢失书写顺序，而两份翻译的分组顺序错位会在后续增删时持续制造
 *    漂移（本轮修掉过一处 params.mode 被插进 baudRate 组中间）。
 * 解析器本身由「与 i18next 运行时资源包一致」用例兜底，防止漏行让奇偶断言空过。
 */
import { describe, it, expect } from 'vitest';
// `?raw` 直接拿到源文本：本仓未安装 @types/node，走 node:fs 会引入 TS2307。
import SOURCE from './i18n.ts?raw';
import i18n from './i18n';

const LANGUAGES = ['zh-CN', 'en-US'] as const;
type Language = (typeof LANGUAGES)[number];

interface Entry {
  line: number;
  key: string;
  value: string;
  /** 插值占位符签名（排序后用 , 连接）——两侧必须一致，否则运行时漏替显示原文。 */
  placeholders: string;
}

/** 取某语言 `translation: { ... }` 块内的扁平键值（keySeparator: false）。 */
function parseTranslationEntries(source: string, lang: Language): Entry[] {
  const lines = source.split(/\r?\n/);
  const langLine = lines.findIndex((l) => l.trim() === `'${lang}': {`);
  if (langLine < 0) throw new Error(`i18n: 未找到语言块 ${lang}`);
  const start = lines.findIndex((l, i) => i > langLine && l.trim() === 'translation: {');
  if (start < 0) throw new Error(`i18n: ${lang} 缺少 translation 块`);

  const entries: Entry[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*},\s*$/.test(line)) break; // translation 块收尾
    // 值可以是单引号或双引号：含撇号的英文文案写成 "..." 以免转义
    const m = /^\s*'([^']+)':\s*(?:'([^']*)'|"([^"]*)"),$/.exec(line);
    if (!m) continue;
    const value = m[2] ?? m[3];
    const placeholders = (value.match(/\{\{\s*[\w.]+\s*\}\}/g) ?? []).sort().join(',');
    entries.push({ line: i + 1, key: m[1], value, placeholders });
  }
  return entries;
}

const parsed = {
  'zh-CN': parseTranslationEntries(SOURCE, 'zh-CN'),
  'en-US': parseTranslationEntries(SOURCE, 'en-US'),
} satisfies Record<Language, Entry[]>;

const zhKeys = parsed['zh-CN'].map((e) => e.key);
const enKeys = parsed['en-US'].map((e) => e.key);

// i18next 默认 initImmediate=true，资源包在下一个宏任务才落到 data store；
// 监听器与 import 同 tick 注册，因此不会错过 initialized 事件。
const i18nInitialized = new Promise<void>((done) => {
  if (i18n.isInitialized) done();
  else i18n.on('initialized', () => done());
});

describe('i18n 双语键奇偶', () => {
  it('解析到的键与 i18next 运行时资源包一致', async () => {
    await i18nInitialized;
    for (const lang of LANGUAGES) {
      const bundle: unknown = i18n.getResourceBundle(lang, 'translation');
      expect(bundle, `${lang} 资源包缺失`).toBeTruthy();
      expect(
        parsed[lang].map((e) => e.key).sort(),
        `${lang} 解析结果与运行时资源包不一致`,
      ).toEqual(Object.keys(bundle as Record<string, string>).sort());
    }
  });

  it('两种语言的键集合完全相等', () => {
    const zhSet = new Set(zhKeys);
    const enSet = new Set(enKeys);
    expect({
      onlyZh: zhKeys.filter((k) => !enSet.has(k)),
      onlyEn: enKeys.filter((k) => !zhSet.has(k)),
    }).toEqual({ onlyZh: [], onlyEn: [] });
  });

  it('两种语言的键书写顺序一致（分组镜像，便于审阅与后续增删）', () => {
    expect(enKeys).toEqual(zhKeys);
  });

  it('同一语言内没有重复键', () => {
    for (const lang of LANGUAGES) {
      const seen = new Set<string>();
      const duplicates: string[] = [];
      for (const { key, line } of parsed[lang]) {
        if (seen.has(key)) duplicates.push(`${lang} ${key} (line ${line})`);
        seen.add(key);
      }
      expect(duplicates).toEqual([]);
    }
  });

  it('每个键都有非空文案', () => {
    const blank: string[] = [];
    for (const lang of LANGUAGES) {
      for (const { key, value, line } of parsed[lang]) {
        if (value.trim() === '') blank.push(`${lang} ${key} (line ${line})`);
      }
    }
    expect(blank).toEqual([]);
  });

  it('同一键的插值占位符两侧一致', () => {
    const zhPlaceholders: Record<string, string> = {};
    for (const entry of parsed['zh-CN']) zhPlaceholders[entry.key] = entry.placeholders;
    const mismatched = parsed['en-US']
      // 键缺失由「键集合完全相等」用例负责，这里只比对同名键
      .filter((entry) => entry.key in zhPlaceholders && zhPlaceholders[entry.key] !== entry.placeholders)
      .map((entry) => entry.key);
    expect(mismatched).toEqual([]);
  });
});
