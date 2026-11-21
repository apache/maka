/**
 * 冲突对话框组件
 */

import { AlertTriangle, RefreshCw, Undo2, X } from "lucide-react";
import { cn } from '@ggbdpq/console-ui';

interface ConflictDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onReload: () => void;
  onKeepLocal: () => void;
  newHash: string;
  changeTime: string;
}

export function ConflictDialog({
  isOpen,
  onClose,
  onReload,
  onKeepLocal,
  newHash,
  changeTime,
}: ConflictDialogProps) {
  if (!isOpen) return null;

  const formatTime = (timestamp: string) => {
    try {
      return new Date(timestamp).toLocaleString("zh-CN");
    } catch {
      return timestamp;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 遮罩 */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* 对话框 */}
      <div
        className={cn(
          "relative z-10 w-[420px] rounded-xl bg-popover shadow-2xl",
          "border border-border"
        )}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-full bg-warning/10">
              <AlertTriangle className="size-5 text-warning" />
            </div>
            <h2 className="text-lg font-semibold text-foreground">
              检测到外部修改
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-card transition-colors"
          >
            <X className="size-4 text-muted-foreground" />
          </button>
        </div>

        {/* 内容 */}
        <div className="p-4 space-y-4">
          <p className="text-muted-foreground">
            配置文件 <code className="text-sm font-mono">settings.json</code>{" "}
            已被外部程序修改。请选择如何处理：
          </p>

          <div className="p-3 rounded-lg bg-card text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">变更时间:</span>
              <span className="text-foreground">
                {formatTime(changeTime)}
              </span>
            </div>
            <div className="flex justify-between mt-1">
              <span className="text-muted-foreground">新 Hash:</span>
              <span className="font-mono text-foreground">
                {newHash.slice(0, 12)}...
              </span>
            </div>
          </div>
        </div>

        {/* 按钮 */}
        <div className="flex gap-3 p-4 border-t border-border">
          <button
            onClick={onReload}
            className={cn(
              "flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg",
              "bg-primary text-primary-foreground font-medium",
              "hover:bg-primary/90 transition-colors"
            )}
          >
            <RefreshCw className="size-4" />
            加载最新
          </button>
          <button
            onClick={onKeepLocal}
            className={cn(
              "flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg",
              "bg-card text-foreground font-medium",
              "hover:bg-border transition-colors"
            )}
          >
            <Undo2 className="size-4" />
            保持本地
          </button>
        </div>
      </div>
    </div>
  );
}
