/**
 * 预设侧边栏组件
 * P1-07: 支持自定义预设 CRUD
 */

import { useState, useRef } from "react";
import {
  Plus,
  MoreVertical,
  Edit,
  Copy,
  Trash2,
  Download,
  Upload,
  Loader2,
} from "lucide-react";
import { cn } from '@ggbdpq/console-ui';
import { BUILTIN_PRESETS, type Preset } from '@/lib/cc/presets';
import { usePresetStore } from '@/stores/cc/presetStore';
import {
  useCustomPresets,
  useDeleteCustomPreset,
  useExportPresets,
  useImportPresets,
} from '@/hooks/cc/useSettings';
import type { CustomPreset } from '@/lib/cc/api';

interface PresetSidebarProps {
  onApplyPreset: (preset: Preset | CustomPreset) => void;
  onEditPreset?: (preset: CustomPreset, mode: "edit" | "duplicate") => void;
  onCreatePreset?: () => void;
  isApplying?: boolean;
}

export function PresetSidebar({
  onApplyPreset,
  onEditPreset,
  onCreatePreset,
  isApplying = false,
}: PresetSidebarProps) {
  const { activePresetId, setActivePreset } = usePresetStore();
  const { data: customPresets = [], isLoading } = useCustomPresets();
  const deletePreset = useDeleteCustomPreset();
  const exportPresets = useExportPresets();
  const importPresets = useImportPresets();

  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePresetClick = (preset: Preset | CustomPreset) => {
    setActivePreset(preset.id);
    onApplyPreset(preset);
  };

  const handleDelete = async (presetId: string) => {
    try {
      await deletePreset.mutateAsync(presetId);
      setMenuOpenId(null);
    } catch (error) {
      console.error("删除预设失败:", error);
    }
  };

  const handleExport = async () => {
    try {
      const json = await exportPresets.mutateAsync([]);
      // 创建下载
      const blob = new Blob([String(json)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `claude-profile-presets-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("导出预设失败:", error);
    }
  };

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      await importPresets.mutateAsync(text);
    } catch (error) {
      console.error("导入预设失败:", error);
    }

    // 重置 input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  // 转换 CustomPreset 到 Preset 格式用于显示
  const convertToPreset = (cp: CustomPreset): Preset => ({
    id: cp.id,
    name: cp.name,
    icon: cp.icon ?? "",
    description: cp.description ?? "",
    enabledPlugins: cp.enabledPlugins,
    builtin: false,
  });

  return (
    <div className="w-60 h-full bg-card border-r border-border flex flex-col">
      {/* 标题 */}
      <div className="flex items-center justify-between p-4 border-b border-border">
        <h2 className="font-semibold text-lg text-foreground">
          预设配置
        </h2>
        {onCreatePreset && (
          <button
            onClick={onCreatePreset}
            className="p-1.5 rounded-lg hover:bg-background transition-colors"
            title="新建预设"
          >
            <Plus className="size-5 text-muted-foreground" />
          </button>
        )}
      </div>

      {/* 内置预设 */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-3">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            内置预设
          </h3>
          <div className="space-y-1">
            {BUILTIN_PRESETS.map((preset) => (
              <PresetItem
                key={preset.id}
                preset={preset}
                active={activePresetId === preset.id}
                onClick={() => handlePresetClick(preset)}
                disabled={isApplying}
              />
            ))}
          </div>
        </div>

        {/* 自定义预设 */}
        <div className="p-3 border-t border-border">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            我的预设
          </h3>
          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : customPresets.length > 0 ? (
            <div className="space-y-1">
              {customPresets.map((cp: CustomPreset) => {
                const preset = convertToPreset(cp);
                return (
                  <PresetItemWithMenu
                    key={preset.id}
                    preset={preset}
                    active={activePresetId === preset.id}
                    onClick={() => handlePresetClick(cp)}
                    disabled={isApplying}
                    menuOpen={menuOpenId === preset.id}
                    onMenuToggle={() =>
                      setMenuOpenId(menuOpenId === preset.id ? null : preset.id)
                    }
                    onEdit={() => {
                      onEditPreset?.(cp, "edit");
                      setMenuOpenId(null);
                    }}
                    onDuplicate={() => {
                      onEditPreset?.(cp, "duplicate");
                      setMenuOpenId(null);
                    }}
                    onDelete={() => handleDelete(preset.id)}
                    isDeleting={deletePreset.isPending}
                  />
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground text-center py-4">
              暂无自定义预设
              <br />
              点击右上角 + 创建
            </p>
          )}
        </div>
      </div>

      {/* 底部操作 */}
      <div className="p-3 border-t border-border space-y-2">
        {/* 导入导出 */}
        <div className="flex gap-2">
          <button
            onClick={handleExport}
            disabled={customPresets.length === 0 || exportPresets.isPending}
            className={cn(
              "flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-xs",
              "bg-background hover:bg-popover",
              "text-muted-foreground transition-colors",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            {exportPresets.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Download className="size-3" />
            )}
            导出
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importPresets.isPending}
            className={cn(
              "flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-xs",
              "bg-background hover:bg-popover",
              "text-muted-foreground transition-colors",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            {importPresets.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Upload className="size-3" />
            )}
            导入
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleImport}
            className="hidden"
          />
        </div>

        {/* 状态指示 */}
        <div className="text-xs text-muted-foreground">
          {activePresetId ? (
            <span>
              当前预设:{" "}
              <span className="font-medium text-foreground">
                {BUILTIN_PRESETS.find((p) => p.id === activePresetId)?.name ||
                  customPresets.find((p: CustomPreset) => p.id === activePresetId)?.name ||
                  "自定义"}
              </span>
            </span>
          ) : (
            <span>未选择预设</span>
          )}
        </div>
      </div>
    </div>
  );
}

interface PresetItemProps {
  preset: Preset;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}

function PresetItem({ preset, active, onClick, disabled }: PresetItemProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "hover:bg-background",
        disabled && "opacity-50 cursor-not-allowed"
      )}
    >
      <span className="text-lg">{preset.icon}</span>
      <div className="flex-1 min-w-0">
        <div
          className={cn(
            "font-medium truncate",
            active ? "text-accent-foreground" : "text-foreground"
          )}
        >
          {preset.name}
        </div>
        <div
          className={cn(
            "text-xs truncate",
            active ? "text-accent-foreground/80" : "text-muted-foreground"
          )}
        >
          {preset.description}
        </div>
      </div>
    </button>
  );
}

interface PresetItemWithMenuProps extends PresetItemProps {
  menuOpen: boolean;
  onMenuToggle: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  isDeleting: boolean;
}

function PresetItemWithMenu({
  preset,
  active,
  onClick,
  disabled,
  menuOpen,
  onMenuToggle,
  onEdit,
  onDuplicate,
  onDelete,
  isDeleting,
}: PresetItemWithMenuProps) {
  return (
    <div className="relative group">
      <button
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors",
          active
            ? "bg-accent text-accent-foreground"
            : "hover:bg-background",
          disabled && "opacity-50 cursor-not-allowed"
        )}
      >
        <span className="text-lg">{preset.icon}</span>
        <div className="flex-1 min-w-0">
          <div
            className={cn(
              "font-medium truncate",
              active ? "text-accent-foreground" : "text-foreground"
            )}
          >
            {preset.name}
          </div>
          <div
            className={cn(
              "text-xs truncate",
              active ? "text-accent-foreground/80" : "text-muted-foreground"
            )}
          >
            {preset.description}
          </div>
        </div>
      </button>

      {/* 菜单按钮 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onMenuToggle();
        }}
        className={cn(
          "absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded",
          "opacity-0 group-hover:opacity-100 transition-opacity",
          active
            ? "hover:bg-accent-foreground/10 text-accent-foreground"
            : "hover:bg-card text-muted-foreground"
        )}
      >
        <MoreVertical className="size-4" />
      </button>

      {/* 下拉菜单 */}
      {menuOpen && (
        <>
          {/* 点击外部关闭 */}
          <div
            className="fixed inset-0 z-10"
            onClick={(e) => {
              e.stopPropagation();
              onMenuToggle();
            }}
          />
          <div
            className={cn(
              "absolute right-0 top-full mt-1 z-20",
              "bg-popover rounded-lg shadow-lg",
              "border border-border",
              "py-1 min-w-[120px]"
            )}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-foreground hover:bg-card"
            >
              <Edit className="size-4" />
              编辑
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDuplicate();
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-foreground hover:bg-card"
            >
              <Copy className="size-4" />
              复制
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              disabled={isDeleting}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
            >
              {isDeleting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              删除
            </button>
          </div>
        </>
      )}
    </div>
  );
}
