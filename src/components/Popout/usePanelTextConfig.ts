import { useCallback, useEffect, useState } from 'react';
import { LINE_ENDING_VALUES } from '../../utils/sendUtils';
import { clampInterval, clampRoundInterval } from '../../utils/textSend';
import type { LineEnding, TextSendConfig } from '../../types';

/** 面板文本模式配置的 localStorage 键（弹窗独立 webview 的本地持久化）。 */
const TEXT_CONFIG_KEY = 'hypercom.quickSend.textConfig';

const DEFAULT_TEXT_CONFIG: TextSendConfig = {
  portId: '',
  lineEnding: '\\r\\n',
  isHex: false,
  sendIntervalMs: 200,
  roundIntervalMs: 1000,
};

/** 读取上次使用的文本发送配置；JSON 损坏/缺字段/越界取值时回退默认值。 */
function loadTextConfig(): TextSendConfig {
  try {
    const raw = localStorage.getItem(TEXT_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_TEXT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<TextSendConfig>;
    const lineEnding = (LINE_ENDING_VALUES as readonly string[]).includes(parsed.lineEnding ?? '')
      ? (parsed.lineEnding as LineEnding)
      : DEFAULT_TEXT_CONFIG.lineEnding;
    return {
      portId: typeof parsed.portId === 'string' ? parsed.portId : '',
      lineEnding,
      isHex: typeof parsed.isHex === 'boolean' ? parsed.isHex : DEFAULT_TEXT_CONFIG.isHex,
      sendIntervalMs: clampInterval(parsed.sendIntervalMs ?? DEFAULT_TEXT_CONFIG.sendIntervalMs),
      roundIntervalMs: clampRoundInterval(
        parsed.roundIntervalMs ?? DEFAULT_TEXT_CONFIG.roundIntervalMs,
      ),
    };
  } catch {
    return { ...DEFAULT_TEXT_CONFIG };
  }
}

/**
 * 面板参数（目标端口 / 行尾 / STR·HEX / 发送间隔 / 轮次间隔）的本地持久化。
 *
 * 弹窗是独立 webview：这些参数是「这个窗口上次怎么用的」，既不属于主窗配置也不属于
 * 后端，所以只有 localStorage 一份。写盘随每次变更即时进行，读取时兜底损坏 JSON。
 */
export function usePanelTextConfig(): {
  config: TextSendConfig;
  /** 局部更新并落盘（面板全部调用点都是 patch 语义）。 */
  patchConfig: (patch: Partial<TextSendConfig>) => void;
} {
  const [config, setConfig] = useState<TextSendConfig>(loadTextConfig);

  useEffect(() => {
    try {
      localStorage.setItem(TEXT_CONFIG_KEY, JSON.stringify(config));
    } catch {
      // 存储不可用（隐私模式等）时静默跳过，不影响功能。
    }
  }, [config]);

  const patchConfig = useCallback((patch: Partial<TextSendConfig>) => {
    setConfig((c) => ({ ...c, ...patch }));
  }, []);

  return { config, patchConfig };
}
