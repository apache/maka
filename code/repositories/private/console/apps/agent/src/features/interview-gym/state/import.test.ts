import { expect, it } from "vitest";
import { useArena } from "@ig/state/store";

it("备份任一字段无效时整体拒绝，原练习数据和配置保持", () => {
  useArena.getState().setNote("saved", "保留笔记");
  const before = useArena.getState();
  expect(() =>
    useArena.getState().importData({
      notes: { saved: "不应写入" },
      attempts: [{ qid: "invalid", scores: { factual: 9 } }],
    }),
  ).toThrow();
  const after = useArena.getState();
  expect(after.notes).toEqual(before.notes);
  expect(after.attempts).toEqual(before.attempts);
  expect(after.config).toEqual(before.config);
});

it("完整备份可恢复，缺少字段的旧备份保留未提供的数据", () => {
  const attempt = {
    qid: "P0/test",
    date: "2026-10-03",
    ts: 123,
    kind: "p0p1" as const,
    scores: {
      factual: 2 as const,
      mechanism: 1 as const,
      failure: 0 as const,
      expression: 2 as const,
    },
    note: "复盘",
  };
  const backup = {
    exportedAt: "2026-10-03T00:00:00Z",
    attempts: [attempt],
    config: { p0p1: 2, ai: 1, design: 0, project: 1, retest: 3 },
    bookmarks: { "P0/test": 123 },
    notes: { "P0/test": "笔记" },
    providers: [
      {
        id: "fixture",
        kind: "openai",
        label: "测试",
        baseUrl: "http://localhost:11434/v1",
        apiKey: "",
        model: "fixture",
        viaProxy: true,
      },
    ],
    defaultProviderId: "fixture",
    interviewRounds: 2,
  };
  useArena.getState().importData(backup);
  expect(useArena.getState().attempts).toEqual([attempt]);
  expect(useArena.getState().config).toEqual(backup.config);
  expect(useArena.getState().providers).toEqual(backup.providers);
  expect(useArena.getState().defaultProviderId).toBe("fixture");
  useArena.getState().importData({ notes: { "P0/test": "旧备份笔记" } });
  expect(useArena.getState().notes).toEqual({ "P0/test": "旧备份笔记" });
  expect(useArena.getState().attempts).toEqual([attempt]);
  expect(useArena.getState().config).toEqual(backup.config);
});

it("非法配置、字典和服务商形状均拒绝且不改状态", () => {
  const before = useArena.getState();
  for (const invalid of [
    null,
    [],
    { notes: { q: 5 } },
    { bookmarks: { q: "timestamp" } },
    { config: { p0p1: -1, ai: 1, design: 0, project: 1, retest: 3 } },
    { interviewRounds: 9 },
    { providers: [{ id: "x", kind: "unsupported" }] },
  ]) {
    expect(() => useArena.getState().importData(invalid)).toThrow();
    expect(useArena.getState().notes).toEqual(before.notes);
    expect(useArena.getState().config).toEqual(before.config);
    expect(useArena.getState().providers).toEqual(before.providers);
  }
});
