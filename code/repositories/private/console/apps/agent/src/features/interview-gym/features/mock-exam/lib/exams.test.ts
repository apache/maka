import { describe, expect, it } from "vitest";
import { EXAMS, buildExamItems, examBySlug } from "./exams";

describe("EXAMS", () => {
  it("五套卷 slug 与仓库模拟卷文档对应", () => {
    expect(EXAMS.map((e) => e.slug)).toEqual([
      "基础能力面试",
      "AI项目深挖",
      "系统设计面试",
      "实战编码面试",
      "综合与HR面试",
    ]);
    expect(examBySlug("基础能力面试")).toBeDefined();
    expect(examBySlug("不存在")).toBeUndefined();
  });
});

describe("buildExamItems", () => {
  const bank = [
    {
      id: "P0-必背",
      candidate: false,
      questions: Array.from({ length: 10 }, (_, i) => ({ id: `P0-必背/题${i}` })),
    },
  ] as never;

  const exam = examBySlug("基础能力面试")!;

  it("每段抽满配置题量，分段函数可定位环节", () => {
    const { items, segmentOf } = buildExamItems(exam, bank, []);
    expect(items).toHaveLength(exam.segments.reduce((s, x) => s + x.count, 0));
    expect(segmentOf(0)).toBe(exam.segments[0].label);
  });
});
