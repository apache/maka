/**
 * 预设编辑对话框
 * P1-07: 自定义预设 CRUD
 */

import { useState, useEffect } from "react";
import { X, Save, Loader2, Trash2, Copy, Plus, Minus } from "lucide-react";
import { cn } from '@ggbdpq/console-ui';
import type { CustomPreset } from '@/lib/cc/api';
import type { Preset } from '@/lib/cc/presets';

// 常用 emoji 选择器
const PRESET_ICONS = ["🎯", "⚡", "🔧", "📦", "🚀", "💻", "🎨", "📚", "🔍", "⭐", "🔥", "💡"];

interface PresetEditorProps {
  isOpen: boolean;
  mode: "create" | "edit" | "duplicate";
  preset?: Preset | CustomPreset | null;
  currentPlugins: Record<string, boolean>;
  onClose: () => void;
  onSave: (preset: Omit<CustomPreset, "createdAt" | "updatedAt">) => Promise<void>;
  onDelete?: (presetId: string) => Promise<void>;
  isSaving: boolean;
  isDeleting?: boolean;
}

export function PresetEditor({
  isOpen,
  mode,
  preset,
  currentPlugins,
  onClose,
  onSave,
  onDelete,
  isSaving,
  isDeleting,
}: PresetEditorProps) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("🎯");
  const [description, setDescription] = useState("");
  const [enabledPlugins, setEnabledPlugins] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // 初始化表单
  useEffect(() => {
    if (isOpen) {
      if (mode === "create") {
        // 新建：使用当前插件配置
        setName("");
        setIcon("🎯");
        setDescription("");
        setEnabledPlugins({ ...currentPlugins });
      } else if (preset) {
        // 编辑或复制
        const plugins = "enabledPlugins" in preset 
          ? preset.enabledPlugins 
          : {};
        
        setName(mode === "duplicate" ? `${preset.name} (副本)` : preset.name);
        setIcon(preset.icon ?? "");
        setDescription(preset.description ?? "");
        setEnabledPlugins({ ...plugins });
      }
      setError(null);
      setShowDeleteConfirm(false);
    }
  }, [isOpen, mode, preset, currentPlugins]);

  const handleSubmit = async () => {
    // 验证
    if (!name.trim()) {
      setError("请输入预设名称");
      return;
    }

    const presetData: Omit<CustomPreset, "createdAt" | "updatedAt"> = {
      id: mode === "edit" && preset && "id" in preset ? preset.id : `custom-${Date.now()}`,
      name: name.trim(),
      icon,
      description: description.trim(),
      enabledPlugins,
    };

    try {
      await onSave(presetData);
      onClose();
    } catch (err) {
      setError(String(err));
    }
  };

  const handleDelete = async () => {
    if (!preset || !("id" in preset) || !onDelete) return;
    
    try {
      await onDelete(preset.id);
      onClose();
    } catch (err) {
      setError(String(err));
    }
  };

  const togglePlugin = (pluginId: string) => {
    setEnabledPlugins((prev) => ({
      ...prev,
      [pluginId]: !prev[pluginId],
    }));
  };

  const addAllCurrentPlugins = () => {
    setEnabledPlugins({ ...currentPlugins });
  };

  const clearAllPlugins = () => {
    setEnabledPlugins(
      Object.fromEntries(Object.keys(enabledPlugins).map((k) => [k, false]))
    );
  };

  if (!isOpen) return null;

  const title = {
    create: "新建预设",
    edit: "编辑预设",
    duplicate: "复制预设",
  }[mode];

  const enabledCount = Object.values(enabledPlugins).filter(Boolean).length;
  const totalCount = Object.keys(enabledPlugins).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 背景遮罩 */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* 遮罩纯黑压暗是 overlay 惯例（ui/dialog 同款），非品牌色板 */}

      {/* 对话框 */}
      <div
        className={cn(
          "relative w-full max-w-lg mx-4",
          "bg-popover rounded-xl shadow-2xl",
          "overflow-hidden max-h-[85vh] flex flex-col"
        )}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="font-semibold text-lg text-foreground">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-card transition-colors"
            disabled={isSaving || isDeleting}
          >
            <X className="size-5 text-muted-foreground" />
          </button>
        </div>

        {/* 表单 */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* 图标选择 */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              图标
            </label>
            <div className="flex flex-wrap gap-2">
              {PRESET_ICONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => setIcon(emoji)}
                  className={cn(
                    "size-10 text-xl rounded-lg transition-all",
                    icon === emoji
                      ? "bg-accent shadow-lg scale-110"
                      : "bg-card hover:bg-background"
                  )}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>

          {/* 名称 */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              名称
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="输入预设名称"
              className={cn(
                "w-full px-3 py-2 rounded-lg",
                "bg-card border border-border",
                "text-foreground placeholder:text-muted-foreground",
                "focus:outline-none focus:ring-2 focus:ring-accent"
              )}
            />
          </div>

          {/* 描述 */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              描述
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="简短描述这个预设的用途"
              className={cn(
                "w-full px-3 py-2 rounded-lg",
                "bg-card border border-border",
                "text-foreground placeholder:text-muted-foreground",
                "focus:outline-none focus:ring-2 focus:ring-accent"
              )}
            />
          </div>

          {/* 插件配置 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-foreground">
                插件配置 ({enabledCount}/{totalCount} 启用)
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={addAllCurrentPlugins}
                  className="text-xs px-2 py-1 rounded bg-card hover:bg-accent hover:text-accent-foreground transition-colors"
                  title="使用当前配置"
                >
                  <Plus className="size-3 inline mr-1" />
                  当前配置
                </button>
                <button
                  type="button"
                  onClick={clearAllPlugins}
                  className="text-xs px-2 py-1 rounded bg-card hover:bg-destructive hover:text-destructive-foreground transition-colors"
                  title="全部禁用"
                >
                  <Minus className="size-3 inline mr-1" />
                  清空
                </button>
              </div>
            </div>
            <div className="max-h-[200px] overflow-y-auto space-y-1 p-2 rounded-lg bg-card">
              {Object.entries(enabledPlugins)
                .sort(([, a], [, b]) => (a === b ? 0 : a ? -1 : 1))
                .map(([pluginId, enabled]) => {
                  const pluginName = pluginId.split("@")[0];
                  return (
                    <label
                      key={pluginId}
                      className={cn(
                        "flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors",
                        "hover:bg-background"
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={() => togglePlugin(pluginId)}
                        className="size-4 rounded border-border text-accent focus:ring-accent"
                      />
                      <span
                        className={cn(
                          "text-sm font-mono truncate",
                          enabled
                            ? "text-foreground"
                            : "text-muted-foreground"
                        )}
                        title={pluginId}
                      >
                        {pluginName}
                      </span>
                    </label>
                  );
                })}
              {Object.keys(enabledPlugins).length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  点击"当前配置"按钮导入现有插件
                </p>
              )}
            </div>
          </div>
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="px-5 py-3 bg-destructive/10 border-t border-destructive/20">
            <span className="text-sm text-destructive">{error}</span>
          </div>
        )}

        {/* 删除确认 */}
        {showDeleteConfirm && (
          <div className="px-5 py-3 bg-destructive/10 border-t border-destructive/20">
            <div className="flex items-center justify-between">
              <span className="text-sm text-destructive">
                确定要删除这个预设吗？此操作不可撤销。
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="text-xs px-3 py-1 rounded bg-card"
                >
                  取消
                </button>
                <button
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="text-xs px-3 py-1 rounded bg-destructive text-destructive-foreground"
                >
                  {isDeleting ? "删除中..." : "确认删除"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 底部操作区 */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-border">
          <div>
            {mode === "edit" && onDelete && !showDeleteConfirm && (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="flex items-center gap-1 text-sm text-destructive hover:underline"
                disabled={isSaving || isDeleting}
              >
                <Trash2 className="size-4" />
                删除预设
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="btn-secondary"
              disabled={isSaving || isDeleting}
            >
              取消
            </button>
            <button
              onClick={handleSubmit}
              className="btn-primary flex items-center gap-2"
              disabled={isSaving || isDeleting}
            >
              {isSaving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  保存中...
                </>
              ) : (
                <>
                  {mode === "duplicate" ? (
                    <Copy className="size-4" />
                  ) : (
                    <Save className="size-4" />
                  )}
                  保存
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
