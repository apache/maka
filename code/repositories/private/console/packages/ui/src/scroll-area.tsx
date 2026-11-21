import * as React from "react";
import { cn } from "./cn";

// ScrollArea：shadcn 形态的最小实现（原生滚动条；自定义滚动条样式缓迁）
export function ScrollArea({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("relative overflow-y-auto", className)} {...props}>
      {children}
    </div>
  );
}
