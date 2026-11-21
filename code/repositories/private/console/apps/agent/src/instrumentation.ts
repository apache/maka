import type { RuntimeTask } from "./runtime/tasks";

// Next.js 约定：进程内运行时启动时调用一次 register()。
// dev 热重载会创建新运行时并再次调用，因此全局注册表挂在 globalThis 上，
// 且 stop 幂等，保证 watcher/定时器/连接绝不重复。
interface ConsoleRuntime {
  started: boolean;
  tasks: RuntimeTask[];
  stopAll: () => Promise<void>;
}

const g = globalThis as typeof globalThis & {
  __consoleRuntime?: ConsoleRuntime;
};

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (g.__consoleRuntime?.started) {
    // 上一个运行时的任务先停干净，再重启——dev 热重载场景。
    await g.__consoleRuntime.stopAll();
  }
  const { startRuntimeTasks } = await import("./runtime/tasks");
  const runtime: ConsoleRuntime = {
    started: true,
    tasks: [],
    stopAll: async () => {
      const { stopRuntimeTasks } = await import("./runtime/tasks");
      await stopRuntimeTasks(runtime.tasks);
      runtime.started = false;
    },
  };
  g.__consoleRuntime = runtime;
  await startRuntimeTasks(runtime.tasks);
}
