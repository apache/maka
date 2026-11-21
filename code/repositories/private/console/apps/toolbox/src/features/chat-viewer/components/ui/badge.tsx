import * as React from "react";

import { cn } from "@/features/chat-viewer/lib/utils";

/**
 * Badge 支持的视觉变体参数。
 */
type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  variant?: "default" | "secondary" | "outline";
};

/**
 * 用于状态、标签和辅助信息的紧凑徽标组件。
 */
export function Badge({
  className,
  variant = "default",
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-1 text-xs font-medium",
        variant === "default" && "bg-emerald-600 text-white",
        variant === "secondary" &&
          "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200",
        variant === "outline" &&
          "border border-zinc-200 text-zinc-700 dark:border-zinc-800 dark:text-zinc-200",
        className,
      )}
      {...props}
    />
  );
}
