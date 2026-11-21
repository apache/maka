import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

async function exportBackup(page: Page) {
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出全部数据" }).click();
  const download = await downloading;
  const backup = JSON.parse(await readFile((await download.path())!, "utf8"));
  delete backup.exportedAt;
  return backup;
}

test("设置页面导入完整备份，坏备份被整体拒绝并保留原数据", async ({ page }) => {
  await page.goto("/interview-gym/settings");
  const valid = {
    attempts: [],
    config: { p0p1: 2, ai: 1, design: 0, project: 1, retest: 3 },
    notes: { "fixture/q": "保留笔记" },
    bookmarks: { "fixture/q": 123 },
    providers: [],
    defaultProviderId: "",
    interviewRounds: 2,
  };
  const input = page.locator('input[type="file"]');
  await input.setInputFiles({
    name: "valid.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(valid)),
  });
  await expect(page.getByText("数据已导入", { exact: true }).first()).toBeVisible();
  expect(await exportBackup(page)).toEqual(valid);
  await input.setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ notes: { "fixture/q": "不应写入" }, interviewRounds: 9 })),
  });
  await expect(
    page.getByText("导入失败：备份 JSON 无效或字段格式不正确", { exact: true }).first(),
  ).toBeVisible();
  expect(await exportBackup(page)).toEqual(valid);
  await page.reload();
  expect(await exportBackup(page)).toEqual(valid);
});

test("迁移后的中继向临时 HTTP 上游透传请求、失败状态与响应体", async ({ request }) => {
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    res.writeHead(429, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        path: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      }),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const port = (upstream.address() as { port: number }).port;
    const response = await request.post("/api/interview-gym/relay/chat/completions", {
      headers: { "x-llm-target": `http://127.0.0.1:${port}/v1`, authorization: "Bearer fixture" },
      data: { model: "fixture", messages: [] },
    });
    expect(response.status()).toBe(429);
    expect(await response.json()).toEqual({
      path: "/v1/chat/completions",
      authorization: "Bearer fixture",
      body: { model: "fixture", messages: [] },
    });
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
