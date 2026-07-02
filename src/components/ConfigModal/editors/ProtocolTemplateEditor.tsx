import React from 'react';
import { Trash2 } from 'lucide-react';
import type { ProtocolTemplate } from '../../../types';

/**
 * Protocol template editor form.
 * Controlled component — all state lives in the parent (ProtocolSettings page).
 * Follows the HighlightRuleEditor prop contract: { data, onChange(patch), onDelete() }.
 */
const ProtocolTemplateEditor: React.FC<{
  template: ProtocolTemplate;
  onChange: (patch: Partial<ProtocolTemplate>) => void;
  onDelete: () => void;
}> = ({ template, onChange, onDelete }) => {
  const sectionStyle: React.CSSProperties = {
    border: '1px solid var(--border-color)',
    borderRadius: 4,
    padding: 10,
    marginBottom: 8,
  };
  const sectionTitleStyle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    marginBottom: 8,
    textTransform: 'uppercase',
  };
  const rowStyle: React.CSSProperties = {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    marginBottom: 6,
    fontSize: 13,
  };
  const labelStyle: React.CSSProperties = {
    minWidth: 110,
    color: 'var(--text-secondary)',
  };
  const colorInputStyle: React.CSSProperties = {
    width: 28,
    height: 24,
    border: '1px solid var(--border-color)',
    borderRadius: 3,
    padding: 0,
  };

  return (
    <div style={{ background: 'var(--bg-secondary)', borderRadius: 4, padding: 8, marginBottom: 6 }}>
      {/* Section 1: Frame Structure */}
      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>帧结构</div>
        <div style={rowStyle}>
          <label style={labelStyle}>帧头 (Hex)</label>
          <input
            className="input"
            value={template.headerBytes}
            onChange={e => onChange({ headerBytes: e.target.value })}
            placeholder="AA BB (空 = 无帧头)"
            style={{ flex: 1 }}
          />
        </div>
        <div style={rowStyle}>
          <label style={labelStyle}>长度偏移</label>
          <input
            className="input"
            type="number"
            value={template.lengthFieldOffset}
            onChange={e => onChange({ lengthFieldOffset: parseInt(e.target.value) || 0 })}
            style={{ width: 80 }}
          />
          <label style={labelStyle}>长度字段大小</label>
          <select
            className="select"
            value={template.lengthFieldSize}
            onChange={e => onChange({ lengthFieldSize: Number(e.target.value) as 1 | 2 })}
            style={{ width: 80 }}
          >
            <option value={1}>1 字节</option>
            <option value={2}>2 字节</option>
          </select>
        </div>
        <div style={rowStyle}>
          <label style={labelStyle}>长度字节序</label>
          <select
            className="select"
            value={template.lengthEndian}
            onChange={e => onChange({ lengthEndian: e.target.value as 'little' | 'big' })}
            style={{ width: 120 }}
          >
            <option value="little">小端 (Little)</option>
            <option value="big">大端 (Big)</option>
          </select>
          <label style={labelStyle}>长度修正</label>
          <input
            className="input"
            type="number"
            value={template.lengthAdjust}
            onChange={e => onChange({ lengthAdjust: parseInt(e.target.value) || 0 })}
            style={{ width: 80 }}
          />
        </div>
        <div style={rowStyle}>
          <label style={labelStyle}>帧尾 (Hex)</label>
          <input
            className="input"
            value={template.footerBytes}
            onChange={e => onChange({ footerBytes: e.target.value })}
            placeholder="0D 0A (空 = 无帧尾)"
            style={{ flex: 1 }}
          />
        </div>
      </div>

      {/* Section 2: Checksum */}
      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>校验和</div>
        <div style={rowStyle}>
          <label style={labelStyle}>算法</label>
          <select
            className="select"
            value={template.checksumAlgorithm}
            onChange={e => onChange({ checksumAlgorithm: e.target.value as ProtocolTemplate['checksumAlgorithm'] })}
            style={{ width: 120 }}
          >
            <option value="none">无</option>
            <option value="sum8">Sum8</option>
            <option value="xor">XOR</option>
            <option value="crc8">CRC-8</option>
          </select>
          <label style={labelStyle}>偏移</label>
          <input
            className="input"
            type="number"
            value={template.checksumOffset}
            onChange={e => onChange({ checksumOffset: parseInt(e.target.value) || 0 })}
            style={{ width: 80 }}
          />
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>0 = 自动 (帧尾前)</span>
        </div>
      </div>

      {/* Section 3: Field Colors */}
      <div style={sectionStyle}>
        <div style={sectionTitleStyle}>字段颜色</div>
        <div style={rowStyle}>
          <label style={labelStyle}>帧头</label>
          <input type="color" value={template.colorHeader} onChange={e => onChange({ colorHeader: e.target.value })} style={colorInputStyle} />
          <label style={labelStyle}>长度</label>
          <input type="color" value={template.colorLength} onChange={e => onChange({ colorLength: e.target.value })} style={colorInputStyle} />
          <label style={labelStyle}>负载</label>
          <input type="color" value={template.colorPayload} onChange={e => onChange({ colorPayload: e.target.value })} style={colorInputStyle} />
        </div>
        <div style={rowStyle}>
          <label style={labelStyle}>校验</label>
          <input type="color" value={template.colorChecksum} onChange={e => onChange({ colorChecksum: e.target.value })} style={colorInputStyle} />
          <label style={labelStyle}>帧尾</label>
          <input type="color" value={template.colorFooter} onChange={e => onChange({ colorFooter: e.target.value })} style={colorInputStyle} />
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn btn-icon btn-sm" onClick={onDelete} title="删除模板">
          <Trash2 size={14} /> 删除
        </button>
      </div>
    </div>
  );
};

export default ProtocolTemplateEditor;
