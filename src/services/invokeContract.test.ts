/**
 * 跨语言 invoke 契约守卫（JS → Rust）。
 *
 * 为什么需要：`invoke('cmd', args)` 的**命令名**与**嵌套参数 key** 都是字符串
 * 字面量——tsc 看不见、e2e 的 Tauri mock 忽略 args、vitest 也跑不到真实 IPC。
 * Rust 侧 `generate_handler!` 与 `#[tauri::command]` 的漂移有守卫，JS 侧此前完全
 * 没有；本轮重构删了 7 个命令、改了 3 个命令的形参，全靠人肉核对。本文件补上
 * 这唯一一道 JS 侧自动化守卫。
 *
 * 断言方式：静态解析源文本（跨语言无法在编译期链接）。源文本经 vite 的 `?raw`
 * 导入，不依赖 node:fs（项目未装 @types/node；手法参 `src/utils/bounds.test.ts`）。
 *
 * 覆盖两组：
 *  (a) 命令名漂移：前端 `invoke(...)` 字面量 ↔ `src-tauri/src/lib.rs` 的
 *      `generate_handler![...]` 双向一致。**非字面量（动态）命令名一律失败**——
 *      静态核不了就等于没有守卫，新增动态命令名必须显式改成字面量或走白名单。
 *  (b) 参数形状：本次重构改过的调用点，解析**实际传的 key 集合**并与 Rust 结构体
 *      字段名对照（wire 名 = Rust 字段名，snake_case；顶层形参 camelCase）。
 *
 * 关于反向白名单：当前 `generate_handler!` 里 64 条命令**全部**有前端调用方，故
 * 白名单为空。机制保留：将来后端新增命令却暂无前端调用时，必须在此逐条登记一句
 * 「谁在用 / 为何保留」，否则反向断言报红——避免长列表无脑堆积掩盖真实漂移。
 */
import { describe, it, expect } from 'vitest';
import libSource from '../../src-tauri/src/lib.rs?raw';
import serialRustSource from '../../src-tauri/src/commands/serial.rs?raw';

// ---------------------------------------------------------------------------
// 源文本收集
// ---------------------------------------------------------------------------

/**
 * `src/**` 全部 .ts/.tsx 源文本（key 为相对本文件的 glob 路径）。
 * 排除 `*.test.ts(x)`：测试文件 mock service 而非直接 invoke，且本文件自身的
 * 匹配正则里就含 `invoke(` 字样——把测试纳入扫描会「自己匹配自己」。
 */
const modules = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const sources: Array<{ file: string; code: string }> = Object.entries(modules)
  .filter(([file]) => !/\.test\.tsx?$/.test(file))
  .map(([file, code]) => ({ file, code: stripComments(code) }));

// ---------------------------------------------------------------------------
// 词法小工具
// ---------------------------------------------------------------------------

/** 去掉 `//` 行注释与块注释；字符串/模板字面量内容原样保留。 */
function stripComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(source, i);
      out.push(source.slice(i, end));
      i = end;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

/** 从 `start`（引号字符）扫到匹配的收尾引号，返回其**之后**的下标。 */
function skipString(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i++;
  }
  return i;
}

/** 从 `openIdx`（`{`）取到配对的 `}`，返回**不含外层花括号**的对象体文本。 */
function objectBody(text: string, openIdx: number): string {
  let depth = 0;
  let i = openIdx;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(text, i);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
    i++;
  }
  throw new Error('invoke 参数对象花括号不配对');
}

/** 从 `start`（某个顶层值的起点）扫到下一个顶层逗号（或结尾），返回其下标。 */
function scanValueEnd(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(text, i);
      continue;
    }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') {
      if (depth === 0) break;
      depth--;
    } else if (c === ',' && depth === 0) break;
    i++;
  }
  return i;
}

interface Prop {
  key: string;
  value: string;
}

/** 解析对象体的**顶层**属性（简写属性 key===value；`...spread` 跳过）。 */
function topLevelProps(body: string): Prop[] {
  const props: Prop[] = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i])) i++;
    if (i >= body.length) break;
    const keyMatch = /^[A-Za-z_$][\w$]*/.exec(body.slice(i));
    if (!keyMatch) {
      // spread / 计算属性键等——跳到下一个顶层逗号
      i = scanValueEnd(body, i);
      continue;
    }
    const key = keyMatch[0];
    let j = i + key.length;
    while (j < body.length && /\s/.test(body[j])) j++;
    if (body[j] === ':') {
      j++;
      while (j < body.length && /\s/.test(body[j])) j++;
      const end = scanValueEnd(body, j);
      props.push({ key, value: body.slice(j, end) });
      i = end;
    } else {
      props.push({ key, value: key }); // 简写属性
      i = j;
    }
  }
  return props;
}

