import * as React from "react";
import { cn } from "./cn";

export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}

export function Spinner({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      role="status"
      aria-label="加载中"
      className={cn("inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent text-primary", className)}
      {...props}
    />
  );
}
