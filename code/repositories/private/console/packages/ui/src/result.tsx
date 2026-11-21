import * as React from "react";
import { cn } from "./cn";

// Result（ant-design Result）：状态图标 + 标题 + 副文案 + 操作区

const STATUS_ICON: Record<string, string> = {
  success: "✅",
  error: "❌",
  warning: "⚠️",
  info: "ℹ️",
};

export function Result({
  status = "info",
  title,
  subTitle,
  extra,
  className,
  ...props
}: React.ComponentProps<"div"> & { status?: keyof typeof STATUS_ICON; title: React.ReactNode; subTitle?: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 py-12 text-center", className)} {...props}>
      <div className="text-4xl">{STATUS_ICON[status]}</div>
      <h3 className="text-lg font-semibold">{title}</h3>
      {subTitle ? <p className="max-w-sm text-sm text-muted-foreground">{subTitle}</p> : null}
      {extra ? <div className="mt-2 flex gap-2">{extra}</div> : null}
    </div>
  );
}
