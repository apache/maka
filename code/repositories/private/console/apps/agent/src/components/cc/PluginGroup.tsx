/**
 * 插件分组组件
 */

import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from '@ggbdpq/console-ui';

interface PluginGroupProps {
  title: string;
  count: { enabled: number; total: number };
  expanded: boolean;
  onToggleExpand: () => void;
  children: React.ReactNode;
}

export function PluginGroup({
  title,
  count,
  expanded,
  onToggleExpand,
  children,
}: PluginGroupProps) {
  return (
    <div className="mb-4">
      {/* 分组标题 */}
      <button
        onClick={onToggleExpand}
        className={cn(
          "flex items-center justify-between w-full py-2 px-3 rounded-lg",
          "hover:bg-card transition-colors",
          "text-left"
        )}
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="size-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 text-muted-foreground" />
          )}
          <span className="font-semibold text-foreground">
            {title}
          </span>
        </div>
        <span className="text-sm text-muted-foreground">
          {count.enabled} / {count.total} 启用
        </span>
      </button>

      {/* 插件列表 */}
      {expanded && (
        <div className="mt-1 ml-6 border-l-2 border-border pl-4">
          {children}
        </div>
      )}
    </div>
  );
}
