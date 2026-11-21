import { describe, expect, it } from "vitest";
import type { BankSection, Question } from "@ig/content/types";
import { buildDailyItems, computeMastery, poolQuestionIds } from "./session";
import type { Attempt } from "@ig/content/types";

function section(id: string, titles: string[], candidate = false): BankSection {
  return {
    id,
    file: `${id}.md`,
    title: id,
    intro: "",
    notes: [],
    candidate,
    questions: titles.map<Question>((t) => ({
      id: `${id}/${t}`,
      sectionId: id,
      title: t,
      tags: [],
      points: "",
      acceptance: "",
      bodyMd: "",
    })),
  };
}

const bank: BankSection[] = [
  section("P0-必背", ["闭包", "事件循环"]),
  section("P1-重要", ["重排重绘"]),
  section("AI-Agent高频追问", ["多Agent怎么选"]),
  section("系统设计题", ["异步音频任务服务"]),
  section("手写代码题", ["防抖节流"], true), // 候选区
];

const projects = [{ code: "P01", name: "美业智能体平台", slug: "美业智能体平台" }];

function attempt(qid: string, min: 0 | 1 | 2, date: string): Attempt {
  return {
    qid,
    date,
    ts: new Date(`${date}T10:00:00`).getTime(),
    kind: "p0p1",
    scores: { factual: min, mechanism: min, failure: min, expression: min },
    note: "",
  };
}

describe("poolQuestionIds", () => {
  it("候选区不进普通题池", () => {
    expect(poolQuestionIds(bank, "all", projects)).not.toContain("手写代码题/防抖节流");
  });

  it("coding 池显式包含候选区的手写题", () => {
    expect(poolQuestionIds(bank, "coding", projects)).toContain("手写代码题/防抖节流");
  });

  it("project 池来自项目卡", () => {
    expect(poolQuestionIds(bank, "project", projects)).toEqual(["project/P01"]);
  });
});

describe("buildDailyItems", () => {
  it("同一天生成结果可复现", () => {
    const a = buildDailyItems(bank, projects, [], "2026-09-28");
    const b = buildDailyItems(bank, projects, [], "2026-09-28");
    expect(a).toEqual(b);
  });

  it("按配比生成：题池不足时给出全量", () => {
    const items = buildDailyItems(bank, projects, [], "2026-09-28");
    // 知识题池共 3 + 1 + 1 = 5 道，加 1 道项目口述
    expect(items.filter((i) => i.kind === "project")).toHaveLength(1);
    expect(items.filter((i) => i.kind !== "project")).toHaveLength(5);
  });

  it("昨天卡点复测置前，今天的低分不进复测", () => {
    const attempts = [
      attempt("P0-必背/闭包", 0, "2026-09-27"),
      attempt("P1-重要/重排重绘", 1, "2026-09-28"),
    ];
    const items = buildDailyItems(bank, projects, attempts, "2026-09-28");
    expect(items[0].qid).toBe("P0-必背/闭包");
    expect(items[0].kind).toBe("retest");
    expect(items.some((i) => i.qid === "P1-重要/重排重绘" && i.kind === "retest")).toBe(false);
  });
});

describe("computeMastery", () => {
  it("取每题最近一次评分，次数累计", () => {
    const map = computeMastery([
      attempt("P0-必背/闭包", 0, "2026-09-26"),
      attempt("P0-必背/闭包", 2, "2026-09-27"),
    ]);
    const entry = map.get("P0-必背/闭包")!;
    expect(entry.min).toBe(2);
    expect(entry.count).toBe(2);
  });
});
