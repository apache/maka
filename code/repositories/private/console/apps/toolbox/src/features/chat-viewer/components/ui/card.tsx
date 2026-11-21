import * as React from "react";

import { cn } from "@/features/chat-viewer/lib/utils";

/**
 * 带边框和背景的基础卡片容器。
 */
export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <section
      className={cn(
        "rounded-lg border border-zinc-200 bg-white text-zinc-950 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50",
        className,
      )}
      {...props}
    />
  );
}

/**
 * 卡片头部区域，通常包含标题和描述。
 */
export function CardHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("space-y-1.5 p-5", className)} {...props} />;
}

/**
 * 卡片标题文本。
 */
export function CardTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn("text-base font-semibold leading-none", className)}
      {...props}
    />
  );
}

/**
 * 卡片标题下方的辅助描述文本。
 */
export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("text-sm text-zinc-500 dark:text-zinc-400", className)} {...props} />
  );
}

/**
 * 卡片主体内容区域。
 */
export function CardContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5 pt-0", className)} {...props} />;
}
