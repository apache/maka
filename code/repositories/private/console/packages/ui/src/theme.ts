"use client";
// 主题唯一真源：localStorage key "theme"，三态 light/dark/system。
// 分工：ThemeScript 负责首帧防闪，applyTheme 负责运行时切换，useTheme 提供 React 绑定。
// 各 app 不得再自建主题存储（原 claude-profile-theme / agentops-theme / card-admin-ui-v2 已收编）。
import * as React from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "theme";

const CYCLE: Theme[] = ["light", "dark", "system"];

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme !== "system") return theme;
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", resolveTheme(theme) === "dark");
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {}
  window.dispatchEvent(new Event("themechange"));
}

export function cycleTheme(theme: Theme): Theme {
  return CYCLE[(CYCLE.indexOf(theme) + 1) % CYCLE.length];
}

function subscribeTheme(callback: () => void): () => void {
  window.addEventListener("themechange", callback);
  window.addEventListener("storage", callback);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", callback);
  return () => {
    window.removeEventListener("themechange", callback);
    window.removeEventListener("storage", callback);
    media.removeEventListener("change", callback);
  };
}

export function useTheme(): {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  cycle: () => void;
} {
  const theme = React.useSyncExternalStore(subscribeTheme, getStoredTheme, (): Theme => "system");
  const resolvedTheme = React.useSyncExternalStore(
    subscribeTheme,
    () => resolveTheme(getStoredTheme()),
    (): ResolvedTheme => "light",
  );
  const setTheme = React.useCallback((next: Theme) => applyTheme(next), []);
  const cycle = React.useCallback(() => applyTheme(cycleTheme(getStoredTheme())), []);
  return { theme, resolvedTheme, setTheme, cycle };
}
