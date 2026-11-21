import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-terminal-"));
beforeAll(() => {
  process.env.CONSOLE_DATA_DIR = tmp;
});
afterAll(() => {
  delete process.env.CONSOLE_DATA_DIR;
});

const json = (body: unknown = {}) =>
  new Request("http://localhost/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

it("完成记录拒绝再次变更，事件与结果保留，重跑创建新记录", async () => {
  const tasks = await import("@/app/api/workflow/tasks/route");
  const task = await import("@/app/api/workflow/tasks/[id]/route");
  const claim = await import("@/app/api/workflow/executions/claim/route");
  const action = await import("@/app/api/workflow/executions/[id]/[action]/route");
  const rerun = await import("@/app/api/workflow/tasks/[id]/rerun/route");
  const events = await import("@/app/api/workflow/events/route");
  const created = await (await tasks.POST(json({ title: "终态保护", spec: {} }))).json();
  const id = created.task.id;
  const taskContext = { params: Promise.resolve({ id }) };
  const claimed = await (await claim.POST(json({ workerId: "test" }))).json();
  const executionId = claimed.executions[0].executionId;
  const send = (name: string, body?: unknown) =>
    action.POST(json(body), {
      params: Promise.resolve({ id: executionId, action: name }),
    });
  const snapshot = async () =>
    (await (await task.GET(new Request("http://localhost/x"), taskContext)).json()).executions;
  const history = async () => {
    const controller = new AbortController();
    const response = await events.GET(
      new Request("http://localhost/events?afterSeq=0", { signal: controller.signal }),
    );
    controller.abort();
    return response.text();
  };
  expect((await send("start")).status).toBe(200);
  expect((await send("complete", { result: { ok: true } })).status).toBe(200);
  const before = await snapshot();
  const beforeEvents = await history();
  for (const name of ["start", "progress", "heartbeat", "complete", "fail"]) {
    const response = await send(name, { progress: 1, result: "overwrite", error: "overwrite" });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("TRANSITION_FAILED");
  }
  expect(await snapshot()).toEqual(before);
  expect(await history()).toBe(beforeEvents);
  expect((await rerun.POST(json(), taskContext)).status).toBe(201);
  const after = await snapshot();
  expect(after).toHaveLength(2);
  expect(after[0].status).toBe("PENDING");
  expect(after[0].id).not.toBe(executionId);
  expect(after[1]).toEqual(before[0]);
});

it("同一时间创建的执行按尝试次数取消最新记录", async () => {
  const tasks = await import("@/app/api/workflow/tasks/route");
  const task = await import("@/app/api/workflow/tasks/[id]/route");
  const rerun = await import("@/app/api/workflow/tasks/[id]/rerun/route");
  const cancel = await import("@/app/api/workflow/tasks/[id]/cancel/route");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
  try {
    const created = await (await tasks.POST(json({ title: "取消最新尝试", spec: {} }))).json();
    const context = { params: Promise.resolve({ id: created.task.id }) };
    const next = await (await rerun.POST(json(), context)).json();
    const result = await (await cancel.POST(json(), context)).json();
    expect(result.execution.id).toBe(next.execution.id);
    const executions = (await (await task.GET(new Request("http://localhost/x"), context)).json())
      .executions;
    expect(executions.map((e: { status: string }) => e.status)).toEqual(["CANCELLED", "PENDING"]);
    expect((await cancel.POST(json({ executionId: next.execution.id }), context)).status).toBe(400);
  } finally {
    vi.useRealTimers();
  }
});
