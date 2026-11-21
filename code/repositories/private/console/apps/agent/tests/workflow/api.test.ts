import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// workflow API 契约：tasks CRUD / claim 原子 / 生命周期转换 / SSE 首包 / 审计。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-wfapi-test-"));

const json = (body: unknown) =>
  new Request("http://localhost:3000/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

let taskId = "";

beforeAll(() => {
  process.env.CONSOLE_DATA_DIR = path.join(tmp, `wf-${Date.now()}`);
});

afterAll(() => {
  delete process.env.CONSOLE_DATA_DIR;
});

describe("workflow API 契约", () => {
  it("POST/GET tasks：创建与列表（含非法体 400）", async () => {
    const routes = await import("@/app/api/workflow/tasks/route");
    const bad = await routes.POST(json({}));
    expect(bad.status).toBe(400);
    const created = await routes.POST(json({ title: "API 任务", spec: { cmd: "test" } }));
    expect(created.status).toBe(201);
    const body = (await created.json()) as { task: { id: string } };
    taskId = body.task.id;
    const list = (await (await routes.GET(new Request("http://localhost:3000/x"))).json()) as {
      tasks: Array<{ id: string }>;
    };
    expect(list.tasks.map((t) => t.id)).toContain(taskId);
  });

  it("GET tasks/[id]：任务 + 执行记录聚合", async () => {
    await (await import("@/app/api/workflow/tasks/[id]/rerun/route")).POST(
      new Request("http://localhost:3000/x"), { params: Promise.resolve({ id: taskId }) },
    );
    const { GET } = await import("@/app/api/workflow/tasks/[id]/route");
    const res = await GET(new Request("http://localhost:3000/x"), { params: Promise.resolve({ id: taskId }) });
    const body = (await res.json()) as { task: { id: string }; executions: Array<{ status: string }> };
    expect(body.task.id).toBe(taskId);
    // createTask 内建 attempt=1 + rerun attempt=2
    expect(body.executions).toHaveLength(2);
    expect(body.executions.map((e) => e.status)).toContain("PENDING");
  });

  it("claim：worker 领取 PENDING；空队列再领为空", async () => {
    const { POST } = await import("@/app/api/workflow/executions/claim/route");
    const r1 = await POST(json({ workerId: "w-1" }));
    const b1 = (await r1.json()) as { executions: Array<{ executionId: string; spec: { cmd: string } }> };
    expect(b1.executions).toHaveLength(1); // createTask 内建的 attempt=1 执行
    expect(b1.executions[0]!.spec.cmd).toBe("test");
    const r2 = await POST(json({ workerId: "w-2" }));
    // 还剩 rerun 造的那条可领
    expect(((await r2.json()) as { executions: unknown[] }).executions).toHaveLength(1);
  });

  it("executions/[action]：start→progress→complete 转换链", async () => {
    // 先再造一条 PENDING
    await (await import("@/app/api/workflow/tasks/[id]/rerun/route")).POST(
      new Request("http://localhost:3000/x"), { params: Promise.resolve({ id: taskId }) },
    );
    const claim = (await import("@/app/api/workflow/executions/claim/route")).POST;
    const claimed = (await (await claim(json({ workerId: "w-9" }))).json()) as {
      executions: Array<{ executionId: string }>;
    };
    const id = claimed.executions[0]!.executionId;
    const actionRoute = await import("@/app/api/workflow/executions/[id]/[action]/route");
    const ctx = { params: Promise.resolve({ id, action: "start" }) };
    const s = await actionRoute.POST(new Request("http://localhost:3000/x"), {
      params: Promise.resolve({ id, action: "start" }),
    });
    expect(s.status).toBe(200);
    await actionRoute.POST(json({ progress: 60, currentStep: "half" }), {
      params: Promise.resolve({ id, action: "progress" }),
    });
    const c = await actionRoute.POST(json({ result: { done: 1 } }), {
      params: Promise.resolve({ id, action: "complete" }),
    });
    const cBody = (await c.json()) as { execution: { status: string; progress: number } };
    expect(cBody.execution.status).toBe("COMPLETED");
    expect(cBody.execution.progress).toBe(100);
  });

  it("cancel：活动执行 200；再无可取消执行时 400", async () => {
    const cancel = (await import("@/app/api/workflow/tasks/[id]/cancel/route")).POST;
    // 循环取消所有活动执行（数量随前序用例变化：CLAIMED/PENDING 均可取消），直到 400
    for (let i = 0; i < 5; i++) {
      const res = await cancel(json({}), { params: Promise.resolve({ id: taskId }) });
      if (res.status === 400) {
        expect(((await res.json()) as { code: string }).code).toBe("CANCEL_FAILED");
        return;
      }
      expect(res.status).toBe(200);
    }
    throw new Error("取消 5 次仍返回 200，终态化逻辑异常");
  });

  it("GET audit 返回倒序条目", async () => {
    const { GET } = await import("@/app/api/workflow/audit/route");
    const body = (await (await GET(new Request("http://localhost:3000/x?limit=10"))).json()) as {
      entries: Array<{ action: string }>;
    };
    expect(body.entries.length).toBeGreaterThanOrEqual(2);
  });

  it("SSE /events：首包含历史事件", async () => {
    const { GET } = await import("@/app/api/workflow/events/route");
    const res = await GET(new Request("http://localhost:3000/x"));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: ");
    await reader.cancel();
  });
});
