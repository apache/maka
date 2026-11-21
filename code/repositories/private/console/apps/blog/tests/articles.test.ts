import { beforeAll, describe, expect, it } from "vitest";
import { parseFrontmatter } from "@/lib/frontmatter";
import { getAllArticles, getArticleBySlug, getSeriesList } from "@/server/articles";

describe("parseFrontmatter", () => {
  it("解析键值并剥离头部", () => {
    const md = '---\nslug: hello-world\ntitle: "你好:世界"\nseries: "AI 工程实践"\n---\n\n# 正文\n';
    const { data, body } = parseFrontmatter(md);
    expect(data.slug).toBe("hello-world");
    expect(data.title).toBe("你好:世界");
    expect(data.series).toBe("AI 工程实践");
    expect(body).toContain("# 正文");
  });

  it("无 frontmatter 时返回空 data 与原文", () => {
    const { data, body } = parseFrontmatter("# 纯正文\n");
    expect(Object.keys(data)).toHaveLength(0);
    expect(body).toBe("# 纯正文\n");
  });
});

describe("article-repo 双源合一", () => {
  let all: Awaited<ReturnType<typeof getAllArticles>>;
  beforeAll(async () => {
    all = await getAllArticles();
  });

  it("TS 内联源 + md 源全部并入(TS 8 篇 + md 28 篇)", () => {
    expect(all.length).toBe(36);
  });

  it("slug 全局唯一", () => {
    expect(new Set(all.map((a) => a.slug)).size).toBe(all.length);
  });

  it("按日期降序排列", () => {
    const dates = all.map((a) => a.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("md 文章保留来源与系列", async () => {
    const ghost = await getArticleBySlug("v20251211-codexautopipeline");
    expect(ghost).toBeDefined();
    expect(ghost?.source).toBe("ghost-lab");
    expect(ghost?.series).toBe("AI 工程实践");
    expect(ghost?.content).toContain("精华总结");
  });

  it("系列清单包含四个新系列与原三个系列", async () => {
    const names = (await getSeriesList()).map((s) => s.name);
    for (const name of ["AI 工程实践", "Agent Todo 设计笔记", "知识库宪法", "Spec 工作法", "React 19 深入浅出"]) {
      expect(names).toContain(name);
    }
  });
});
