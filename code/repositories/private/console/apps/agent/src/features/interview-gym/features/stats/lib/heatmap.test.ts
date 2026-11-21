import { describe, expect, it } from "vitest";
import type { Attempt } from "@ig/content/types";
import { attemptTotals, buildHeatmap, currentStreak } from "./heatmap";

function attemptOn(date: string, times = 1): Attempt[] {
  return Array.from({ length: times }, () => ({
    qid: "P0-必背/x",
    date,
    ts: new Date(`${date}T10:00:00`).getTime(),
    kind: "p0p1" as const,
    scores: { factual: 2, mechanism: 2, failure: 2, expression: 2 },
    note: "",
  }));
}

describe("buildHeatmap", () => {
  it("覆盖到今天为止的整天数，等级按次数分档", () => {
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const cells = buildHeatmap(attemptOn(key, 4));
    expect(cells[cells.length - 1]).toMatchObject({ date: key, count: 4, level: 2 });
    // 六期并入适配：原断言 cells.length % 7 === 0 隐含"今天是周日"（网格周一为首格、截到今天），
    // 一周里六天会挂；改为验证真正的不变量——首格是周一、末格是今天
    expect(new Date(`${cells[0]!.date}T12:00:00`).getDay()).toBe(1);
    expect(cells[cells.length - 1]!.date).toBe(key);
  });

  it("无记录的日子 level 为 0", () => {
    const cells = buildHeatmap([]);
    expect(cells.every((c) => c.level === 0)).toBe(true);
  });
});

describe("currentStreak", () => {
  it("今天没练但从昨天算连续", () => {
    const today = new Date();
    const y = new Date(today);
    y.setDate(y.getDate() - 1);
    const twoDaysAgo = new Date(today);
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const streak = currentStreak([...attemptOn(fmt(y)), ...attemptOn(fmt(twoDaysAgo))]);
    expect(streak).toBeGreaterThanOrEqual(2);
  });
});

describe("attemptTotals", () => {
  it("按日期与题目去重计数", () => {
    const totals = attemptTotals([...attemptOn("2026-09-27", 3), ...attemptOn("2026-09-28", 1)]);
    expect(totals).toEqual({ count: 4, days: 2, questions: 1 });
  });
});
