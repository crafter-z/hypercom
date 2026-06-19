import React from 'react';
import { Trash2 } from 'lucide-react';
import type { SendCommand } from '../../../types';

const SendCmdEditor: React.FC<{
  cmd: SendCommand;
  cmdIdx: number;
  onChange: (patch: Partial<SendCommand>) => void;
  onDelete: () => void;
}> = ({ cmd, cmdIdx, onChange, onDelete }) => (
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

export default SendCmdEditor;
