import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// 浏览器 fetch 的相对 URL 在 Node 中补上测试 origin；响应仍由真实静态副本提供。
const publicRoot = fileURLToPath(new URL("../../../../public/", import.meta.url));
const nativeFetch = globalThis.fetch;
const server = createServer(async (req, res) => {
  try {
    res.end(await readFile(`${publicRoot}${decodeURIComponent(req.url!.slice(1))}`));
  } catch {
    res.writeHead(404).end();
  }
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  vi.stubGlobal("fetch", (input: string) =>
    nativeFetch(new URL(input, `http://127.0.0.1:${address.port}`)),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
import { loadContent } from "./loader";
import { EXAMS } from "../features/mock-exam/lib/exams";

// 对唯一事实源的同步副本做集成检查，不模拟 loader 或 Markdown 解析器。
it("加载当前项目地图中的九张卡，跨目录的公开长稿可以用于口述", async () => {
  const content = await loadContent();
  expect(content.projectCards.map((card) => card.code)).toEqual([
    "P04",
    "P02",
    "P05",
    "P11",
    "P01",
    "P03",
    "P06",
    "P07",
    "P12",
  ]);
  for (const code of ["P05", "P11", "P12"]) {
    const card = content.projectCards.find((card) => card.code === code)!;
    expect(card.slug).not.toContain("/");
    expect(content.projectBodies[card.slug]).toContain("5—8分钟");
    expect(content.projectDocs.find((doc) => doc.slug === card.slug)).toBeDefined();
  }
  expect(content.bank.map((section) => section.questions.length)).toEqual([8, 0, 10, 4]);
});

it("五个既有模拟入口都能查阅同一份合并说明，保留深挖流程与评分边界", async () => {
  const content = await loadContent();
  expect(content.mocks.map((mock) => mock.slug)).toEqual(EXAMS.map((exam) => exam.slug));
  for (const mock of content.mocks) {
    expect(mock.file).toBe("README.md");
    expect(mock.body).toContain("## 60分钟流程");
    expect(mock.body).toContain("## 五种类型的最小题组");
    expect(mock.body).toContain("当前尚无本人闭卷成绩");
  }
});
