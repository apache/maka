// 常驻任务运行时句柄。所有后台任务（file-watch、worker、批量刷新）实现该接口，
// 停止函数必须可重复调用（幂等）。
export interface RuntimeTask {
  name: string;
  stop: () => Promise<void> | void;
}

export type RuntimeTaskFactory = () => RuntimeTask;

// 各域任务工厂在此登记；登记顺序即启动顺序。
import { governanceWatchTaskFactory } from "@/server/governance/watch";
import { ccWatchTaskFactory } from "@/server/agentops/cc/watch";

export const taskFactories: RuntimeTaskFactory[] = [
  governanceWatchTaskFactory,
  ccWatchTaskFactory,
];

export async function startRuntimeTasks(registry: RuntimeTask[]): Promise<void> {
  for (const factory of taskFactories) {
    registry.push(factory());
  }
}

export async function stopRuntimeTasks(registry: RuntimeTask[]): Promise<void> {
  // 倒序停止：后启动的任务先停。
  for (const task of registry.reverse()) {
    await task.stop();
  }
  registry.length = 0;
}
