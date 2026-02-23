import { useState } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import type { Protocol, ProtocolField, FieldType } from '../../types/parser';
import { FIELD_TYPE_OPTIONS, createEmptyField } from '../../types/parser';

interface ProtocolEditorProps {
  protocol: Protocol;
  onSave: (protocol: Protocol) => void;
  onCancel: () => void;
}

export function ProtocolEditor({ protocol, onSave, onCancel }: ProtocolEditorProps) {
  const [editingProtocol, setEditingProtocol] = useState<Protocol>(protocol);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const updateProtocol = (updates: Partial<Protocol>) => {
    setEditingProtocol({ ...editingProtocol, ...updates });
  };

  const addField = () => {
    const newField = createEmptyField();
    // 自动计算偏移量
    const lastField = editingProtocol.fields[editingProtocol.fields.length - 1];
    if (lastField) {
      const lastSize = FIELD_TYPE_OPTIONS.find((o) => o.value === lastField.fieldType)?.size || 1;
      newField.offset = lastField.offset + lastSize;
    }
    updateProtocol({ fields: [...editingProtocol.fields, newField] });
  };

  const updateField = (index: number, updates: Partial<ProtocolField>) => {
    const newFields = [...editingProtocol.fields];
    newFields[index] = { ...newFields[index], ...updates };
    updateProtocol({ fields: newFields });
  };

  const removeField = (index: number) => {
    updateProtocol({
      fields: editingProtocol.fields.filter((_, i) => i !== index),
    });
  };

  const moveField = (index: number, direction: 'up' | 'down') => {
    const newFields = [...editingProtocol.fields];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= newFields.length) return;
    [newFields[index], newFields[targetIndex]] = [newFields[targetIndex], newFields[index]];
    updateProtocol({ fields: newFields });
  };

  const parseHexInput = (value: string): number[] | undefined => {
    if (!value.trim()) return undefined;
    const bytes = value.trim().split(/\s+/).map((b) => parseInt(b, 16));
    if (bytes.some((b) => isNaN(b) || b < 0 || b > 255)) {
      return undefined;
    }
    return bytes;
  };

  const formatHexOutput = (bytes?: number[]): string => {
    if (!bytes || bytes.length === 0) return '';
    return bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  };

  const handleSave = () => {
    const now = Date.now();
    onSave({
      ...editingProtocol,
      id: editingProtocol.id || crypto.randomUUID(),
      createdAt: editingProtocol.createdAt || now,
      updatedAt: now,
    });
  };

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center justify-between p-4 border-b">
        <h3 className="font-semibold">
          {protocol.id ? '编辑协议' : '新建协议'}
        </h3>
        <button
          onClick={onCancel}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          取消
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* 基本信息 */}
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">协议名称 *</label>
            <input
              type="text"
              value={editingProtocol.name}
              onChange={(e) => updateProtocol({ name: e.target.value })}
              className="w-full mt-1 px-3 py-2 rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
              placeholder="例如：Modbus RTU"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground">描述</label>
            <textarea
              value={editingProtocol.description || ''}
              onChange={(e) => updateProtocol({ description: e.target.value })}
              className="w-full mt-1 px-3 py-2 rounded-lg border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
              rows={2}
              placeholder="协议描述..."
            />
          </div>
        </div>

        {/* 高级设置 */}
        <div>
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            高级设置
          </button>

          {showAdvanced && (
            <div className="mt-3 space-y-3 p-3 rounded-lg border bg-muted/30">
              <div>
                <label className="text-xs text-muted-foreground">帧头 (Hex)</label>
                <input
                  type="text"
                  value={formatHexOutput(editingProtocol.header)}
                  onChange={(e) =>
                    updateProtocol({ header: parseHexInput(e.target.value) })
                  }
                  className="w-full mt-1 px-3 py-2 rounded-lg border bg-background font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="例如：01 03"
                />
              </div>

              <div>
                <label className="text-xs text-muted-foreground">帧尾 (Hex)</label>
                <input
                  type="text"
                  value={formatHexOutput(editingProtocol.footer)}
                  onChange={(e) =>
                    updateProtocol({ footer: parseHexInput(e.target.value) })
                  }
                  className="w-full mt-1 px-3 py-2 rounded-lg border bg-background font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="例如：0D 0A"
                />
              </div>

              <div>
                <label className="text-xs text-muted-foreground">校验方式</label>
                <select
                  value={editingProtocol.checksum || 'none'}
                  onChange={(e) =>
                    updateProtocol({
                      checksum: e.target.value === 'none' ? undefined : (e.target.value as any),
                    })
                  }
                  className="w-full mt-1 px-3 py-2 rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
                >
                  <option value="none">无校验</option>
                  <option value="sum8">SUM8</option>
                  <option value="sum16">SUM16</option>
                  <option value="xor8">XOR8</option>
                  <option value="crc8">CRC8</option>
                  <option value="crc16">CRC16</option>
                  <option value="crc32">CRC32</option>
                </select>
              </div>
            </div>
          )}
        </div>

        {/* 字段列表 */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-muted-foreground">字段定义</label>
            <button
              onClick={addField}
              className="flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <Plus size={12} />
              添加字段
            </button>
          </div>

          {editingProtocol.fields.length === 0 ? (
            <div className="text-center py-4 text-muted-foreground text-sm border rounded-lg">
              暂无字段，点击上方按钮添加
            </div>
          ) : (
            <div className="space-y-2">
              {editingProtocol.fields.map((field, index) => (
                <div
                  key={index}
                  className="p-3 rounded-lg border bg-muted/30 space-y-2"
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={field.name}
                      onChange={(e) => updateField(index, { name: e.target.value })}
                      className="flex-1 px-2 py-1 rounded border bg-background text-sm"
                      placeholder="字段名称"
                    />
                    <select
                      value={field.fieldType}
                      onChange={(e) => updateField(index, { fieldType: e.target.value as FieldType })}
                      className="px-2 py-1 rounded border bg-background text-sm"
                    >
                      {FIELD_TYPE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => removeField(index)}
                      className="p-1 rounded hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1">
                      <label className="text-xs text-muted-foreground">偏移:</label>
                      <input
                        type="number"
                        value={field.offset}
                        onChange={(e) => updateField(index, { offset: Number(e.target.value) })}
                        className="w-16 px-2 py-1 rounded border bg-background text-sm"
                        min={0}
                      />
                    </div>

                    {!FIELD_TYPE_OPTIONS.find((o) => o.value === field.fieldType)?.size && (
                      <div className="flex items-center gap-1">
                        <label className="text-xs text-muted-foreground">长度:</label>
                        <input
                          type="number"
                          value={field.length || 1}
                          onChange={(e) => updateField(index, { length: Number(e.target.value) })}
                          className="w-16 px-2 py-1 rounded border bg-background text-sm"
                          min={1}
                        />
                      </div>
                    )}

                    <div className="flex items-center gap-1">
                      <label className="text-xs text-muted-foreground">字节序:</label>
                      <select
                        value={field.byteOrder}
                        onChange={(e) => updateField(index, { byteOrder: e.target.value as any })}
                        className="px-2 py-1 rounded border bg-background text-sm"
                      >
                        <option value="bigEndian">大端</option>
                        <option value="littleEndian">小端</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={field.description || ''}
                      onChange={(e) => updateField(index, { description: e.target.value })}
                      className="flex-1 px-2 py-1 rounded border bg-background text-sm"
                      placeholder="字段描述（可选）"
                    />
                    <label className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={field.visible}
                        onChange={(e) => updateField(index, { visible: e.target.checked })}
                        className="accent-primary"
                      />
                      显示
                    </label>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 底部 */}
      <div className="flex gap-2 p-4 border-t">
        <button
          onClick={onCancel}
          className="flex-1 py-2 rounded-lg border hover:bg-accent transition-colors"
        >
          取消
        </button>
        <button
          onClick={handleSave}
          disabled={!editingProtocol.name.trim()}
          className="flex-1 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          保存
        </button>
      </div>
    </div>
  );
}
