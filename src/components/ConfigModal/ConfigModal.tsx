import React, { useState, useEffect } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useConfigPersistence } from '../../hooks/useTauri';
import { storageService } from '../../services/tauri';
import type { AppConfig, HighlightRuleSet, HighlightRule, SendCommandSet, SendCommand } from '../../types';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Settings, FileText, HardDrive, Monitor, Palette, Send, X,
  Plus, Trash2, Check, GripVertical
} from 'lucide-react';

interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
}

const navItems: NavItem[] = [
  { id: 'general', label: '通用设置', icon: <Settings size={16} /> },
  { id: 'log', label: '日志设置', icon: <FileText size={16} /> },
  { id: 'backup', label: '备份管理', icon: <HardDrive size={16} /> },
  { id: 'display', label: '显示与交互', icon: <Monitor size={16} /> },
  { id: 'highlight', label: '语法高亮规则', icon: <Palette size={16} /> },
  { id: 'commands', label: '发送命令规则', icon: <Send size={16} /> },
];

const GeneralSettings: React.FC = () => {
  const config = useAppStore((s) => s.config);
  const setConfig = useAppStore((s) => s.setConfig);

  return (
    <div className="config-page">
      <h3 className="config-page-title">通用设置</h3>

      <div className="config-row">
        <label>程序关闭行为:</label>
        <select
          className="select"
          value={config.closeBehavior}
          onChange={(e) => setConfig({ closeBehavior: e.target.value as AppConfig['closeBehavior'] })}
        >
          <option value="minimize">最小化到托盘</option>
          <option value="exit">直接退出</option>
        </select>
      </div>

      <div className="config-row">
        <label>内存占用上限 (MB):</label>
        <input
          className="input"
          type="number"
          value={config.memoryLimitMB}
          onChange={(e) => setConfig({ memoryLimitMB: Number(e.target.value) })}
          min={64}
          max={4096}
          step={64}
        />
      </div>

      <div className="config-row">
        <label>语言:</label>
        <select
          className="select"
          value={config.language}
          onChange={(e) => setConfig({ language: e.target.value as AppConfig['language'] })}
        >
          <option value="zh-CN">简体中文</option>
          <option value="en-US">English</option>
        </select>
      </div>

      <div className="config-row">
        <label>主题:</label>
        <select
          className="select"
          value={config.theme}
          onChange={(e) => setConfig({ theme: e.target.value as AppConfig['theme'] })}
        >
          <option value="light">亮色</option>
          <option value="dark">暗色</option>
          <option value="system">跟随系统</option>
        </select>
      </div>

      <div className="config-row">
        <label className="checkbox-wrapper">
          <input type="checkbox" checked={config.preventScreenOff} onChange={(e) => setConfig({ preventScreenOff: e.target.checked })} />
          防止系统息屏
        </label>
        <label className="checkbox-wrapper">
          <input type="checkbox" checked={config.preventSleep} onChange={(e) => setConfig({ preventSleep: e.target.checked })} />
          防止系统休眠
        </label>
      </div>

      <div className="divider-h" />
      <h4 className="config-section-title">字体设置</h4>

      <div className="config-row">
        <label>终端字体:</label>
        <input className="input" value={config.terminalFont} onChange={(e) => setConfig({ terminalFont: e.target.value })} />
        <input className="input" type="number" value={config.terminalFontSize} onChange={(e) => setConfig({ terminalFontSize: Number(e.target.value) })} style={{ width: 60 }} />
        <span>px</span>
      </div>

      <div className="config-row">
        <label>UI字体:</label>
        <input className="input" value={config.uiFont} onChange={(e) => setConfig({ uiFont: e.target.value })} />
        <input className="input" type="number" value={config.uiFontSize} onChange={(e) => setConfig({ uiFontSize: Number(e.target.value) })} style={{ width: 60 }} />
        <span>px</span>
      </div>

      <div className="config-row">
        <label>背景图片:</label>
        <input className="input" value={config.backgroundImage || ''} placeholder="选择图片路径..." readOnly />
        <button className="btn btn-sm" onClick={async () => {
          const result = await open({ directory: false, multiple: false, filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp'] }] });
          if (result) setConfig({ backgroundImage: result });
        }}>浏览...</button>
      </div>
    </div>
  );
};

const LogSettings: React.FC = () => {
  const config = useAppStore((s) => s.config);
  const setConfig = useAppStore((s) => s.setConfig);

  return (
    <div className="config-page">
      <h3 className="config-page-title">日志设置</h3>

      <label className="checkbox-wrapper">
        <input type="checkbox" checked={config.autoSaveLog} onChange={(e) => setConfig({ autoSaveLog: e.target.checked })} />
        自动保存日志
      </label>

      <div className="config-row">
        <label>日志存储目录:</label>
        <input className="input" value={config.logDirectory} placeholder="选择日志保存路径..." readOnly />
        <button className="btn btn-sm" onClick={async () => {
          const result = await open({ directory: true });
          if (result) setConfig({ logDirectory: result });
        }}>浏览...</button>
      </div>

      <div className="config-row">
        <label>文件名格式:</label>
        <input className="input" value={config.logFilenameFormat} onChange={(e) => setConfig({ logFilenameFormat: e.target.value })} />
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>可用变量: [com], [datetime], [date], [time]</span>
      </div>

      <div className="config-row">
        <label>日志格式:</label>
        <select className="select" value={config.logFormat} onChange={(e) => setConfig({ logFormat: e.target.value as AppConfig['logFormat'] })}>
          <option value="string">字符串</option>
          <option value="hex">十六进制</option>
          <option value="binary">二进制</option>
        </select>
      </div>

      <div className="config-row">
        <label>日志编码:</label>
        <select className="select" value={config.logEncoding} onChange={(e) => setConfig({ logEncoding: e.target.value as AppConfig['logEncoding'] })}>
          <option value="ASCII">ASCII</option>
          <option value="UTF-8">UTF-8</option>
        </select>
      </div>

      <label className="checkbox-wrapper">
        <input type="checkbox" checked={config.logSplitEnabled} onChange={(e) => setConfig({ logSplitEnabled: e.target.checked })} />
        开启分片存储
      </label>

      {config.logSplitEnabled && (
        <div className="config-row">
          <label>分片大小 (MB):</label>
          <input className="input" type="number" value={config.logSplitSizeMB} onChange={(e) => setConfig({ logSplitSizeMB: Number(e.target.value) })} min={1} />
        </div>
      )}
    </div>
  );
};

const BackupSettings: React.FC = () => {
  const config = useAppStore((s) => s.config);
  const setConfig = useAppStore((s) => s.setConfig);

  return (
    <div className="config-page">
      <h3 className="config-page-title">备份管理</h3>

      <label className="checkbox-wrapper">
        <input type="checkbox" checked={config.backupEnabled} onChange={(e) => setConfig({ backupEnabled: e.target.checked })} />
        开启日志库备份
      </label>

      {config.backupEnabled && (
        <>
          <div className="config-row">
            <label>备份周期 (小时):</label>
            <input className="input" type="number" value={config.backupInterval} onChange={(e) => setConfig({ backupInterval: Number(e.target.value) })} min={1} />
          </div>
          <div className="config-row">
            <label>备份存储目录:</label>
            <input className="input" value={config.backupDirectory} placeholder="选择备份保存路径..." readOnly />
            <button className="btn btn-sm" onClick={async () => {
              const result = await open({ directory: true });
              if (result) setConfig({ backupDirectory: result });
            }}>浏览...</button>
          </div>
        </>
      )}
    </div>
  );
};

const DisplaySettings: React.FC = () => {
  const config = useAppStore((s) => s.config);
  const setConfig = useAppStore((s) => s.setConfig);

  return (
    <div className="config-page">
      <h3 className="config-page-title">显示与交互</h3>

      <div className="config-row">
        <label>预设波特率:</label>
        <input
          className="input"
          value={config.defaultBaudRates.join(', ')}
          onChange={(e) => setConfig({ defaultBaudRates: e.target.value.split(',').map(s => Number(s.trim())).filter(Boolean) })}
          style={{ flex: 1 }}
        />
      </div>

      <label className="checkbox-wrapper">
        <input type="checkbox" checked={config.showPortType} onChange={(e) => setConfig({ showPortType: e.target.checked })} />
        显示串口类型 (虚拟/真实)
      </label>

      <div className="config-row">
        <label>默认换行方式:</label>
        <select className="select" value={config.defaultLineEnding} onChange={(e) => setConfig({ defaultLineEnding: e.target.value as AppConfig['defaultLineEnding'] })}>
          <option value="\\r\\n">\r\n</option>
          <option value="\\r">\r</option>
          <option value="\\n">\n</option>
        </select>
      </div>

      <div className="config-row">
        <label>发送提示前缀:</label>
        <input className="input" value={config.sendPrefix} onChange={(e) => setConfig({ sendPrefix: e.target.value })} />
      </div>

      <div className="config-row">
        <label>时间戳显示方式:</label>
        <select className="select" value={config.timestampMode} onChange={(e) => setConfig({ timestampMode: e.target.value as AppConfig['timestampMode'] })}>
          <option value="perLine">每行显示一个时间戳</option>
          <option value="perRound">每轮输出显示一个时间戳</option>
        </select>
      </div>
    </div>
  );
};

const HighlightSettings: React.FC = () => {
  const highlightRuleSets = useAppStore((s) => s.highlightRuleSets);
  const addHighlightRuleSet = useAppStore((s) => s.addHighlightRuleSet);
  const updateHighlightRuleSet = useAppStore((s) => s.updateHighlightRuleSet);
  const removeHighlightRuleSet = useAppStore((s) => s.removeHighlightRuleSet);
  const [expandedSetId, setExpandedSetId] = useState<string | null>(null);

  useEffect(() => {
    storageService.loadHighlightSets().then(sets => {
      if (sets.length > 0) {
        useAppStore.getState().setHighlightRuleSets(sets.map(s => ({
          id: s.id,
          name: s.name,
          isEnabled: s.is_enabled,
          rules: s.rules.map(r => ({
            id: r.id,
            name: r.name,
            pattern: r.pattern,
            isRegex: r.is_regex,
            color: r.color,
            bold: r.bold,
            italic: r.italic,
          })),
        })));
      }
    }).catch(() => {});
  }, []);

  const handleSaveSet = async (set: HighlightRuleSet) => {
    try {
      await storageService.saveHighlightSet({
        name: set.name,
        is_enabled: set.isEnabled,
        rules: set.rules.map(r => ({
          id: r.id,
          name: r.name,
          pattern: r.pattern,
          is_regex: r.isRegex,
          color: r.color || '',
          bold: r.bold || false,
          italic: r.italic || false,
        })),
      });
    } catch (err) {
      console.error('Failed to save highlight set:', err);
    }
  };

  const handleAddSet = () => {
    const id = `hl-${Date.now()}`;
    addHighlightRuleSet({ id, name: '新建规则集', rules: [], isEnabled: true });
    setExpandedSetId(id);
  };

  const handleAddRule = (setId: string) => {
    const ruleId = `rule-${Date.now()}`;
    const sets = useAppStore.getState().highlightRuleSets;
    const set = sets.find(s => s.id === setId);
    if (set) {
      updateHighlightRuleSet(setId, {
        rules: [...set.rules, {
          id: ruleId,
          name: `规则 ${set.rules.length + 1}`,
          pattern: '',
          isRegex: false,
          color: '#ff6b6b',
          bold: false,
          italic: false,
        }]
      });
    }
  };

  const RuleEditor: React.FC<{ rule: HighlightRule; ruleIdx: number; onChange: (patch: Partial<HighlightRule>) => void; onDelete: () => void }> = ({ rule, ruleIdx: _ruleIdx, onChange, onDelete }) => (
    <div style={{ background: 'var(--bg-secondary)', borderRadius: 4, padding: 8, marginBottom: 6 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
        <GripVertical size={12} style={{ opacity: 0.4 }} />
        <input className="input" value={rule.name} onChange={e => onChange({ name: e.target.value })} placeholder="规则名称" style={{ width: 100 }} />
        <input className="input" value={rule.pattern} onChange={e => onChange({ pattern: e.target.value })} placeholder="匹配模式" style={{ flex: 1 }} />
        <label className="checkbox-wrapper" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={rule.isRegex} onChange={e => onChange({ isRegex: e.target.checked })} />正则
        </label>
        <input type="color" value={rule.color || '#ff6b6b'} onChange={e => onChange({ color: e.target.value })} style={{ width: 28, height: 24, border: '1px solid var(--border-color)', borderRadius: 3, padding: 0 }} />
        <label className="checkbox-wrapper" style={{ fontSize: 11 }}>
          <input type="checkbox" checked={rule.bold || false} onChange={e => onChange({ bold: e.target.checked })} />B
        </label>
        <label className="checkbox-wrapper" style={{ fontSize: 11, fontStyle: 'italic' }}>
          <input type="checkbox" checked={rule.italic || false} onChange={e => onChange({ italic: e.target.checked })} />I
        </label>
        <button className="btn btn-icon btn-sm" onClick={onDelete} title="删除规则"><Trash2 size={12} /></button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
        预览: <span style={{
          color: rule.color || 'inherit',
          fontWeight: rule.bold ? 'bold' : 'normal',
          fontStyle: rule.italic ? 'italic' : 'normal',
        }}>{rule.pattern || '(空模式)'}</span>
      </div>
    </div>
  );

  return (
    <div className="config-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 className="config-page-title" style={{ marginBottom: 0 }}>语法高亮规则集</h3>
        <button className="btn btn-sm" onClick={handleAddSet}><Plus size={14} /> 新建规则集</button>
      </div>
      <p className="config-page-desc">
        管理语法高亮规则集。每个规则集包含多条规则，支持正则表达式或关键词匹配，可设置颜色、加粗、斜体。
        启用多个规则集可同时生效。
      </p>

      {highlightRuleSets.length === 0 && (
        <div className="config-placeholder">暂无规则集，点击"新建规则集"创建</div>
      )}

      {highlightRuleSets.map(set => (
        <div key={set.id} style={{ border: '1px solid var(--border-color)', borderRadius: 6, marginBottom: 10, overflow: 'hidden' }}>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--bg-secondary)', cursor: 'pointer' }}
            onClick={() => setExpandedSetId(expandedSetId === set.id ? null : set.id)}
          >
            <span>{expandedSetId === set.id ? '▼' : '▶'}</span>
            <input
              className="input"
              value={set.name}
              onChange={e => updateHighlightRuleSet(set.id, { name: e.target.value })}
              onClick={e => e.stopPropagation()}
              style={{ border: 'none', background: 'transparent', fontWeight: 600, flex: 1, minWidth: 0 }}
            />
            <label className="checkbox-wrapper" style={{ fontSize: 11 }} onClick={e => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={set.isEnabled}
                onChange={e => updateHighlightRuleSet(set.id, { isEnabled: e.target.checked })}
              /> 启用
            </label>
            <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{set.rules.length} 条规则</span>
            <button className="btn btn-icon btn-sm" title="保存到数据库" onClick={e => { e.stopPropagation(); handleSaveSet(set); }}>
              <Check size={14} />
            </button>
            <button className="btn btn-icon btn-sm" title="删除规则集" onClick={e => { e.stopPropagation(); removeHighlightRuleSet(set.id); }}>
              <Trash2 size={14} />
            </button>
          </div>

          {expandedSetId === set.id && (
            <div style={{ padding: 10 }}>
              <button className="btn btn-sm" onClick={() => handleAddRule(set.id)} style={{ marginBottom: 8 }}>
                <Plus size={12} /> 添加规则
              </button>
              {set.rules.length === 0 && <div className="config-placeholder" style={{ fontSize: 12 }}>暂无规则，请添加</div>}
              {set.rules.map((rule, idx) => (
                <RuleEditor
                  key={rule.id}
                  rule={rule}
                  ruleIdx={idx}
                  onChange={(patch) => {
                    const newRules = set.rules.map((r, i) => i === idx ? { ...r, ...patch } : r);
                    updateHighlightRuleSet(set.id, { rules: newRules });
                  }}
                  onDelete={() => {
                    updateHighlightRuleSet(set.id, { rules: set.rules.filter((_, i) => i !== idx) });
                  }}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

const CommandSettings: React.FC = () => {
  const sendCommandSets = useAppStore((s) => s.sendCommandSets);
  const addSendCommandSet = useAppStore((s) => s.addSendCommandSet);
  const updateSendCommandSet = useAppStore((s) => s.updateSendCommandSet);
  const removeSendCommandSet = useAppStore((s) => s.removeSendCommandSet);
  const [expandedSetId, setExpandedSetId] = useState<string | null>(null);

  useEffect(() => {
    storageService.loadCommandSets().then(sets => {
      if (sets.length > 0) {
        useAppStore.getState().setSendCommandSets(sets.map(s => ({
          id: s.id,
          name: s.name,
          isLoop: s.is_loop,
          loopDelay: s.loop_delay_ms,
          commands: s.commands.map(c => ({
            id: c.id,
            name: c.name,
            order: c.order_idx,
            delay: c.delay_ms,
            type: c.cmd_type as 'string' | 'hex',
            content: c.content,
            appendLineEnding: c.append_line_ending as SendCommand['appendLineEnding'],
          })),
        })));
      }
    }).catch(() => {});
  }, []);

  const handleSaveSet = async (set: SendCommandSet) => {
    try {
      await storageService.saveCommandSet({
        name: set.name,
        is_loop: set.isLoop,
        loop_delay_ms: set.loopDelay,
        commands: set.commands.map(c => ({
          id: c.id,
          name: c.name,
          order_idx: c.order,
          delay_ms: c.delay,
          cmd_type: c.type,
          content: c.content,
          append_line_ending: c.appendLineEnding,
        })),
      });
    } catch (err) {
      console.error('Failed to save command set:', err);
    }
  };

  const handleAddSet = () => {
    const id = `cmd-${Date.now()}`;
    addSendCommandSet({ id, name: '新建命令集', commands: [], isLoop: false, loopDelay: 1000 });
    setExpandedSetId(id);
  };

  const handleAddCmd = (setId: string) => {
    const cmdId = `scmd-${Date.now()}`;
    const sets = useAppStore.getState().sendCommandSets;
    const set = sets.find(s => s.id === setId);
    if (set) {
      updateSendCommandSet(setId, {
        commands: [...set.commands, {
          id: cmdId,
          name: `命令 ${set.commands.length + 1}`,
          order: set.commands.length,
          delay: 100,
          type: 'string',
          content: '',
          appendLineEnding: '\\r\\n',
        }]
      });
    }
  };

  const CmdEditor: React.FC<{ cmd: SendCommand; cmdIdx: number; onChange: (patch: Partial<SendCommand>) => void; onDelete: () => void }> = ({ cmd, cmdIdx, onChange, onDelete }) => (
    <div style={{ background: 'var(--bg-secondary)', borderRadius: 4, padding: 8, marginBottom: 6 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)', minWidth: 20 }}>#{cmdIdx + 1}</span>
        <input className="input" value={cmd.name} onChange={e => onChange({ name: e.target.value })} placeholder="名称" style={{ width: 80 }} />
        <input className="input" value={String(cmd.delay)} onChange={e => onChange({ delay: Number(e.target.value) || 0 })} type="number" placeholder="延时(ms)" style={{ width: 80 }} />
        <select className="select" value={cmd.type} onChange={e => onChange({ type: e.target.value as 'string' | 'hex' })} style={{ width: 80 }}>
          <option value="string">字符串</option>
          <option value="hex">HEX</option>
        </select>
        <select className="select" value={cmd.appendLineEnding} onChange={e => onChange({ appendLineEnding: e.target.value as SendCommand['appendLineEnding'] })} style={{ width: 70 }}>
          <option value="\\r\\n">\r\n</option>
          <option value="\\r">\r</option>
          <option value="\\n">\n</option>
          <option value="None">无</option>
        </select>
        <button className="btn btn-icon btn-sm" onClick={onDelete} title="删除"><Trash2 size={12} /></button>
      </div>
      <input className="input" value={cmd.content} onChange={e => onChange({ content: e.target.value })} placeholder="命令内容..." style={{ width: '100%' }} />
    </div>
  );

  return (
    <div className="config-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 className="config-page-title" style={{ marginBottom: 0 }}>发送命令规则集</h3>
        <button className="btn btn-sm" onClick={handleAddSet}><Plus size={14} /> 新建规则集</button>
      </div>
      <p className="config-page-desc">
        管理自动发送命令规则集。每个规则集包含多条命令，可设置顺序、名称、延时、发送类型、命令内容。
        支持循环发送模式。
      </p>

      {sendCommandSets.length === 0 && (
        <div className="config-placeholder">暂无命令规则集，点击"新建规则集"创建</div>
      )}

      {sendCommandSets.map(set => (
        <div key={set.id} style={{ border: '1px solid var(--border-color)', borderRadius: 6, marginBottom: 10, overflow: 'hidden' }}>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--bg-secondary)', cursor: 'pointer' }}
            onClick={() => setExpandedSetId(expandedSetId === set.id ? null : set.id)}
          >
            <span>{expandedSetId === set.id ? '▼' : '▶'}</span>
            <input
              className="input"
              value={set.name}
              onChange={e => updateSendCommandSet(set.id, { name: e.target.value })}
              onClick={e => e.stopPropagation()}
              style={{ border: 'none', background: 'transparent', fontWeight: 600, flex: 1, minWidth: 0 }}
            />
            <label className="checkbox-wrapper" style={{ fontSize: 11 }} onClick={e => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={set.isLoop}
                onChange={e => updateSendCommandSet(set.id, { isLoop: e.target.checked })}
              /> 循环
            </label>
            {set.isLoop && (
              <input
                className="input"
                type="number"
                value={set.loopDelay}
                onChange={e => updateSendCommandSet(set.id, { loopDelay: Number(e.target.value) })}
                onClick={e => e.stopPropagation()}
                style={{ width: 60, fontSize: 11 }}
                placeholder="ms"
              />
            )}
            <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{set.commands.length} 条命令</span>
            <button className="btn btn-icon btn-sm" title="保存到数据库" onClick={e => { e.stopPropagation(); handleSaveSet(set); }}>
              <Check size={14} />
            </button>
            <button className="btn btn-icon btn-sm" title="删除" onClick={e => { e.stopPropagation(); removeSendCommandSet(set.id); }}>
              <Trash2 size={14} />
            </button>
          </div>

          {expandedSetId === set.id && (
            <div style={{ padding: 10 }}>
              <button className="btn btn-sm" onClick={() => handleAddCmd(set.id)} style={{ marginBottom: 8 }}>
                <Plus size={12} /> 添加命令
              </button>
              {set.commands.length === 0 && <div className="config-placeholder" style={{ fontSize: 12 }}>暂无命令，请添加</div>}
              {set.commands.map((cmd, idx) => (
                <CmdEditor
                  key={cmd.id}
                  cmd={cmd}
                  cmdIdx={idx}
                  onChange={(patch) => {
                    const newCmds = set.commands.map((c, i) => i === idx ? { ...c, ...patch } : c);
                    updateSendCommandSet(set.id, { commands: newCmds });
                  }}
                  onDelete={() => {
                    updateSendCommandSet(set.id, { commands: set.commands.filter((_, i) => i !== idx) });
                  }}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

const ConfigModal: React.FC = () => {
  const isConfigOpen = useAppStore((s) => s.ui.isConfigOpen);
  const configActiveTab = useAppStore((s) => s.ui.configActiveTab);
  const toggleConfigModal = useAppStore((s) => s.toggleConfigModal);
  const setConfigActiveTab = useAppStore((s) => s.setConfigActiveTab);
  const { saveConfig } = useConfigPersistence();

  if (!isConfigOpen) return null;

  const renderContent = () => {
    switch (configActiveTab) {
      case 'general': return <GeneralSettings />;
      case 'log': return <LogSettings />;
      case 'backup': return <BackupSettings />;
      case 'display': return <DisplaySettings />;
      case 'highlight': return <HighlightSettings />;
      case 'commands': return <CommandSettings />;
      default: return <GeneralSettings />;
    }
  };

  return (
    <div className="modal-overlay animate-fade-in" onClick={() => toggleConfigModal(false)}>
      <div className="modal-dialog animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <div className="modal-nav">
          <div className="modal-nav-header">
            <h2 className="modal-nav-title">设置</h2>
          </div>
          <div className="modal-nav-list">
            {navItems.map(item => (
              <div
                key={item.id}
                className={`modal-nav-item${configActiveTab === item.id ? ' active' : ''}`}
                onClick={() => setConfigActiveTab(item.id)}
              >
                <span className="modal-nav-icon">{item.icon}</span>
                {item.label}
              </div>
            ))}
          </div>
        </div>

        <div className="modal-content-area">
          <div className="modal-content-header">
            <span className="modal-content-title">
              {navItems.find(n => n.id === configActiveTab)?.label}
            </span>
            <button className="btn btn-icon" onClick={() => toggleConfigModal(false)} title="关闭">
              <X size={16} />
            </button>
          </div>

          <div className="modal-content-body">
            {renderContent()}
          </div>

          <div className="modal-content-footer">
            <button className="btn" onClick={() => toggleConfigModal(false)}>取消</button>
            <button className="btn btn-primary" onClick={async () => { await saveConfig(useAppStore.getState().config); toggleConfigModal(false); }}>保存</button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfigModal;
