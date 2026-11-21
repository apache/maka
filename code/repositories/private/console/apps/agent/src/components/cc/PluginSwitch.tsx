/**
 * 插件开关组件
 */

import { ChevronRight } from "lucide-react";
import { Switch } from './Switch';
import { parsePluginId, getPluginSource } from '@/types/cc/settings';
import { getCatalogEntry } from '@/data/cc/pluginCatalog';
import { cn } from '@ggbdpq/console-ui';

interface PluginSwitchProps {
  pluginId: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  isPending?: boolean;
  /** 点击插件行进入详情页 */
  onViewDetail?: () => void;
}

export function PluginSwitch({
  pluginId,
  enabled,
  onToggle,
  isPending = false,
  onViewDetail,
}: PluginSwitchProps) {
  const { name, source } = parsePluginId(pluginId);
  const sourceType = getPluginSource(pluginId);

  // 从 catalog 获取摘要
  const catalogEntry = getCatalogEntry(pluginId);
  const summary = catalogEntry?.problem || "暂无简介";

  // 格式化显示名称（将 kebab-case 转为可读形式）
  const displayName = name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

  // 获取来源标签颜色
  const sourceBadgeClass =
    sourceType === "official"
      ? "bg-info/15 text-info"
      : sourceType === "third-party"
      ? "bg-primary/15 text-primary"
      : "bg-muted text-muted-foreground";

  // 点击行进入详情（排除开关区域）
  const handleRowClick = (e: React.MouseEvent) => {
    // 如果点击的是开关或其子元素，不触发详情
    const target = e.target as HTMLElement;
    if (target.closest('[data-switch-area]')) {
      return;
    }
    onViewDetail?.();
  };

  return (
    <div
      className={cn(
        "flex items-center justify-between py-3 px-2 rounded-lg transition-colors",
        "hover:bg-card",
        isPending && "opacity-70",
        onViewDetail && "cursor-pointer"
      )}
      onClick={handleRowClick}
    >
      {/* 左侧：开关 + 名称 + 来源 */}
      <div className="flex shrink-0 items-center gap-3" data-switch-area>
        <Switch
          checked={enabled}
          onCheckedChange={onToggle}
          disabled={isPending}
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground truncate">
              {displayName}
            </span>
            {isPending && (
              <span className="text-xs text-warning">
                保存中...
              </span>
            )}
          </div>
          <span
            className={cn(
              "inline-block mt-1 text-xs px-2 py-0.5 rounded-full",
              sourceBadgeClass
            )}
          >
            {source}
          </span>
        </div>
      </div>

      {/* 右侧：摘要 + 进入详情箭头 */}
      <div className="ml-4 flex min-w-0 flex-1 items-center gap-2">
        <p
          className="flex-1 text-sm text-muted-foreground line-clamp-2 text-right"
          title={summary}
        >
          {summary}
        </p>
        {onViewDetail && (
          <ChevronRight className="size-4 text-muted-foreground/75 shrink-0" />
        )}
      </div>
    </div>
  );
}
