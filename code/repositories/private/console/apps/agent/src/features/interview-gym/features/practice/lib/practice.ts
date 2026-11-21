import type { Attempt, BankSection, ItemKind, ProjectCard } from "@ig/content/types";
import { hashString, seededShuffle } from "@ig/lib/rng";
import { computeMastery, poolQuestionIds } from "@ig/state/session";
import type { SessionItem } from "@ig/state/session";

export type PracticeMode = "sequential" | "random" | "wrong" | "bookmarked";

export const PRACTICE_MODES: Record<
  PracticeMode | "daily",
  { label: string; description: string }
> = {
  daily: {
    label: "每日配比",
    description: "按《十月冲刺计划》生成：基础 + AI + 口述 + 设计 + 卡点复测",
  },
  sequential: { label: "顺序刷", description: "全库按顺序过一遍，适合地毯式复习" },
  random: { label: "随机刷", description: "全库乱序，检验提取强度" },
  wrong: { label: "只刷错题", description: "最近一次评分有维度低于 2 的题" },
  bookmarked: { label: "只刷收藏", description: "你收藏过的题" },
} as const;

function kindOf(qid: string): ItemKind {
  if (qid.startsWith("project/")) return "project";
  if (qid.includes("系统设计")) return "design";
  if (qid.includes("AI")) return "ai";
  return "p0p1";
}

export function buildModeItems(
  mode: Exclude<PracticeMode, "daily">,
  bank: BankSection[],
  projectCards: ProjectCard[],
  attempts: Attempt[],
  bookmarks: Record<string, number>,
  seed: string,
): SessionItem[] {
  const mastery = computeMastery(attempts);
  switch (mode) {
    case "sequential":
      return poolQuestionIds(bank, "all", projectCards).map((qid) => ({ qid, kind: kindOf(qid) }));
    case "random":
      return seededShuffle(poolQuestionIds(bank, "all", projectCards), hashString(seed)).map(
        (qid) => ({ qid, kind: kindOf(qid) }),
      );
    case "wrong":
      return [...mastery.values()]
        .filter((m) => m.min < 2)
        .sort((a, b) => a.ts - b.ts)
        .map((m) => ({ qid: m.qid, kind: kindOf(m.qid) }));
    case "bookmarked":
      return Object.entries(bookmarks)
        .sort(([, a], [, b]) => b - a)
        .map(([qid]) => ({ qid, kind: kindOf(qid) }));
  }
}
