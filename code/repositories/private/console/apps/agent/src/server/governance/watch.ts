import fs from "node:fs";
import { listProjects, resolveGovernanceRoot } from "./workspace";
import type { RuntimeTask } from "@/runtime/tasks";

// 治理工件变更监听：watch 各项目的 .ggbdpq 目录（不递归整树，避开 node_modules），
// 有变动时使扫描缓存失效。工厂内异步发现项目；stop 幂等（对冲 dev 热重载）。
const g = globalThis as typeof globalThis & {
  __governanceCacheVersion?: number;
};

export function getGovernanceCacheVersion(): number {
  return g.__governanceCacheVersion ?? 0;
}

export function bumpGovernanceCache(): void {
  g.__governanceCacheVersion = (g.__governanceCacheVersion ?? 0) + 1;
}

export function governanceWatchTaskFactory(): RuntimeTask {
  const watchers = new Set<fs.FSWatcher>();
  let stopped = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    stopped = true;
    for (const w of watchers) w.close();
    watchers.clear();
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const scheduleBump = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => bumpGovernanceCache(), 300);
  };

  void (async () => {
    const projects = await listProjects(resolveGovernanceRoot());
    if (stopped) return;
    for (const project of projects) {
      if (stopped) return;
      try {
        const w = fs.watch(project.root + "/.ggbdpq", () => scheduleBump());
        watchers.add(w);
      } catch {
        // 单个项目监听失败不阻断整体
      }
    }
  })();

  return { name: "governance-watch", stop };
}
