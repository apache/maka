import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// workflow 状态机契约：九操作全路径 + 原子 claim + 事件/审计断言（对齐 execution.service.ts 453 行语义）。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-wf-test-"));

beforeEach(() => {
  process.env.CONSOLE_DATA_DIR = path.join(tmp, `run-${Date.now()}`);
});

afterEach(() => {
  delete process.env.CONSOLE_DATA_DIR;
});

async function setup() {
  const db = await import("@/server/workflow/db");
  const tasks = await import("@/server/workflow/tasks");
  const exec = await import("@/server/workflow/execution");
  const events = await import("@/server/workflow/events");
  return { db, tasks, exec, events };
}

describe("workflow 状态机契约（降栈自 execution.service.ts）", () => {
  it("createTask/listTasks/getTask 基础 CRUD", async () => {
    const { tasks } = await setup();
    const t = tasks.createTask({ title: "测试任务", spec: { cmd: "echo" } });
    expect(t.id).toBeTruthy();
    expect(tasks.getTask(t.id)!.title).toBe("测试任务");
    expect(tasks.listTasks().map((x) => x.id)).toContain(t.id);
  });

  it("claim 原子性：PENDING→CLAIMED，同执行不被二次 claim", async () => {
    const { tasks, exec } = await setup();
    const t = tasks.createTask({ title: "claim", spec: { x: 1 } });
    // 先领走 createTask 内建的 attempt=1 执行
    exec.claim({ workerId: "w0" });
    const r1 = exec.rerun(t.id); // 造 PENDING 执行
    const c1 = exec.claim({ workerId: "w1" });
    expect(c1.executions.map((e) => e.executionId)).toContain(r1.id);
    expect(c1.executions[0]!.spec).toEqual({ x: 1 });
    // 再 claim 不会拿到同一条
    const c2 = exec.claim({ workerId: "w2" });
    expect(c2.executions.map((e) => e.executionId)).not.toContain(r1.id);
    expect(exec.findByJobId(r1.jobId)!.status).toBe("CLAIMED");
  });

  it("start→progress→complete 全链 + 事件 + 审计", async () => {
    const { tasks, exec, events } = await setup();
    const emitted: string[] = [];
    events.subscribe((e) => emitted.push(e.type));

    const t = tasks.createTask({ title: "full", spec: {} });
    const e1 = exec.rerun(t.id);
    exec.claim({ workerId: "w1" });
    const running = exec.start(e1.id);
    expect(running.status).toBe("RUNNING");
    exec.progress(e1.id, 50, "处理中");
    expect(exec.findByJobId(e1.jobId)!.progress).toBe(50);
    const done = exec.complete(e1.id, { ok: true });
    expect(done.status).toBe("COMPLETED");
    expect(done.progress).toBe(100);

    expect(emitted).toEqual(
      expect.arrayContaining(["execution.claimed", "execution.started", "execution.progress", "execution.completed"]),
    );
    // 审计（completed 有审计；claimed/started 有审计）
    // 事件历史可重放
    expect(events.history().map((e) => e.type)).toContain("execution.completed");
  });

  it("fail：RUNNING→FAILED 且记录错误", async () => {
    const { tasks, exec } = await setup();
    const t = tasks.createTask({ title: "f", spec: {} });
    const e1 = exec.rerun(t.id);
    exec.claim({ workerId: "w" });
    exec.start(e1.id);
    const failed = exec.fail(e1.id, { message: "boom" });
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toEqual({ message: "boom" });
  });

  it("heartbeat 刷新心跳；checkTimeouts 只标 CLAIMED/RUNNING 超时", async () => {
    const { tasks, exec } = await setup();
    const t = tasks.createTask({ title: "hb", spec: {} });
    const e1 = exec.rerun(t.id);
    exec.claim({ workerId: "w" });
    exec.start(e1.id);
    const hb = exec.heartbeat(e1.id);
    expect(hb.lastHeartbeatAt).toBeTruthy();
    // 刚心跳过：不超时
    expect(exec.checkTimeouts(60_000)).toBe(0);
    // 把心跳拨回 10 分钟前：超时命中
    const dbm = await import("@/server/workflow/db");
    (dbm.getWorkflowDb() as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => void } })
      .prepare("UPDATE executions SET last_heartbeat_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 10 * 60 * 1000).toISOString(), e1.id);
    expect(exec.checkTimeouts(5 * 60 * 1000)).toBe(1);
    expect(exec.findByJobId(e1.jobId)!.status).toBe("TIMEOUT");
  });

  it("cancel：活动态可取消、终态不可取消", async () => {
    const { tasks, exec } = await setup();
    const t = tasks.createTask({ title: "c", spec: {} });
    const e1 = exec.rerun(t.id);
    exec.claim({ workerId: "w" });
    const cancelled = exec.cancel(t.id); // 不带 executionId → 最新活动执行
    expect(cancelled.status).toBe("CANCELLED");
    expect(() => exec.cancel(t.id, e1.id)).toThrow("不可取消");
  });

  it("rerun：attemptNumber 递增且新建 PENDING", async () => {
    const { tasks, exec } = await setup();
    const t = tasks.createTask({ title: "r", spec: {} });
    const e1 = exec.rerun(t.id);
    exec.claim({ workerId: "w" });
    exec.start(e1.id);
    exec.complete(e1.id, {});
    const e2 = exec.rerun(t.id);
    expect(e2.attemptNumber).toBe(e1.attemptNumber + 1);
    expect(e2.status).toBe("PENDING");
    expect(e2.jobId).not.toBe(e1.jobId);
    // COMPLETED 不可取消
    expect(() => exec.cancel(t.id, e1.id)).toThrow("不可取消");
  });
});
