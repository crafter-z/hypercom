import { test, expect, type Page } from '@playwright/test';

/**
 * Mock `window.__TAURI_INTERNALS__` so the React layer renders without the
 * Rust backend.  The script runs before any page JS, preventing
 * "Cannot read properties of undefined (reading 'metadata')" from
 * `@tauri-apps/api/window#getCurrentWindow` and similar calls.
 *
 * `invoke` returns type-appropriate defaults per command so the app
 * initialises with empty state instead of crashing on `null.map()`.
 */
const TAURI_MOCK = `
(() => {
  if (window.__TAURI_INTERNALS__) return;

  const callbacks = new Map();
  let nextId = 1;

  // Commands that return arrays — must NOT return null or .map() crashes.
  const ARRAY_COMMANDS = new Set([
    'load_command_sets',
    'load_highlight_sets',
    'load_protocol_templates',
    'load_port_tool_configs',
    'load_trigger_rules',
    'load_port_presets',
    'get_log_files',
  ]);

  // 事件名 → transformCallback id（issue #6-10 e2e：驱动 serial:data 事件）
  const eventListeners = {};

  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      if (ARRAY_COMMANDS.has(cmd)) return [];
      if (cmd === 'list_available_ports') {
        // 给 e2e 一个可打开标签页的端口（issue #6-10 RX 显示路径测试）
        return [{ id: 'COM1', name: 'COM1', port_type: 'real', manufacturer: null, product: null }];
      }
      if (cmd === 'plugin:event|listen') {
        const id = nextId++;
        if (args && args.event) eventListeners[args.event] = args.handler;
        return id;
      }
      if (cmd === 'get_system_status')
        return { status: 'normal', memoryUsedMb: 0, cpuUsage: 0 };
      return null;
    },
    // 测试驱动：向某个已注册的事件监听器派发 payload（@tauri-apps/api 的
    // handler 收到 { event, payload } 对象）。
    dispatchEvent: (event, payload) => {
      const handlerId = eventListeners[event];
      const cb = callbacks.get(handlerId);
      if (cb) cb({ event, id: handlerId, payload });
    },
    transformCallback: (cb, once = false) => {
      const id = nextId++;
      callbacks.set(id, (data) => {
        if (once) callbacks.delete(id);
        return cb && cb(data);
      });
      return id;
    },
    unregisterCallback: (id) => { callbacks.delete(id); },
    runCallback: (id, data) => {
      const cb = callbacks.get(id);
      if (cb) cb(data);
    },
    callbacks,
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' },
    },
    convertFileSrc: (filePath, protocol = 'asset') =>
      'http://' + protocol + '.localhost/' + encodeURIComponent(filePath),
  };

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
})();
`;

