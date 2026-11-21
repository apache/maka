import * as React from "react";
import { cn } from "./cn";

// Descriptions（ant-design Descriptions）：键值对描述列表

export function Descriptions({ className, title, ...props }: React.ComponentProps<"div"> & { title?: React.ReactNode }) {
  return (
    <div className={cn("", className)} {...props}>
      {title ? <h3 className="mb-3 text-base font-semibold">{title}</h3> : null}
      <dl className="divide-y rounded-lg border">{props.children}</dl>
    </div>
  );
}

export function DescriptionsItem({ label, children, className }: { label: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid grid-cols-[120px_1fr] gap-3 px-4 py-2.5 text-sm", className)}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
