import * as React from "react";
import { cn } from "./cn";

// Timeline（ant-design Timeline）：竖向时间线

export function Timeline({ className, ...props }: React.ComponentProps<"ol">) {
  return <ol className={cn("relative space-y-5 border-l pl-6", className)} {...props} />;
}

export function TimelineItem({ className, color = "primary", dot, ...props }: React.ComponentProps<"li"> & { color?: string; dot?: React.ReactNode }) {
  return (
    <li className={cn("relative", className)} {...props}>
      <span
        className="absolute top-1.5 -left-[27px] size-2.5 rounded-full border-2 border-background"
        style={dot ? undefined : { backgroundColor: `var(--${color})`, borderColor: "var(--border)" }}
      >
        {dot}
      </span>
      {props.children}
    </li>
  );
}

export function TimelineContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("text-sm", className)} {...props} />;
}

export function TimelineTime({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("mt-0.5 block text-xs text-muted-foreground", className)} {...props} />;
}
