import { describe, expect, it } from "vitest";
import { startRuntimeTasks, stopRuntimeTasks, taskFactories } from "@/runtime/tasks";

describe("常驻任务注册表（骨架）", () => {
  it("重复 start/stop 不产生残留任务", async () => {
    const registry: unknown[] = [];
    await startRuntimeTasks(registry as never);
    await startRuntimeTasks(registry as never);
    await stopRuntimeTasks(registry as never);
    await stopRuntimeTasks(registry as never);
    expect(registry).toHaveLength(0);
    expect(taskFactories).toBeInstanceOf(Array);
  });
});
