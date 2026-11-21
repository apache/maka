/**
 * 历史时间线与回滚组件
 * P1-09: 历史回滚 UI
 */

import { useState } from "react";
import {
  Clock,
  RotateCcw,
  AlertCircle,
  CheckCircle,
  Loader2,
  X,
  FileText,
  RefreshCw,
} from "lucide-react";
import { cn } from '@ggbdpq/console-ui';
import { useBackups, useRestoreBackup } from '@/hooks/cc/useSettings';
import type { BackupInfo } from '@/types/cc/settings';

interface HistoryTimelineProps {
  onRestoreComplete?: () => void;
}

export function HistoryTimeline({ onRestoreComplete }: HistoryTimelineProps) {
  const { data: backups = [], isLoading, error, refetch } = useBackups();
  const restoreBackup = useRestoreBackup();

  const [selectedBackup, setSelectedBackup] = useState<BackupInfo | null>(null);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const handleRestoreClick = (backup: BackupInfo) => {
    setSelectedBackup(backup);
    setRestoreError(null);
    setShowConfirmDialog(true);
  };

  const handleConfirmRestore = async () => {
    if (!selectedBackup) return;

    try {
      await restoreBackup.mutateAsync(selectedBackup.path);
      setShowConfirmDialog(false);
      setSelectedBackup(null);
      onRestoreComplete?.();
    } catch (err) {
      setRestoreError(String(err));
    }
  };

  const handleCloseDialog = () => {
    setShowConfirmDialog(false);
    setSelectedBackup(null);
    setRestoreError(null);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">加载历史记录...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20">
        <div className="flex items-center gap-2 text-destructive">
          <AlertCircle className="size-5" />
          <span>加载历史记录失败: {String(error)}</span>
        </div>
        <button
          onClick={() => refetch()}
          className="mt-2 text-sm text-accent hover:underline"
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* 标题 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Clock className="size-5 text-accent" />
          <h3 className="font-semibold text-foreground">
            配置历史 ({backups.length} 个备份)
          </h3>
        </div>
        <button
          onClick={() => refetch()}
          className="p-1.5 rounded-lg hover:bg-card transition-colors"
          title="刷新备份列表"
        >
          <RefreshCw className="size-4 text-muted-foreground" />
        </button>
      </div>

      {/* 备份列表 */}
      {backups.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <FileText className="size-12 mx-auto mb-3 opacity-50" />
          <p className="mb-2">暂无备份记录</p>
          <p className="text-xs">
            每次修改配置时会自动创建备份
          </p>
        </div>
      ) : (
        <div className="relative">
          {/* 时间线 */}
          <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-border" />

          <div className="space-y-4">
            {backups.map((backup: import("@/types/cc/settings").BackupInfo, index: number) => (
              <BackupItem
                key={backup.path}
                backup={backup}
                isFirst={index === 0}
                onRestore={() => handleRestoreClick(backup)}
                isRestoring={restoreBackup.isPending && selectedBackup?.path === backup.path}
              />
            ))}
          </div>
        </div>
      )}

      {/* 确认对话框 */}
      {showConfirmDialog && selectedBackup && (
        <RestoreConfirmDialog
          backup={selectedBackup}
          onConfirm={handleConfirmRestore}
          onClose={handleCloseDialog}
          isRestoring={restoreBackup.isPending}
          error={restoreError}
        />
      )}
    </div>
  );
}

interface BackupItemProps {
  backup: BackupInfo;
  isFirst: boolean;
  onRestore: () => void;
  isRestoring: boolean;
}

function BackupItem({ backup, isFirst, onRestore, isRestoring }: BackupItemProps) {
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

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // 从路径提取文件名
  const fileName = backup.path.split("/").pop() || backup.path;

  return (
    <div className="relative flex gap-4 pl-8">
      {/* 时间线节点 */}
      <div
        className={cn(
          "absolute left-2.5 size-3 rounded-full border-2",
          isFirst
            ? "bg-accent border-accent"
            : "bg-popover border-border"
        )}
        style={{ top: "0.625rem" }}
      />

      {/* 内容卡片 */}
      <div
        className={cn(
          "flex-1 p-4 rounded-lg border transition-colors",
          isFirst
            ? "bg-accent/5 border-accent/30"
            : "bg-card border-border"
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              {isFirst && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-primary text-primary-foreground">
                  最新
                </span>
              )}
              <span className="font-medium text-foreground">
                {formatTime(backup.createdAt)}
              </span>
            </div>
            <div className="text-xs text-muted-foreground space-y-1">
              <div className="font-mono truncate" title={fileName}>
                {fileName}
              </div>
              <div className="flex items-center gap-3">
                <span>大小: {formatSize(backup.size)}</span>
                <span className="font-mono">Hash: {backup.hash.slice(0, 8)}...</span>
              </div>
            </div>
          </div>

          {/* 回滚按钮 */}
          <button
            onClick={onRestore}
            disabled={isRestoring}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm",
              "bg-background hover:bg-warning/10",
              "border border-border hover:border-warning",
              "text-muted-foreground hover:text-warning",
              "transition-colors",
              isRestoring && "opacity-50 cursor-wait"
            )}
          >
            {isRestoring ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RotateCcw className="size-4" />
            )}
            回滚
          </button>
        </div>
      </div>
    </div>
  );
}

interface RestoreConfirmDialogProps {
  backup: BackupInfo;
  onConfirm: () => void;
  onClose: () => void;
  isRestoring: boolean;
  error: string | null;
}

function RestoreConfirmDialog({
  backup,
  onConfirm,
  onClose,
  isRestoring,
  error,
}: RestoreConfirmDialogProps) {
  const formatTime = (timestamp: string) => {
    try {
      return new Date(timestamp).toLocaleString("zh-CN");
    } catch {
      return timestamp;
    }
  };

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
          "relative w-full max-w-md mx-4",
          "bg-popover rounded-xl shadow-2xl",
          "overflow-hidden"
        )}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <RotateCcw className="size-5 text-warning" />
            <h2 className="font-semibold text-lg text-foreground">
              确认回滚
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-card transition-colors"
            disabled={isRestoring}
          >
            <X className="size-5 text-muted-foreground" />
          </button>
        </div>

        {/* 内容 */}
        <div className="p-5">
          <div className="mb-4 p-4 rounded-lg bg-warning/10 border border-warning/30">
            <div className="flex items-start gap-2">
              <AlertCircle className="size-5 text-warning flex-shrink-0 mt-0.5" />
              <div className="text-sm text-foreground">
                <p className="font-medium mb-1">此操作将：</p>
                <ul className="list-disc list-inside text-muted-foreground space-y-1">
                  <li>备份当前配置</li>
                  <li>恢复到选定的历史版本</li>
                  <li>覆盖 settings.json</li>
                </ul>
              </div>
            </div>
          </div>

          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">回滚到：</span>
              <span className="text-foreground">
                {formatTime(backup.createdAt)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Hash：</span>
              <span className="font-mono text-foreground">
                {backup.hash.slice(0, 12)}...
              </span>
            </div>
          </div>
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="px-5 py-3 bg-destructive/10 border-t border-destructive/20">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="size-4 flex-shrink-0" />
              <span className="text-sm">{error}</span>
            </div>
          </div>
        )}

        {/* 底部操作 */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border">
          <button
            onClick={onClose}
            className="btn-secondary"
            disabled={isRestoring}
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="btn-primary flex items-center gap-2 bg-warning hover:bg-warning/90"
            disabled={isRestoring}
          >
            {isRestoring ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                回滚中...
              </>
            ) : (
              <>
                <CheckCircle className="size-4" />
                确认回滚
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
