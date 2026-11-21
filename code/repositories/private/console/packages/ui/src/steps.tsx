import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "./cn";

// Steps（ant-design Steps）：横向步骤条（受控 current）

export function Steps({ current, items, className }: { current: number; items: string[]; className?: string }) {
  return (
    <ol className={cn("flex items-center gap-2", className)}>
      {items.map((label, i) => {
        const state = i < current ? "done" : i === current ? "active" : "todo";
        return (
          <li key={label} className="flex flex-1 items-center gap-2 last:flex-none">
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium",
                state === "done" && "bg-primary text-primary-foreground",
                state === "active" && "border-2 border-primary text-primary",
                state === "todo" && "border text-muted-foreground",
              )}
            >
              {state === "done" ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className={cn("text-sm", state === "todo" ? "text-muted-foreground" : "font-medium")}>{label}</span>
            {i < items.length - 1 ? <span className="h-px flex-1 bg-border" /> : null}
          </li>
        );
      })}
    </ol>
  );
}
