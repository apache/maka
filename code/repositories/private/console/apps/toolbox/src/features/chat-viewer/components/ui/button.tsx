import * as React from "react";

import { cn } from "@/features/chat-viewer/lib/utils";

/**
 * 通用按钮组件支持的样式变体和尺寸参数。
 */
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "outline" | "ghost";
  size?: "default" | "sm" | "icon";
};

/**
 * 应用内复用的基础按钮组件。
 */
export function Button({
  className,
  variant = "default",
  size = "default",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      suppressHydrationWarning
      className={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2",
        variant === "default" &&
          "bg-zinc-950 text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-200",
        variant === "outline" &&
          "border border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-900",
        variant === "ghost" &&
          "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900",
        size === "default" && "h-10 px-4 py-2",
        size === "sm" && "h-8 px-3",
        size === "icon" && "h-9 w-9",
        className,
      )}
      {...props}
    />
  );
}
