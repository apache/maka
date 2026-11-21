import * as React from "react";
import { cn } from "./cn";

// Typography（ant-design Typography 系）：语义化文字层级

export function Typography({ className, ...props }: React.ComponentProps<"article">) {
  return <article className={cn("leading-7 text-foreground/90", className)} {...props} />;
}

const TITLE_LEVELS = {
  1: "text-3xl font-bold",
  2: "text-2xl font-bold",
  3: "text-xl font-semibold",
  4: "text-lg font-semibold",
  5: "text-base font-semibold",
} as const;

export function Title({
  level = 1,
  className,
  children,
  ...props
}: React.ComponentProps<"h1"> & { level?: keyof typeof TITLE_LEVELS }) {
  const Tag = `h${level}` as const;
  return (
    <Tag className={cn(TITLE_LEVELS[level], "leading-snug", className)} {...props}>
      {children}
    </Tag>
  );
}

export function Text({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-sm leading-6", className)} {...props} />;
}

export function Paragraph({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("leading-7 text-foreground/90", className)} {...props} />;
}

export function Quote({ className, ...props }: React.ComponentProps<"blockquote">) {
  return <blockquote className={cn("border-l-4 border-primary/40 bg-muted/50 px-4 py-1 text-muted-foreground", className)} {...props} />;
}

export function Code({ className, ...props }: React.ComponentProps<"code">) {
  return <code className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-[13px]", className)} {...props} />;
}
