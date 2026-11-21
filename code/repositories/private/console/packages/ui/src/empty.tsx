import * as React from "react";
import { cn } from "./cn";

export function Empty({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 py-12 text-center", className)} {...props}>
      <div className="text-3xl opacity-40">📭</div>
      {children ?? <p className="text-sm text-muted-foreground">暂无数据</p>}
    </div>
  );
}

export function EmptyDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