// ---------------------------------------------------------------------------
// 前端 call site 扫描
// ---------------------------------------------------------------------------

interface CallSite {
  file: string;
  command: string;
  /** `invoke(...)` 第二个实参若为内联对象，则是其顶层对象体；否则 null。 */
  body: string | null;
}

const snippet = (code: string, idx: number): string =>
  code.slice(idx, idx + 70).replace(/\s+/g, ' ').trim();

function collectCallSites(): { calls: CallSite[]; dynamic: string[] } {
  const calls: CallSite[] = [];
  const dynamic: string[] = [];
  // 泛型参数允许嵌套 <>、逗号；排除 ()/; 防止跨行跑飞。
  const invokeStart = /\binvoke\s*(?:<[^;()]*?>)?\s*\(/g;
  for (const { file, code } of sources) {
    for (const m of code.matchAll(invokeStart)) {
      const argStart = m.index + m[0].length;
      const argText = code.slice(argStart).replace(/^\s+/, '');
      const quote = argText[0];
      if (quote !== '"' && quote !== "'") {
        // 模板串 / 变量 / 其它表达式：无法静态核对
        dynamic.push(`${file}: ${snippet(code, m.index)}`);
        continue;
      }
      const strEnd = skipString(argText, 0);
      const command = argText.slice(1, strEnd - 1);
      let rest = argText.slice(strEnd).replace(/^\s*/, '');
      let body: string | null = null;
      if (rest[0] === ',') {
        rest = rest.slice(1).replace(/^\s*/, '');
        if (rest[0] === '{') body = objectBody(rest, 0);
      }
      calls.push({ file, command, body });
    }
  }
  return { calls, dynamic };
}

// ---------------------------------------------------------------------------
// Rust 侧解析
// ---------------------------------------------------------------------------

/** `generate_handler![...]` 中的 `commands::<name>` 列表。 */
function parseHandlerCommands(source: string): string[] {
  const block = /generate_handler!\[([\s\S]*?)\]/.exec(source);
  if (!block) throw new Error('lib.rs 中未找到 generate_handler!');
  return [...block[1].matchAll(/commands::(\w+)/g)].map((m) => m[1]);
}

/** `struct <name> { pub field: ... }` 的字段名列表（保序）。 */
function parseStructFields(source: string, name: string): string[] {
  const m = new RegExp(`struct\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  if (!m) throw new Error(`serial.rs 中未找到 struct ${name}`);
  return [...m[1].matchAll(/pub\s+(\w+)\s*:/g)].map((x) => x[1]);
}

// ---------------------------------------------------------------------------
// 反向白名单
// ---------------------------------------------------------------------------

/**
 * 「已注册但前端暂无调用方」的合法命令 → 理由。
 *
 * 当前为空：下面的断言统计出 generate_handler! 的 64 条命令全部有前端调用方。
 * 新增命令若暂时只注册不接线，在此登记一句理由（谁在用 / 为何保留）。
 */
const FRONTEND_RETENTION_WHITELIST: Readonly<Record<string, string>> = {};

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

const { calls, dynamic } = collectCallSites();
const invoked = new Set(calls.map((c) => c.command));
const byCommand = new Map<string, CallSite[]>();
for (const call of calls) {
  const list = byCommand.get(call.command);
  if (list) list.push(call);
  else byCommand.set(call.command, [call]);
}
const handlerCommands = parseHandlerCommands(libSource);
const handlerSet = new Set(handlerCommands);

function expectSingleCall(command: string): CallSite {
  const list = byCommand.get(command) ?? [];
  expect(list.length, `invoke('${command}') 应恰好出现一次`).toBe(1);
  return list[0];
}

/** 内联 `args` 对象体的 key 集合。 */
function argsBody(call: CallSite): string {
  expect(call.body, `invoke('${call.command}') 未带内联参数对象`).not.toBeNull();
  const prop = topLevelProps(call.body!).find((p) => p.key === 'args');
  expect(prop, `invoke('${call.command}') 顶层缺少 args`).toBeDefined();
  const value = prop!.value.trim();
  expect(value.startsWith('{'), `invoke('${call.command}') 的 args 不是内联对象`).toBe(true);
  return objectBody(value, 0);
}

const keysOf = (body: string): Set<string> => new Set(topLevelProps(body).map((p) => p.key));

describe('invoke 命令名 ↔ generate_handler! 双向一致', () => {
  it('扫描确实命中前端调用点（防止 glob/正则失效造成空扫假绿）', () => {
    expect(invoked.size).toBeGreaterThan(50);
    expect(handlerCommands.length).toBeGreaterThan(50);
  });

  it('前端 invoke 命令名一律是字符串字面量', () => {
    expect(
      dynamic,
      `发现动态命令名，静态守卫无法核对；请改成字面量或登记白名单：\n${dynamic.join('\n')}`,
    ).toEqual([]);
  });

  it('前端调用的每个命令都在 generate_handler! 中注册', () => {
    const unregistered = [...invoked].filter((c) => !handlerSet.has(c)).sort();
    expect(
      unregistered,
      `前端 invoke 了未注册的 Rust 命令：${unregistered.join(', ')}`,
    ).toEqual([]);
  });

  it('generate_handler! 注册的每个命令都有前端调用方或在白名单中', () => {
    const orphans = handlerCommands
      .filter((c) => !invoked.has(c) && !(c in FRONTEND_RETENTION_WHITELIST))
      .sort();
    expect(
      orphans,
      `Rust 命令已注册但前端从不调用（请接线或登记白名单理由）：${orphans.join(', ')}`,
    ).toEqual([]);
  });
});

describe('本次重构后的参数形状（key 集合与 Rust 结构体对照）', () => {
  // 顶层形参 camelCase（Tauri 把 camelCase 键映射到 Rust 的 snake_case 形参，
  // 见 src/services/tauri.ts 文件头第 1 条）；嵌套结构体载荷用 Rust 字段名。
  it('close_popout 顶层 = { kind, targetId }', () => {
    const keys = keysOf(expectSingleCall('close_popout').body!);
    expect([...keys].sort()).toEqual(['kind', 'targetId']);
  });

  it('set_popout_always_on_top 顶层 = { kind, targetId, on }', () => {
    const keys = keysOf(expectSingleCall('set_popout_always_on_top').body!);
    expect([...keys].sort()).toEqual(['kind', 'on', 'targetId']);
  });

  it('open_serial_port 顶层 = { args }，args 键 ⊆ OpenPortArgs 字段且含全部必填字段', () => {
    const call = expectSingleCall('open_serial_port');
    expect([...keysOf(call.body!)].sort()).toEqual(['args']);

    const fields = parseStructFields(serialRustSource, 'OpenPortArgs');
    // cols/rows 带 #[serde(default)] → 可选（真实串口忽略，模拟终端缺省 80×24）。
    const optional = ['cols', 'rows'];
    const required = fields.filter((f) => !optional.includes(f));
    const keys = keysOf(argsBody(call));

    for (const f of required) {
      expect(keys.has(f), `open_serial_port args 缺少必填字段 ${f}`).toBe(true);
    }
    const unexpected = [...keys].filter((k) => !fields.includes(k));
    expect(unexpected, `open_serial_port args 出现 OpenPortArgs 之外的键：${unexpected.join(', ')}`)
      .toEqual([]);
  });

  it('send_serial_data 的 args 键 ⊆ SendDataArgs 字段', () => {
    const call = expectSingleCall('send_serial_data');
    expect([...keysOf(call.body!)].sort()).toEqual(['args']);

    const fields = parseStructFields(serialRustSource, 'SendDataArgs');
    const extra = [...keysOf(argsBody(call))].filter((k) => !fields.includes(k));
    expect(extra, `send_serial_data args 出现 SendDataArgs 之外的键：${extra.join(', ')}`)
      .toEqual([]);
  });

  it('send_file 的 args 键 = SendFileArgs 字段', () => {
    const call = expectSingleCall('send_file');
    expect([...keysOf(call.body!)].sort()).toEqual(['args']);

    const fields = parseStructFields(serialRustSource, 'SendFileArgs');
    expect([...keysOf(argsBody(call))].sort()).toEqual([...fields].sort());
  });

  it('set_serial_params 的 args 键 = SetSerialParamsArgs 字段', () => {
    const call = expectSingleCall('set_serial_params');
    expect([...keysOf(call.body!)].sort()).toEqual(['args']);

    const fields = parseStructFields(serialRustSource, 'SetSerialParamsArgs');
    expect([...keysOf(argsBody(call))].sort()).toEqual([...fields].sort());
  });
});
