"use client";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "./button";
import { useTheme, type Theme } from "./theme";

// 三态循环切换（light → dark → system）：切 <html> 的 .dark 并持久化 localStorage('theme')。
// 首帧类名由 ThemeScript 写入（防闪烁），本组件只做运行时切换。

const ICONS: Record<Theme, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };
const LABELS: Record<Theme, string> = { light: "亮色", dark: "暗色", system: "跟随系统" };

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, cycle } = useTheme();
  const Icon = ICONS[theme];

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={cycle}
      aria-label={`主题：${LABELS[theme]}，点击切换`}
      title={`主题：${LABELS[theme]}，点击切换`}
      className={className}
    >
      <Icon className="size-4" />
    </Button>
  );
}
