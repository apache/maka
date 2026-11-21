import { expect, test } from "@playwright/test";

/**
 * workflow 块 e2e（二期 item 17 验收）：UI 创建任务 → worker claim → 生命周期转换 → COMPLETED 全链。
 */
test("workflow 全链：创建→claim→start→progress→complete→SSE", async ({ page, request }) => {
  await page.goto("/workflow");
  await expect(page.getByRole("heading", { name: "执行引擎" })).toBeVisible();

  // UI 创建任务
  await page.getByPlaceholder("任务标题").fill("e2e 全链任务");
  await page.getByPlaceholder(/spec JSON/).fill('{"cmd":"e2e"}');
  await page.getByRole("button", { name: "创建任务" }).click();
  await expect(page.getByText("e2e 全链任务").first()).toBeVisible();

  // worker claim（API）
  const claim = await request.post("/api/workflow/executions/claim", {
    data: { workerId: "e2e-worker" },
  });
  const claimBody = (await claim.json()) as { executions: Array<{ executionId: string }> };
  expect(claimBody.executions).toHaveLength(1);
  const id = claimBody.executions[0]!.executionId;

  // 生命周期
  expect((await request.post(`/api/workflow/executions/${id}/start`)).status()).toBe(200);
  expect(
    (await request.post(`/api/workflow/executions/${id}/progress`, { data: { progress: 50, currentStep: "e2e" } })).status(),
  ).toBe(200);
  const done = await request.post(`/api/workflow/executions/${id}/complete`, { data: { result: { ok: true } } });
  expect(done.status()).toBe(200);

  // SSE 流可连且有历史事件（无限流：浏览器内读首块即取消，不能等完整 body）
  const firstChunk = await page.evaluate(async () => {
    const res = await fetch("/api/workflow/events?afterSeq=0");
    if (res.headers.get("content-type") !== "text/event-stream") return "BAD-CONTENT-TYPE";
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    return new TextDecoder().decode(value ?? new Uint8Array());
  });
  expect(firstChunk).toContain("event: ");
  expect(firstChunk).toContain("data: ");
});
