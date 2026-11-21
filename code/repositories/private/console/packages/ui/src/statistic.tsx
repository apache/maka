import * as React from "react";
import { cn } from "./cn";

// Statistic（ant-design Statistic）：数字 + 标题 + 前后缀

export function Statistic({ className, title, value, prefix, suffix, ...props }: React.ComponentProps<"div"> & { title?: React.ReactNode; value?: React.ReactNode; prefix?: React.ReactNode; suffix?: React.ReactNode }) {
  return (
    <div className={cn("", className)} {...props}>
      {title ? <div className="text-xs text-muted-foreground">{title}</div> : null}
      <div className="mt-1 text-2xl font-bold tabular-nums">
        {prefix}
        {value}
        {suffix ? <span className="ml-0.5 text-sm font-normal text-muted-foreground">{suffix}</span> : null}
      </div>
    </div>
  );
}

export function StatisticCountdown({ className, title, value, ...props }: React.ComponentProps<"div"> & { title?: React.ReactNode; value: string }) {
  return (
    <div className={className} {...props}>
      {title ? <div className="text-xs text-muted-foreground">{title}</div> : null}
      <div className="mt-1 font-mono text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}
