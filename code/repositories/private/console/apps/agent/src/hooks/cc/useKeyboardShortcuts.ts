/**
 * 键盘快捷键 Hook
 * P2-10: 快捷键支持
 */

import { useEffect, useCallback } from "react";

interface ShortcutHandlers {
  onRefresh?: () => void;
  onToggleTheme?: () => void;
  onSwitchTab?: (tab: string) => void;
}

/**
 * 键盘快捷键 Hook
 * 
 * 快捷键列表：
 * - Cmd/Ctrl + R: 刷新配置
 * - Cmd/Ctrl + D: 切换暗色模式
 * - Cmd/Ctrl + 1: 切换到插件管理
 * - Cmd/Ctrl + 2: 切换到环境变量
 * - Cmd/Ctrl + 3: 切换到 Profile
 * - Cmd/Ctrl + 4: 切换到审计日志
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const isMod = event.metaKey || event.ctrlKey;
      
      if (!isMod) return;

      switch (event.key.toLowerCase()) {
        case "r":
          event.preventDefault();
          handlers.onRefresh?.();
          break;
        case "d":
          event.preventDefault();
          handlers.onToggleTheme?.();
          break;
        case "1":
          event.preventDefault();
          handlers.onSwitchTab?.("plugins");
          break;
        case "2":
          event.preventDefault();
          handlers.onSwitchTab?.("env");
          break;
        case "3":
          event.preventDefault();
          handlers.onSwitchTab?.("profiles");
          break;
        case "4":
          event.preventDefault();
          handlers.onSwitchTab?.("audit");
          break;
      }
    },
    [handlers]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}

/**
 * 快捷键提示组件用的数据
 */
export const SHORTCUTS = [
  { key: "⌘R", description: "刷新配置" },
  { key: "⌘D", description: "切换暗色模式" },
  { key: "⌘1", description: "插件管理" },
  { key: "⌘2", description: "环境变量" },
  { key: "⌘3", description: "Profile" },
  { key: "⌘4", description: "审计日志" },
];
