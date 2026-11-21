import { describe, expect, it } from "vitest";
import type { Question } from "@ig/content/types";
import { collectTags, searchQuestions } from "./search";

function q(title: string, tags: string[] = [], points = ""): Question {
  return {
    id: `P0-必背/${title}`,
    sectionId: "P0-必背",
    title,
    tags,
    points,
    acceptance: "",
    bodyMd: points,
  };
}

describe("searchQuestions", () => {
  const pool = [
    q("事件循环", ["JS基础"], "任务队列与微任务"),
    q("闭包", ["JS基础"]),
    q("防抖与节流", ["手写", "性能"]),
  ];

  it("标题命中排在正文命中之前", () => {
    const result = searchQuestions([...pool, q("循环引用", [], "事件循环的坑")], "事件循环");
    expect(result[0].title).toBe("事件循环");
  });

  it("标签也能命中", () => {
    const result = searchQuestions(pool, "手写");
    expect(result.map((x) => x.title)).toContain("防抖与节流");
  });

  it("无命中返回空", () => {
    expect(searchQuestions(pool, "不存在的词")).toEqual([]);
  });
});

describe("collectTags", () => {
  it("按次数降序聚合", () => {
    const bank = [{ questions: [q("a", ["x", "y"]), q("b", ["x"])], candidate: false } as never];
    const tags = collectTags(bank);
    expect(tags[0]).toEqual({ tag: "x", count: 2 });
  });
});