test.describe('HyperCom smoke tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(TAURI_MOCK);
    await page.goto('/');
    // Wait for the React app root to mount
    await expect(page.locator('.app-root')).toBeVisible();
  });

  test('page loads without crashing (no error boundary)', async ({ page }) => {
    // The error boundary renders a distinct layout — ensure it is NOT shown.
    // The normal app has .titlebar as a direct child of .app-root.
    await expect(page.locator('.app-root > .titlebar')).toBeVisible();
  });

  test('TitleBar renders', async ({ page }) => {
    await expect(page.locator('.titlebar')).toBeVisible();
    await expect(page.locator('.titlebar-title')).toBeVisible();
  });

  test('Sidebar renders', async ({ page }) => {
    await expect(page.locator('.sidebar-toolbar')).toBeVisible();
  });

  test('MainDisplay renders', async ({ page }) => {
    await expect(page.locator('.main-display')).toBeVisible();
  });

  test('StatusBar renders', async ({ page }) => {
    await expect(page.locator('.statusbar')).toBeVisible();
  });

  test('OperationPanel renders', async ({ page }) => {
    await expect(page.locator('.operation-panel')).toBeVisible();
  });

  test('StatusBar renders process memory indicator (issue #6-2/6-6, #16 改版)', async ({ page }) => {
    // issue #16 改版后无内存总预算分母：状态栏显示「JS堆 XMB · 进程 YMB」
    await expect(page.locator('.statusbar')).toBeVisible();
    await expect(page.locator('.statusbar-left').getByText(/MB/)).toBeVisible();
  });

  test('GeneralSettings shows per-port max display lines input (issue #6-2, #16 改版)', async ({ page }) => {
    // 打开设置弹窗（TitleBar 右侧设置按钮）
    await page.locator('.titlebar-right button[title="设置"]').click();
    await expect(page.locator('.modal-overlay')).toBeVisible();
    // issue #16 改版：双内存预算 → 单一「最大显示行数」
    await expect(page.locator('.config-page').getByText('最大显示行数:')).toBeVisible();
  });

  // ==================== issue #6-10：RX 显示 + 隐藏窗口排空 ====================

  /** 打开 COM1 标签页（侧边栏双击端口行）并等终端渲染 */
  async function openCom1Tab(page: import('@playwright/test').Page): Promise<void> {
    await page.locator('.port-item-name', { hasText: 'COM1' }).dblclick();
    await expect(page.locator('.tab-item', { hasText: 'COM1' })).toBeVisible();
  }

  /** 通过 mock 事件桥向应用派发一条 serial:data */
  async function dispatchSerialData(
    page: import('@playwright/test').Page,
    portId: string,
    text: string,
  ): Promise<void> {
    await page.evaluate(
      ({ portId, text }) => {
        const bytes = Array.from(new TextEncoder().encode(text));
        window.__TAURI_INTERNALS__.dispatchEvent('serial:data', {
          port_id: portId,
          timestamp: Date.now(),
          direction: 'RX',
          data: bytes,
          is_hex: false,
        });
      },
      { portId, text },
    );
  }

  test('RX serial data renders in the terminal (issue #6-10)', async ({ page }) => {
    await openCom1Tab(page);
    await dispatchSerialData(page, 'COM1', 'hello-rx\n');
    await expect(page.locator('.terminal-line .terminal-content').first()).toContainText(
      'hello-rx',
    );
  });

  test('RX data still drains while the document is hidden (issue #6-10)', async ({ page }) => {
    await openCom1Tab(page);
    // 强制页面进入隐藏态（rAF 停摆的等价条件）+ 派发 visibilitychange 让管线重排
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await dispatchSerialData(page, 'COM1', 'hidden-drain\n');
    // 隐藏时 rAF 停摆，管线靠 setTimeout 兜底排空——行仍应出现在终端
    await expect(page.locator('.terminal-line .terminal-content').first()).toContainText(
      'hidden-drain',
    );
  });

  // ==================== issue #7-1：通知中心串口号 + 时间戳 ====================

  /** 通过 mock 事件桥派发 serial:status 连接状态变化 */
  async function dispatchSerialStatus(
    page: import('@playwright/test').Page,
    portId: string,
    status: string,
  ): Promise<void> {
    await page.evaluate(
      ({ portId, status }) => {
        window.__TAURI_INTERNALS__.dispatchEvent('serial:status', { port_id: portId, status });
      },
      { portId, status },
    );
  }

  test('notification center shows port id + timestamp for serial messages (issue #7-1)', async ({ page }) => {
    await openCom1Tab(page);
    // 模拟已连接端口意外断开 → portLost toast 携带串口号
    await dispatchSerialStatus(page, 'COM1', 'connected');
    await dispatchSerialStatus(page, 'COM1', 'disconnected');
    // 打开通知中心（状态栏铃铛）
    await page.locator('.notify-btn').click();
    const row = page.locator('.notify-row').first();
    await expect(row).toBeVisible();
    // 串口 chip 展示消息来源
    await expect(row.locator('.notify-row-port')).toHaveText('COM1');
    // 每条通知都带时间戳（HH:MM:SS）
    await expect(row.locator('.notify-row-time')).toHaveText(/\d{2}:\d{2}:\d{2}/);
  });

  test('trigger alert toast carries the rule port context (issue #7-1)', async ({ page }) => {
    await openCom1Tab(page);
    // 触发告警走 serial:data 匹配路径（无规则时无告警——此处仅验证配置规则路径不崩溃）
    await dispatchSerialData(page, 'COM1', 'anything\n');
    // 铃铛仍可用（未配置触发规则时不应有通知）
    await page.locator('.notify-btn').click();
    await expect(page.locator('.notify-empty')).toBeVisible();
  });

  // ==================== issue #7-10：自定义文本右键菜单 ====================

  test('custom context menu replaces the native menu on text areas (issue #7-10)', async ({ page }) => {
    await openCom1Tab(page);
    const input = page.locator('.op-send-input');
    await input.fill('AA BB CC');
    // 选中一部分文本（复制/剪切需要选区）
    await input.evaluate((el: HTMLTextAreaElement) => {
      el.focus();
      el.setSelectionRange(0, 5);
    });
    // 右键 → 应用自己的菜单（剪切/复制/粘贴/全选…），而非 webview 原生菜单
    await input.click({ button: 'right', position: { x: 20, y: 10 } });
    await expect(page.locator('.context-menu')).toBeVisible();
    await expect(page.locator('.context-menu-item', { hasText: '复制' })).toBeVisible();
    await expect(page.locator('.context-menu-item', { hasText: '粘贴' })).toBeVisible();
    await expect(page.locator('.context-menu-item', { hasText: '全选' })).toBeVisible();
    // Escape 关闭
    await page.keyboard.press('Escape');
    await expect(page.locator('.context-menu')).toHaveCount(0);
  });

  test('right-click on non-editable area shows no native menu (issue #7-10)', async ({ page }) => {
    // 侧边栏空白区域右键：不应出现自定义文本菜单（非可编辑元素被屏蔽）
    await page.locator('.sidebar').click({ button: 'right', position: { x: 30, y: 200 } });
    await page.waitForTimeout(200);
    await expect(page.locator('.context-menu')).toHaveCount(0);
  });

  // ==================== issue #12：自动更新 ====================

  test('About manual check finds an update and opens the dialog (issue #12)', async ({ page }) => {
    // mock 后端：手动检查 stable 返回一个有更新的 payload（dev server 外其余命令回退原 mock）
    await page.evaluate(() => {
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (cmd: string, args?: { channel?: string }) => {
        if (cmd === 'check_for_update' && args?.channel === 'stable') {
          return {
            version: '0.6.0',
            currentVersion: '0.5.2',
            date: 1750000000,
            notes: 'New stable release notes',
            channel: 'stable',
          };
        }
        return original(cmd, args as never);
      };
    });

    // 打开 About 对话框（标题栏「关于」图标按钮）
    await page.locator('.titlebar-right button[title="关于"]').click();
    await expect(page.locator('.modal-dialog-compact')).toBeVisible();
    // 点「检查正式版更新」→ 弹窗应出现
    await page.locator('.about-actions button', { hasText: '检查正式版更新' }).click();
    await expect(page.locator('.update-channel-badge')).toBeVisible();
    await expect(page.locator('.update-channel-badge')).toHaveText('正式版');
    await expect(page.locator('.update-version')).toHaveText('0.6.0');
    await expect(page.locator('.update-changelog-body')).toHaveText('New stable release notes');
    // 三动作按钮存在
    await expect(page.locator('.update-actions button', { hasText: '立即更新' })).toBeVisible();
    await expect(page.locator('.update-actions button', { hasText: '7 天后提醒' })).toBeVisible();
    await expect(page.locator('.update-actions button', { hasText: '不更新（永不提醒）' })).toBeVisible();
  });

  test('Update dialog never-remind syncs updateCheckMode=none (issue #12)', async ({ page }) => {
    // mock：每次 stable 检查都有新版本 → 手动检查 → 永不提醒 → 设置项同步
    await page.evaluate(() => {
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (cmd: string, args?: { channel?: string }) => {
        if (cmd === 'check_for_update' && args?.channel === 'stable') {
          return {
            version: '0.6.1',
            currentVersion: '0.5.2',
            date: 1750000000,
            notes: 'notes',
            channel: 'stable',
          };
        }
        return original(cmd, args as never);
      };
    });
    // About → 手动检查 → 永不提醒
    await page.locator('.titlebar-right button[title="关于"]').click();
    await page.locator('.about-actions button', { hasText: '检查正式版更新' }).click();
    await page.locator('.update-actions button', { hasText: '不更新（永不提醒）' }).click();
    await expect(page.locator('.update-dialog-meta')).toHaveCount(0);
    // 打开设置弹窗 → 自动更新 radio「不自动检查更新」应被选中
    await page.locator('.titlebar-right button[title="设置"]').click();
    await expect(page.locator('.config-page').getByText('不自动检查更新')).toBeVisible();
    const radio = page.locator('input[name="updateCheckMode"][value="none"]');
    await expect(radio).toBeChecked();
  });

  // ==================== issue #11：关闭标签页不关闭串口 ====================

  test('closing a tab keeps the port connected; reopening starts a fresh session (issue #11)', async ({ page }) => {
    await openCom1Tab(page);
    await dispatchSerialStatus(page, 'COM1', 'connected');
    await dispatchSerialData(page, 'COM1', 'hello-before\n');
    await expect(page.locator('.terminal-line .terminal-content').first()).toContainText('hello-before');

    // 包装 invoke：记录 close_port 调用（关闭标签页不得触碰串口连接）
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__closePortCalls = 0;
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (cmd: string, args?: unknown) => {
        if (cmd === 'close_port') {
          (window as unknown as Record<string, unknown>).__closePortCalls =
            ((window as unknown as Record<string, unknown>).__closePortCalls as number) + 1;
        }
        return original(cmd, args);
      };
    });

    // 关闭标签页
    await page.locator('.tab-item', { hasText: 'COM1' }).locator('.tab-close').click();
    await expect(page.locator('.tab-item', { hasText: 'COM1' })).toHaveCount(0);
    // 端口仍保持连接（侧边栏连接态）
    await expect(page.locator('.port-item.connected')).toBeVisible();
    const closeCalls = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__closePortCalls as number,
    );
    expect(closeCalls).toBe(0);

    // 关闭期间数据继续到达（端口仍连接）——前端无显示目标，静默丢弃
    await dispatchSerialData(page, 'COM1', 'hello-during\n');
    await page.waitForTimeout(200);

    // 重新打开标签页 → 从零开始：无关闭前的旧数据
    await page.locator('.port-item-name', { hasText: 'COM1' }).dblclick();
    await expect(page.locator('.tab-item', { hasText: 'COM1' })).toBeVisible();
    await expect(page.locator('.terminal-line .terminal-content')).toHaveCount(0);

    await dispatchSerialData(page, 'COM1', 'hello-after\n');
    await expect(page.locator('.terminal-line .terminal-content').first()).toContainText('hello-after');
    const text = await page.locator('.terminal-view').innerText();
    expect(text).not.toContain('hello-before');
    expect(text).not.toContain('hello-during');
  });

  // ==================== issue #10：高频输出 + 缓冲裁剪阶段 DOM 有界 ====================

  test('high-rate RX with buffer trim keeps the row DOM bounded (issue #10)', async ({ page }) => {
    await openCom1Tab(page);
    const stats = await page.evaluate(async () => {
      const view = document.querySelector('.terminal-view') as HTMLElement;
      let maxRows = 0;
      let nonMonotonic = 0;
      let prevSt: number | null = null;
      let raf = 0;
      const sample = () => {
        maxRows = Math.max(maxRows, view.querySelectorAll('.terminal-line').length);
        const st = view.scrollTop;
        if (prevSt !== null && st < prevSt) nonMonotonic++;
        prevSt = st;
        raf = requestAnimationFrame(sample);
      };
      raf = requestAnimationFrame(sample);
      const lines: number[] = [];
      for (let i = 0; i < 400; i++) lines.push(i);
      const bytes = Array.from(new TextEncoder().encode(lines.map((i) => `line-${i}`).join('\n') + '\n'));
      const interval = setInterval(() => {
        window.__TAURI_INTERNALS__.dispatchEvent('serial:data', {
          port_id: 'COM1', timestamp: Date.now(), direction: 'RX', data: bytes, is_hex: false,
        });
      }, 8);
      // 填满默认缓冲（100000 行 × 500/预算）并覆盖持续 trim 阶段
      await new Promise((r) => setTimeout(r, 10000));
      clearInterval(interval);
      cancelAnimationFrame(raf);
      return { maxRows, nonMonotonic };
    });
    // DOM 行数有界（窗口 + overscan；修复前 head trim 泄漏到数千行 → 每帧 O(n)
    // 渲染 → 输出区抖动）
    expect(stats.maxRows).toBeLessThanOrEqual(40);
    // 跟随 scrollTop 单调（无回跳）
    expect(stats.nonMonotonic).toBe(0);
  });

  // ==================== issue #12：拖选滚动时新露出的行可渲染可选中 ====================

  test('drag-selecting while scrolling up shows newly exposed rows (issue #12)', async ({ page }) => {
    await openCom1Tab(page);
    // 灌入足够数据（20 × 50 行）
    for (let i = 0; i < 20; i++) {
      await dispatchSerialData(page, 'COM1', `chunk-${i}\n`.repeat(50));
    }
    await page.waitForTimeout(300);
    // 滚到内容中部
    await page.locator('.terminal-view').evaluate((el: HTMLElement) => { el.scrollTop = el.scrollHeight / 2; });
    await page.waitForTimeout(100);

    // 鼠标按下（终端行上）→ 拖选冻结开始
    const box = (await page.locator('.terminal-view').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // 向上滚动——新行进入视口（修复前 selecting 冻结期跳过创建 → 黑块、选不到）
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, -300);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await page.waitForTimeout(300);

    // 视口内所有行都必须已渲染且带内容
    const visibleRows = await page.locator('.terminal-view').evaluate((el: HTMLElement) => {
      const rows = el.querySelectorAll('.terminal-line') as NodeListOf<HTMLElement>;
      const box = el.getBoundingClientRect();
      const res: Array<{ seq: number; hasContent: boolean }> = [];
      const top = el.scrollTop;
      const bottom = top + el.clientHeight;
      for (const r of rows) {
        const y = r.getBoundingClientRect().top - box.top + el.scrollTop;
        if (y >= top && y < bottom) {
          const content = r.querySelector('.terminal-content');
          res.push({
            seq: Number(r.dataset.seq),
            hasContent: !!content && content.textContent!.length > 0,
          });
        }
      }
      return res;
    });
    expect(visibleRows.length).toBeGreaterThan(5);
    for (const r of visibleRows) expect(r.hasContent).toBe(true);
  });

  // ==================== issue #17：拖选期间滚轮滚动后选区起点保持 ====================

  test('drag-select then wheel-scroll keeps the selection anchored (issue #17)', async ({ page }) => {
    await openCom1Tab(page);
    // 灌入大量数据（60 × 50 行 = 3000 行）
    for (let i = 0; i < 60; i++) {
      await page.evaluate((i) => {
        const bytes = Array.from(new TextEncoder().encode(`chunk-${i}-${'x'.repeat(30)}\n`.repeat(50)));
        window.__TAURI_INTERNALS__.dispatchEvent('serial:data', {
          port_id: 'COM1', timestamp: Date.now(), direction: 'RX', data: bytes, is_hex: false,
        });
      }, i);
    }
    // 滚到内容中部（解锁 follow）
    const view = page.locator('.terminal-view');
    await view.evaluate((el: HTMLElement) => { el.scrollTop = el.scrollHeight / 2; });
    await page.waitForTimeout(200);

    // 在视口中部某行按下鼠标开始拖选
    const box = (await view.boundingBox())!;
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    // 用视口坐标 elementFromPoint 取鼠标按下位置的行（比 translateY 推算可靠）
    const startSeq = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      const row = el?.closest?.('[data-seq]');
      return row ? Number(row.getAttribute('data-seq')) : null;
    }, { x: startX, y: startY });
    expect(startSeq).not.toBeNull();
    // 定位鼠标到起点行（按下前）
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY + 8 * 16, { steps: 5 });

    // 拖选期间滚轮向上滚动 —— 起点行滚出视口（issue #17 场景）。
    // 滚动量须保持选区 ≤ MAX_PINNED_ROWS(600)：15 × 400px ≈ 375 行，
    // 超限是渲染器的设计上限（pin 集合主动放弃 → 选区随之消亡）。
    for (let i = 0; i < 15; i++) {
      await page.mouse.wheel(0, -400);
      await page.waitForTimeout(16);
    }
    // 松开鼠标结束拖选
    await page.mouse.up();

    await page.waitForTimeout(300);
    // 原生选区必须仍存在（pin 机制：滚出视口的行被 park 保留，display:none
    // 但不脱离 DOM —— 修复前回收起点行 → 选区清空/漂移）。
    // 注意：本场景拖选向下延伸 + 滚轮向上滚 → 选中行全部位于窗口下方并被
    // park 隐藏，Chromium 的 Selection.toString() 不计 display:none 内容，
    // 存活判定必须基于 Range 端点（节点存在 + 未折叠），不能用 toString()。
    const selInfo = await page.evaluate(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return { ok: false, anchor: null, focus: null, anchorText: '' };
      const r = sel.getRangeAt(0);
      const findRow = (n: Node | null): HTMLElement | null => {
        let el: Element | null = n instanceof Element ? n : (n?.parentElement ?? null);
        while (el) {
          if (el.hasAttribute('data-seq')) return el as HTMLElement;
          el = el.parentElement;
        }
        return null;
      };
      const anchorRow = findRow(r.startContainer);
      const rowText = (row: HTMLElement | null): string =>
        row?.querySelector('.terminal-content')?.textContent ?? '';
      return {
        ok: true,
        anchor: anchorRow?.getAttribute('data-seq') ?? null,
        focus: findRow(r.endContainer)?.getAttribute('data-seq') ?? null,
        anchorText: rowText(anchorRow),
      };
    });

    expect(selInfo.ok).toBe(true);
    expect(selInfo.anchor).not.toBeNull();
    expect(selInfo.focus).not.toBeNull();
    expect(Number(selInfo.anchor)).toBeLessThan(Number(selInfo.focus));
    // 锚点行仍挂在 DOM 中：窗口内为普通流行，窗口外为 parked（display:none）
    // 但必须是 .terminal-content-layer 的子节点
    const anchorState = await page.evaluate((seq) => {
      const layer = document.querySelector('.terminal-content-layer');
      const row = layer?.querySelector(`[data-seq="${seq}"]`) ?? null;
      if (!row) return { present: false, parked: false };
      return { present: true, parked: (row as HTMLElement).style.display === 'none' };
    }, Number(selInfo.anchor));
    expect(anchorState.present).toBe(true);
    // 选区文本仍包含起点行的内容前缀（pinned 行内容不被重写）
    expect(selInfo.anchorText.startsWith('chunk-')).toBe(true);
  });

  test('selection endpoint anchored on a fresh row survives release (issue #17)', async ({ page }) => {
    await openCom1Tab(page);
    // 初始数据 + follow 到底部
    for (let i = 0; i < 20; i++) {
      await page.evaluate((i) => {
        const bytes = Array.from(new TextEncoder().encode(`init-${i}-${'y'.repeat(40)}\n`.repeat(20)));
        window.__TAURI_INTERNALS__.dispatchEvent('serial:data', {
          port_id: 'COM1', timestamp: Date.now(), direction: 'RX', data: bytes, is_hex: false,
        });
      }, i);
    }
    await page.waitForTimeout(400);
    const view = page.locator('.terminal-view');

    // 起点：视口中部某行；终点：拖到视口底部（最后可见行）
    const box = (await view.boundingBox())!;
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, box.y + box.height - 4, { steps: 5 });

    // 拖选期间灌新数据：终点行可能落在拖选期间到达的新行上——pin 规则
    // 下该行不会被回收/重写，release 后选区终点不得漂移
    for (let i = 0; i < 15; i++) {
      await page.evaluate((i) => {
        const bytes = Array.from(new TextEncoder().encode(`fresh-${i}-${'z'.repeat(40)}\n`.repeat(8)));
        window.__TAURI_INTERNALS__.dispatchEvent('serial:data', {
          port_id: 'COM1', timestamp: Date.now(), direction: 'RX', data: bytes, is_hex: false,
        });
      }, i);
    }
    await page.waitForTimeout(300);
    await page.mouse.up();
    await page.waitForTimeout(300);

    // release 后立即读取选区 + 延迟再读：选区必须存活且焦点行不漂移
    const readSel = () => page.evaluate(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return { ok: false, anchor: null, focus: null, text: '' };
      const r = sel.getRangeAt(0);
      const findRow = (n: Node | null): HTMLElement | null => {
        let el: Element | null = n instanceof Element ? n : (n?.parentElement ?? null);
        while (el) {
          if (el.hasAttribute('data-seq')) return el as HTMLElement;
          el = el.parentElement;
        }
        return null;
      };
      const s = findRow(r.startContainer);
      const f = findRow(r.endContainer);
      return {
        ok: sel.toString().length > 0,
        anchor: s?.getAttribute('data-seq') ?? null,
        focus: f?.getAttribute('data-seq') ?? null,
        text: sel.toString().slice(0, 40),
      };
    });
    const immediate = await readSel();
    await page.waitForTimeout(800);
    const delayed = await readSel();
    expect(immediate.ok).toBe(true);
    expect(delayed.ok).toBe(true);
    // 焦点行不得漂移：pin 规则下 focus 行（即使已 park 为 display:none）
    // 不被回收/重写，选区端点在 release 后保持稳定
    expect(delayed.focus).toBe(immediate.focus);
    expect(delayed.focus).not.toBeNull();
  });

  // ==================== issue #15/#10：嵌套分屏位移 + 大 trim 视口锚点 ====================

  /** 打开指定串口标签页（侧边栏双击端口行） */
  async function openPortTab(page: Page, portId: string): Promise<void> {
    await page.locator('.port-item-name', { hasText: portId }).dblclick();
    await expect(page.locator('.tab-item', { hasText: portId })).toBeVisible();
  }

  /** 收集页面错误（未捕获异常 + console.error），断言为空 */
  function collectErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    return errors;
  }

  test('splitPane nested-branch move does not crash the renderer (issue #15)', async ({ page }) => {
    // 构造 issue #15 的嵌套分支场景：左右分屏后，左 Pane 持有两标签、右 Pane
    // 一标签；聚焦左 Pane 的标签再次 split → 左 Pane 的叶子节点在树中位移
    // （branch[branch'[leafA, newLeaf], leafB]）→ TerminalView 跨 Pane 重挂载。
    // 修复前 detach 不清 active，旧行成为孤儿节点，新容器 render 的
    // insertRowInOrder 对脱链 reference 调 insertBefore → DOMException。
    // 关键：split 前把 COM1 滚到中部（解锁 follow）——重挂载后视口在顶部，
    // 新窗口行与旧 active 不重叠，迫使 insertRowInOrder 必须相对孤儿行归位。
    const errors = collectErrors(page);

    // mock 后端：多返回两个端口（轮询 3s 后生效）
    await page.evaluate(() => {
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (cmd: string, args?: unknown) => {
        if (cmd === 'list_available_ports') {
          return ['COM1', 'COM2', 'COM3'].map((id) => ({
            id, name: id, port_type: 'real', manufacturer: null, product: null,
          }));
        }
        return original(cmd, args);
      };
    });
    await expect(page.locator('.port-item-name', { hasText: 'COM2' })).toBeVisible({ timeout: 6000 });
    await expect(page.locator('.port-item-name', { hasText: 'COM3' })).toBeVisible();

    // ① 打开 COM1 + COM2（同在单 Pane）→ split 垂直 → [main(COM1), leafB(COM2)]
    await openPortTab(page, 'COM1');
    await openPortTab(page, 'COM2');
    await page.locator('.pane-container-inner.pane-focused .tab-bar-split-group button:first-child').click();
    await expect(page.locator('.pane-node')).toHaveCount(2);

    // ② 给 COM1 灌数据并渲染（renderer 持有 active 行）
    await dispatchSerialData(page, 'COM1', 'line-1\nline-2\nline-3\n'.repeat(15));
    await expect(
      page.locator('.pane-node:has(.tab-item:has-text("COM1")) .terminal-line'),
    ).not.toHaveCount(0, { timeout: 5000 });

    // ③ 滚到中部（解锁 follow）：旧 active 行在视口中部
    const com1Terminal = page.locator(
      '.pane-node:has(.tab-item:has-text("COM1")) .terminal-view',
    );
    await com1Terminal.hover();
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(400); // settle（120ms 手势静默）→ scrollLocked=false

    // ④ 聚焦 COM1 → 打开 COM3 落左 Pane → 聚焦 COM1 → 再 split（嵌套位移）
    await page.locator('.pane-node:has(.tab-item:has-text("COM1")) .tab-item:has-text("COM1")').click();
    await openPortTab(page, 'COM3');
    await expect(page.locator('.pane-node:has(.tab-item:has-text("COM1")) .tab-item:has-text("COM3")')).toBeVisible();
    await page.locator('.pane-node:has(.tab-item:has-text("COM1")) .tab-item:has-text("COM1")').click();
    await page.locator('.pane-container-inner.pane-focused .tab-bar-split-group button:first-child').click();

    // ⑤ 重挂载窗口期：不得抛 insertBefore DOMException；终端正常重建
    await page.waitForTimeout(600);
    // 只断言崩溃特征（insertBefore DOMException）——其余无关 console.error 噪音
    // 不参与判定
    expect(errors.filter((e) => e.includes('insertBefore'))).toEqual([]);
    await expect(
      page.locator('.pane-node:has(.tab-item:has-text("COM1")) .terminal-line'),
    ).not.toHaveCount(0, { timeout: 5000 });
    // 拆分后左 Pane（COM3）与右 Pane（COM2）仍各自渲染
    await dispatchSerialData(page, 'COM3', 'after-split-com3\n');
    await expect(
      page.locator('.pane-node:has(.tab-item:has-text("COM3")) .terminal-line .terminal-content').first(),
    ).toContainText('after-split-com3', { timeout: 5000 });
    expect(errors.filter((e) => e.includes('insertBefore'))).toEqual([]);
  });

  test('small maxDisplayLines: gradual eviction keeps the viewport stable and DOM bounded (issue #16 redesign)', async ({ page }) => {
    // 行数上限改版后：缓冲超限是逐行覆盖（滚动窗口），每帧 head 前进 ≤
    // maxLinesPerTick(2000) —— 不存在单帧大跳，锚点恢复路径不适用。本用例
    // 断言改版后的真实行为：小上限 + 高频 RX 持续覆盖最旧行时，① 视口内容
    // 不跳变（已解锁非 follow 的阅读位置在滚动窗口内稳定平移，无突发甩走），
    // ② DOM 行数有界（窗口 + overscan），③ 最新行始终可渲染。
    // mock get_config：小行数上限（config 启动时加载，必须在 goto 前注入）
    await page.addInitScript(() => {
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (cmd: string, args?: unknown) => {
        if (cmd === 'get_config') return { maxDisplayLines: 4000 };
        return original(cmd, args);
      };
    });
    await page.goto('/');
    await expect(page.locator('.app-root')).toBeVisible();
    await openPortTab(page, 'COM1');

    const view = page.locator('.terminal-view');
    // 灌入 3000 行（< 4000 上限，不触发覆盖）
    const chunk1 = await page.evaluate(() => {
      const line = 'A'.repeat(2560);
      return Array.from({ length: 3000 }, () => line).join('\n') + '\n';
    });
    await dispatchSerialData(page, 'COM1', chunk1);
    await page.waitForTimeout(1200);

    // 滚离底部并解锁 follow（wheel → settle → scrollLocked=false）
    await view.hover();
    await page.mouse.wheel(0, -6000);
    await page.waitForTimeout(600);
    const before = await view.evaluate((el: HTMLElement) => {
      // issue #18 flow layout: rows are normal flow divs (no transform) —
      // the row nearest the viewport center is the middle child's data-seq.
      const rows = el.querySelectorAll('.terminal-line:not([style*="display: none"])');
      const mid = Math.floor(rows.length / 2);
      const row = rows[mid] as HTMLElement | undefined;
      return {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        midSeq: row ? Number(row.dataset.seq) : null,
      };
    });
    expect(before.scrollTop).toBeGreaterThan(0);
    expect(before.scrollTop).toBeLessThan(before.scrollHeight - before.clientHeight - 100);
    expect(before.midSeq).not.toBeNull();

    // 追加 5 块 × 3000 行 = 15000 行 → 总量 18000 > 4000 上限，持续逐行覆盖
    // 最旧 ~14000 行。
    for (let i = 0; i < 5; i++) {
      await dispatchSerialData(page, 'COM1', chunk1);
      await page.waitForTimeout(800);
    }
    await page.waitForTimeout(1200);

    const after = await view.evaluate((el: HTMLElement) => {
      const rows = el.querySelectorAll('.terminal-line:not([style*="display: none"])');
      const mid = Math.floor(rows.length / 2);
      const row = rows[mid] as HTMLElement | undefined;
      return {
        rows: el.querySelectorAll('.terminal-line:not([style*="display: none"])').length,
        scrollTop: el.scrollTop,
        midSeq: row ? Number(row.dataset.seq) : null,
      };
    });
    expect(after.rows).toBeGreaterThan(0);
    expect(after.rows).toBeLessThanOrEqual(100); // DOM 有界（窗口 + overscan）
    expect(after.midSeq).not.toBeNull();
    // 远小于覆盖总量 14000 行（容差 2000 行覆盖 maxLinesPerTick 单帧上限）
    expect(after.midSeq! - before.midSeq!).toBeGreaterThan(0);
    expect(after.midSeq! - before.midSeq!).toBeLessThan(16000);
  });
});
