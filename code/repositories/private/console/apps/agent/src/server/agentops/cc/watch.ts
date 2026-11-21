import fs from "node:fs";
import path from "node:path";
import { getSettingsPath } from "./settings";
import type { RuntimeTask } from "@/runtime/tasks";

// cc 域 watcher：监听 Claude Code settings.json 的外部修改（对齐桌面壳 watcher.rs）。
// 事件驱动缓存失效：读取端（API/UI）按版本号决定是否重读磁盘。
const g = globalThis as typeof globalThis & {
  __ccSettingsVersion?: number;
  __ccSettingsLastHash?: string;
};

export function getCcSettingsVersion(): number {
  return g.__ccSettingsVersion ?? 0;
}

export function getCcSettingsLastHash(): string | undefined {
  return g.__ccSettingsLastHash;
}

export function bumpCcSettingsCache(): void {
  g.__ccSettingsVersion = (g.__ccSettingsVersion ?? 0) + 1;
}

export function ccWatchTaskFactory(): RuntimeTask {
  let watcher: fs.FSWatcher | null = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    watcher?.close();
    watcher = null;
  };

  try {
    const settingsPath = getSettingsPath();
    // 目录级监听（部分编辑器保存是 replace 语义，文件级 watch 会丢事件）
    const dir = path.dirname(settingsPath);
    if (fs.existsSync(dir)) {
      watcher = fs.watch(dir, (_event, filename) => {
        if (stopped) return;
        if (String(filename ?? "") !== "settings.json") return;
        bumpCcSettingsCache();
      });
    }
  } catch {
    // 目录不存在（首次使用）时静默跳过；settings 目录出现后由重启/热重载重建
  }

  return { name: "cc-settings-watch", stop };
}
