/**
 * 预设差异预览对话框
 * P1-06: 预设应用前显示 diff，确认后才写入
 */

import { useState, useMemo } from "react";
import { X, AlertCircle, CheckCircle, MinusCircle, Loader2 } from "lucide-react";
import { cn } from '@ggbdpq/console-ui';
import type { Preset } from '@/lib/cc/presets';
import type { CustomPreset } from '@/lib/cc/api';

interface PresetDiffDialogProps {
  isOpen: boolean;
  preset: Preset | CustomPreset | null;
  currentPlugins: Record<string, boolean>;
  onClose: () => void;
  onApply: () => Promise<void>;
  isApplying: boolean;
  error?: string | null;
}

interface DiffItem {
  pluginId: string;
  current: boolean | undefined;
  target: boolean;
  change: "add" | "remove" | "enable" | "disable" | "unchanged";
}

export function PresetDiffDialog({
  isOpen,
  preset,
  currentPlugins,
  onClose,
  onApply,
  isApplying,
  error,
}: PresetDiffDialogProps) {
  const [applyError, setApplyError] = useState<string | null>(null);

  // 计算差异
  const diffItems = useMemo<DiffItem[]>(() => {
    if (!preset) return [];

    const items: DiffItem[] = [];

    // 遍历预设中的插件
    for (const [pluginId, targetEnabled] of Object.entries(preset.enabledPlugins)) {
      const currentEnabled = currentPlugins[pluginId];

      let change: DiffItem["change"];
      if (currentEnabled === undefined) {
        // 当前配置中不存在该插件
        change = targetEnabled ? "add" : "unchanged";
      } else if (currentEnabled === targetEnabled) {
        change = "unchanged";
      } else {
        change = targetEnabled ? "enable" : "disable";
      }

      items.push({
        pluginId,
        current: currentEnabled,
        target: targetEnabled,
        change,
      });
    }

    // 按变更类型排序：变更的在前，未变的在后
    return items.sort((a, b) => {
      const priority = { add: 0, enable: 1, disable: 2, remove: 3, unchanged: 4 };
      return priority[a.change] - priority[b.change];
    });
  }, [preset, currentPlugins]);

  // 统计变更数量
  const changeStats = useMemo(() => {
    const stats = { add: 0, enable: 0, disable: 0, unchanged: 0 };
    for (const item of diffItems) {
      if (item.change === "add") stats.add++;
      else if (item.change === "enable") stats.enable++;
      else if (item.change === "disable") stats.disable++;
      else stats.unchanged++;
    }
    return stats;
  }, [diffItems]);

  const hasChanges = changeStats.add + changeStats.enable + changeStats.disable > 0;

  const handleApply = async () => {
    setApplyError(null);
    try {
      await onApply();
    } catch (err) {
      setApplyError(String(err));
    }
  };

  if (!isOpen || !preset) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 背景遮罩 */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* 对话框 */}
      <div
        className={cn(
          "relative w-full max-w-lg mx-4",
          "bg-popover rounded-xl shadow-2xl",
          "overflow-hidden"
        )}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{preset.icon}</span>
            <div>
              <h2 className="font-semibold text-foreground">
                应用预设: {preset.name}
              </h2>
              <p className="text-sm text-muted-foreground">
                {preset.description}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-card transition-colors"
            disabled={isApplying}
          >
            <X className="size-5 text-muted-foreground" />
          </button>
        </div>

        {/* 变更统计 */}
        <div className="px-5 py-3 bg-card/50 border-b border-border">
          <div className="flex items-center gap-4 text-sm">
            {changeStats.add > 0 && (
              <span className="flex items-center gap-1 text-success">
                <CheckCircle className="size-4" />
                新增 {changeStats.add}
              </span>
            )}
            {changeStats.enable > 0 && (
              <span className="flex items-center gap-1 text-accent">
                <CheckCircle className="size-4" />
                启用 {changeStats.enable}
              </span>
            )}
            {changeStats.disable > 0 && (
              <span className="flex items-center gap-1 text-warning">
                <MinusCircle className="size-4" />
                禁用 {changeStats.disable}
              </span>
            )}
            {!hasChanges && (
              <span className="text-muted-foreground">
                配置已与预设一致，无需变更
              </span>
            )}
          </div>
        </div>

        {/* 差异列表 */}
        <div className="max-h-[300px] overflow-y-auto p-5">
          {diffItems.length === 0 ? (
            <p className="text-center text-muted-foreground">
              该预设没有配置任何插件
            </p>
          ) : (
            <div className="space-y-2">
              {diffItems.map((item) => (
                <DiffItemRow key={item.pluginId} item={item} />
              ))}
            </div>
          )}
        </div>

        {/* 错误提示 */}
        {(error || applyError) && (
          <div className="px-5 py-3 bg-destructive/10 border-t border-destructive/20">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="size-4 flex-shrink-0" />
              <span className="text-sm">{error || applyError}</span>
            </div>
          </div>
        )}

        {/* 底部操作区 */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border">
          <button
            onClick={onClose}
            className="btn-secondary"
            disabled={isApplying}
          >
            取消
          </button>
          <button
            onClick={handleApply}
            className="btn-primary flex items-center gap-2"
            disabled={isApplying || !hasChanges}
          >
            {isApplying ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                应用中...
              </>
            ) : (
              <>
                <CheckCircle className="size-4" />
                确认应用
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

interface DiffItemRowProps {
  item: DiffItem;
}

function DiffItemRow({ item }: DiffItemRowProps) {
  const getChangeStyle = () => {
    switch (item.change) {
      case "add":
        return "bg-success/10 border-success/30";
      case "enable":
        return "bg-accent/10 border-accent/30";
      case "disable":
        return "bg-warning/10 border-warning/30";
      default:
        return "bg-card border-transparent";
    }
  };

  const getChangeIcon = () => {
    switch (item.change) {
      case "add":
        return <CheckCircle className="size-4 text-success" />;
      case "enable":
        return <CheckCircle className="size-4 text-accent" />;
      case "disable":
        return <MinusCircle className="size-4 text-warning" />;
      default:
        return <span className="size-4" />;
    }
  };

  const getChangeLabel = () => {
    switch (item.change) {
      case "add":
        return "新增并启用";
      case "enable":
        return "将启用";
      case "disable":
        return "将禁用";
      default:
        return "保持不变";
    }
  };

  // 提取插件名称
  const pluginName = item.pluginId.split("@")[0];

  return (
    <div
      className={cn(
        "flex items-center justify-between px-3 py-2 rounded-lg border",
        getChangeStyle()
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        {getChangeIcon()}
        <span
          className={cn(
            "font-mono text-sm truncate",
            item.change === "unchanged"
              ? "text-muted-foreground"
              : "text-foreground"
          )}
          title={item.pluginId}
        >
          {pluginName}
        </span>
      </div>
      <span
        className={cn(
          "text-xs flex-shrink-0 ml-2",
          item.change === "unchanged"
            ? "text-muted-foreground"
            : "text-foreground"
        )}
      >
        {getChangeLabel()}
      </span>
    </div>
  );
}
