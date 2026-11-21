/**
 * 审计日志组件
 */

import { ArrowRight } from "lucide-react";
import { useAuditLog } from '@/hooks/cc/useSettings';
import type { AuditEntry } from '@/types/cc/settings';
import { cn } from '@ggbdpq/console-ui';

interface AuditLogProps {
  limit?: number;
}

export function AuditLog({ limit = 10 }: AuditLogProps) {
  const { data: entries, isLoading, error } = useAuditLog(limit);

  if (isLoading) {
    return (
      <div className="p-4 text-center text-muted-foreground">
        加载审计日志...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-center text-destructive">
        加载审计日志失败: {String(error)}
      </div>
    );
  }

  if (!entries || entries.length === 0) {
    return (
      <div className="p-4 text-center text-muted-foreground">
        暂无审计记录
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {entries.map((entry: import("@/types/cc/settings").AuditEntry, index: number) => (
        <AuditEntryItem key={index} entry={entry} />
      ))}
    </div>
  );
}

interface AuditEntryItemProps {
  entry: AuditEntry;
}

function AuditEntryItem({ entry }: AuditEntryItemProps) {
  const actionLabels: Record<string, string> = {
    toggle_plugin: "切换插件",
    apply_preset: "应用预设",
    batch_update: "批量更新",
    restore_backup: "恢复备份",
    manual_write: "手动写入",
  };

  const actionColors: Record<string, string> = {
    toggle_plugin: "bg-info/15 text-info",
    apply_preset: "bg-success/15 text-success",
    batch_update: "bg-primary/15 text-primary",
    restore_backup: "bg-warning/15 text-warning",
    manual_write: "bg-muted text-muted-foreground",
  };

  const formatTime = (timestamp: string) => {
    try {
      const date = new Date(timestamp);
      return date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return timestamp;
    }
  };

  return (
    <div
      className={cn(
        "p-3 rounded-lg bg-card",
        "border border-border"
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <span
          className={cn(
            "text-xs px-2 py-0.5 rounded-full",
            actionColors[entry.action] || actionColors.manual_write
          )}
        >
          {actionLabels[entry.action] || entry.action}
        </span>
        <span className="text-xs text-muted-foreground">
          {formatTime(entry.timestamp)}
        </span>
      </div>

      {/* Hash 变更 */}
      <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
        <span className="truncate max-w-[80px]" title={entry.beforeHash || "未知"}>
          {entry.beforeHash ? `${entry.beforeHash.slice(0, 8)}...` : "未知"}
        </span>
        <ArrowRight className="size-3 shrink-0" />
        <span className="truncate max-w-[80px]" title={entry.afterHash || "未知"}>
          {entry.afterHash ? `${entry.afterHash.slice(0, 8)}...` : "未知"}
        </span>
      </div>

      {/* 变更的键 */}
      {entry.changedKeys && entry.changedKeys.length > 0 && (
        <div className="mt-2 text-xs text-muted-foreground">
          变更: {entry.changedKeys.slice(0, 3).join(", ")}
          {entry.changedKeys.length > 3 && ` +${entry.changedKeys.length - 3} 项`}
        </div>
      )}
    </div>
  );
}
