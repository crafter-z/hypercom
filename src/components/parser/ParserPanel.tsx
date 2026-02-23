import { useState, useEffect } from 'react';
import { Plus, Play, Trash2, Edit2, Check } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { Protocol } from '../../types/parser';

interface ParserPanelProps {
  onEditProtocol: (protocol: Protocol | null) => void;
  editingProtocol: Protocol | null;
}

export function ParserPanel({ onEditProtocol, editingProtocol }: ParserPanelProps) {
  const [protocols, setProtocols] = useState<Protocol[]>([]);
  const [activeProtocolId, setActiveProtocolId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 加载协议列表
  useEffect(() => {
    loadProtocols();
  }, []);

  const loadProtocols = async () => {
    setLoading(true);
    try {
      const list = await invoke<Protocol[]>('list_protocols');
      setProtocols(list);
    } catch (error) {
      console.error('Failed to load protocols:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateProtocol = () => {
    onEditProtocol(null);
  };

  const handleEditProtocol = (protocol: Protocol) => {
    onEditProtocol(protocol);
  };

  const handleDeleteProtocol = async (id: string) => {
    try {
      await invoke('delete_protocol', { id });
      setProtocols(protocols.filter((p) => p.id !== id));
      if (activeProtocolId === id) {
        setActiveProtocolId(null);
        await invoke('set_active_protocol', { id: null });
      }
    } catch (error) {
      console.error('Failed to delete protocol:', error);
    }
  };

  const handleSetActive = async (id: string) => {
    try {
      if (activeProtocolId === id) {
        await invoke('set_active_protocol', { id: null });
        setActiveProtocolId(null);
      } else {
        await invoke('set_active_protocol', { id });
        setActiveProtocolId(id);
      }
    } catch (error) {
      console.error('Failed to set active protocol:', error);
    }
  };

  const handleSaveProtocol = async (protocol: Protocol) => {
    try {
      await invoke('save_protocol', { protocol });
      await loadProtocols();
      onEditProtocol(null);
    } catch (error) {
      console.error('Failed to save protocol:', error);
    }
  };

  if (editingProtocol) {
    return (
      <div className="p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">
            {editingProtocol.id ? '编辑协议' : '新建协议'}
          </h3>
          <button
            onClick={() => onEditProtocol(null)}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            取消
          </button>
        </div>
        
        {/* 协议编辑器会在这里渲染，暂时简化 */}
        <div className="space-y-4">
          <div>
            <label className="text-xs text-muted-foreground">协议名称</label>
            <input
              type="text"
              value={editingProtocol.name}
              onChange={(e) =>
                onEditProtocol({ ...editingProtocol, name: e.target.value })
              }
              className="w-full mt-1 px-3 py-2 rounded-lg border bg-background"
              placeholder="输入协议名称..."
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground">描述</label>
            <textarea
              value={editingProtocol.description || ''}
              onChange={(e) =>
                onEditProtocol({ ...editingProtocol, description: e.target.value })
              }
              className="w-full mt-1 px-3 py-2 rounded-lg border bg-background resize-none"
              rows={2}
              placeholder="协议描述..."
            />
          </div>

          <button
            onClick={() => handleSaveProtocol(editingProtocol)}
            disabled={!editingProtocol.name.trim()}
            className="w-full py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            保存协议
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center justify-between p-3 border-b">
        <h3 className="font-semibold text-sm">协议解析器</h3>
        <button
          onClick={handleCreateProtocol}
          className="p-1.5 rounded hover:bg-accent transition-colors"
          title="新建协议"
        >
          <Plus size={16} />
        </button>
      </div>

      {/* 协议列表 */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" />
          </div>
        ) : protocols.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
            <p className="text-sm">暂无协议</p>
            <button
              onClick={handleCreateProtocol}
              className="mt-2 flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <Plus size={12} />
              创建第一个协议
            </button>
          </div>
        ) : (
          <div className="divide-y">
            {protocols.map((protocol) => (
              <div
                key={protocol.id}
                className={`group flex items-center gap-2 p-3 hover:bg-accent/50 transition-colors ${
                  activeProtocolId === protocol.id ? 'bg-primary/10' : ''
                }`}
              >
                {/* 激活状态 */}
                <button
                  onClick={() => handleSetActive(protocol.id)}
                  className={`w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors ${
                    activeProtocolId === protocol.id
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-muted-foreground'
                  }`}
                  title={activeProtocolId === protocol.id ? '已激活' : '点击激活'}
                >
                  {activeProtocolId === protocol.id && <Check size={10} />}
                </button>

                {/* 协议名称 */}
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">{protocol.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {protocol.fields.length} 个字段
                  </div>
                </div>

                {/* 操作按钮 */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleEditProtocol(protocol)}
                    className="p-1.5 rounded hover:bg-secondary"
                    title="编辑"
                  >
                    <Edit2 size={14} />
                  </button>
                  <button
                    onClick={() => handleDeleteProtocol(protocol.id)}
                    className="p-1.5 rounded hover:bg-destructive/10 hover:text-destructive"
                    title="删除"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 激活状态提示 */}
      {activeProtocolId && (
        <div className="p-3 border-t bg-primary/5">
          <div className="text-xs text-muted-foreground">
            当前激活: {protocols.find((p) => p.id === activeProtocolId)?.name}
          </div>
        </div>
      )}
    </div>
  );
}
