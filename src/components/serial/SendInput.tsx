import { useState } from 'react';
import { Send, Binary, Type } from 'lucide-react';
import { useSerialStore } from '../../stores';
import { cn, isValidHex } from '../../utils';

export function SendInput() {
  const { sendData, status } = useSerialStore();
  const [input, setInput] = useState('');
  const [format, setFormat] = useState<'hex' | 'ascii'>('hex');
  const [error, setError] = useState<string | null>(null);

  const handleSend = async () => {
    if (!input.trim()) return;

    if (format === 'hex' && !isValidHex(input)) {
      setError('无效的十六进制格式');
      return;
    }

    setError(null);
    await sendData(input.trim(), format);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isConnected = status === 'open';

  return (
    <div className="p-4 border-t border-border">
      <div className="flex gap-2">
        {/* 格式切换 */}
        <div className="flex rounded-md border border-input overflow-hidden">
          <button
            className={cn(
              "h-9 px-3 flex items-center gap-1 text-sm transition-colors",
              format === 'hex'
                ? "bg-primary text-primary-foreground"
                : "bg-background hover:bg-accent"
            )}
            onClick={() => setFormat('hex')}
          >
            <Binary className="w-4 h-4" />
            HEX
          </button>
          <button
            className={cn(
              "h-9 px-3 flex items-center gap-1 text-sm transition-colors",
              format === 'ascii'
                ? "bg-primary text-primary-foreground"
                : "bg-background hover:bg-accent"
            )}
            onClick={() => setFormat('ascii')}
          >
            <Type className="w-4 h-4" />
            ASCII
          </button>
        </div>

        {/* 输入框 */}
        <input
          type="text"
          className="flex-1 h-9 px-3 rounded-md border border-input bg-background text-sm terminal-text"
          placeholder={format === 'hex' ? '输入十六进制数据，如: 01 02 03' : '输入 ASCII 文本'}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setError(null);
          }}
          onKeyDown={handleKeyDown}
          disabled={!isConnected}
        />

        {/* 发送按钮 */}
        <button
          onClick={handleSend}
          disabled={!isConnected || !input.trim()}
          className={cn(
            "h-9 px-4 rounded-md text-sm font-medium transition-colors flex items-center gap-2",
            isConnected && input.trim()
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "bg-muted text-muted-foreground cursor-not-allowed"
          )}
        >
          <Send className="w-4 h-4" />
          发送
        </button>
      </div>

      {/* 错误提示 */}
      {error && (
        <p className="mt-2 text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}
