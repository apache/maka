import type { Attempt, BankSection, ItemKind, ProjectCard } from "@ig/content/types";
import { minScore } from "@ig/content/types";
import { hashString, seededShuffle } from "@ig/lib/rng";

// 每日配比，来自《十月冲刺计划》：5 P0/P1 + 3 AI + 1 项目口述 + 1 系统设计 + 卡点复测
export interface SessionConfig {
  p0p1: number;
  ai: number;
  design: number;
  project: number;
  retest: number;
}

export const DEFAULT_CONFIG: SessionConfig = { p0p1: 5, ai: 3, design: 1, project: 1, retest: 5 };

export interface SessionItem {
  qid: string;
  kind: ItemKind;
}

export interface DaySession {
  date: string;
  items: SessionItem[];
  results: Record<number, Attempt>; // 条目下标 → 该题最近一次评分
}

export interface MasteryEntry {
  qid: string;
  min: 0 | 1 | 2; // 最近一次评分的四维最小值
  date: string;
  ts: number;
  count: number;
}

// 全量练习记录 → 每题的最近成绩与练习次数
export function computeMastery(attempts: Attempt[]): Map<string, MasteryEntry> {
  const counts = new Map<string, number>();
  const latest = new Map<string, Attempt>();
  for (const a of attempts) {
    counts.set(a.qid, (counts.get(a.qid) ?? 0) + 1);
    const prev = latest.get(a.qid);
    if (!prev || a.ts >= prev.ts) latest.set(a.qid, a);
  }
  const map = new Map<string, MasteryEntry>();
  for (const [qid, a] of latest) {
    map.set(qid, {
      qid,
      min: minScore(a.scores),
      date: a.date,
      ts: a.ts,
      count: counts.get(qid) ?? 1,
    });
  }
  return map;
}

// 题池：候选区默认不进池（显式开考的编码卷除外）；all 用于顺序/随机刷题
export type PoolKey = "p0p1" | "ai" | "design" | "project" | "all" | "coding";

export function poolQuestionIds(
  bank: BankSection[],
  pool: PoolKey,
  projectCards: ProjectCard[],
): string[] {
  const active = bank.filter((s) => !s.candidate);
  switch (pool) {
    case "p0p1":
      return active
        .filter((s) => s.id.startsWith("P0") || s.id.startsWith("P1"))
        .flatMap((s) => s.questions.map((q) => q.id));
    case "ai":
      return active.find((s) => s.id.startsWith("AI"))?.questions.map((q) => q.id) ?? [];
    case "design":
      return active.find((s) => s.id.startsWith("系统设计"))?.questions.map((q) => q.id) ?? [];
    case "project":
      return projectCards.map((p) => `project/${p.code}`);
    case "coding":
      // 编码卷是显式开考动作，允许带候选区的手写题
      return bank.filter((s) => s.id.includes("手写")).flatMap((s) => s.questions.map((q) => q.id));
    case "all":
      return active.flatMap((s) => s.questions.map((q) => q.id));
  }
}

// 按练习次数升序抽 n 题：少练的优先，同级用日期种子打乱，保证当天可复现
function pickByLeastTried(
  pool: string[],
  n: number,
  mastery: Map<string, MasteryEntry>,
  seed: string,
): string[] {
  if (pool.length <= n) return pool;
  const buckets = new Map<number, string[]>();
  for (const qid of pool) {
    const count = mastery.get(qid)?.count ?? 0;
    const bucket = buckets.get(count) ?? [];
    bucket.push(qid);
    buckets.set(count, bucket);
  }
  const out: string[] = [];
  for (const count of [...buckets.keys()].sort((a, b) => a - b)) {
    for (const qid of seededShuffle(buckets.get(count)!, hashString(`${seed}:${count}`))) {
      if (out.length >= n) return out;
      out.push(qid);
    }
  }
  return out;
}

export function buildDailyItems(
  bank: BankSection[],
  projectCards: ProjectCard[],
  attempts: Attempt[],
  dateKey: string,
  config: SessionConfig = DEFAULT_CONFIG,
): SessionItem[] {
  const mastery = computeMastery(attempts);
  const items: SessionItem[] = [];
  const used = new Set<string>();

  // 1. 卡点复测：最近一次任一维度 <2，且不是今天练过的，最久没练的优先
  const stuck = [...mastery.values()]
    .filter((m) => m.min < 2 && m.date !== dateKey)
    .sort((a, b) => a.ts - b.ts)
    .slice(0, config.retest);
  for (const m of stuck) {
    items.push({ qid: m.qid, kind: "retest" });
    used.add(m.qid);
  }

  // 2. 知识题三个池
  const pools: Array<{ kind: ItemKind; pool: PoolKey; n: number }> = [
    { kind: "p0p1", pool: "p0p1", n: config.p0p1 },
    { kind: "ai", pool: "ai", n: config.ai },
    { kind: "design", pool: "design", n: config.design },
  ];
  for (const { kind, pool, n } of pools) {
    const ids = poolQuestionIds(bank, pool, projectCards).filter((qid) => !used.has(qid));
    for (const qid of pickByLeastTried(ids, n, mastery, `${dateKey}:${kind}`)) {
      items.push({ qid, kind });
      used.add(qid);
    }
  }

  // 3. 项目口述
  for (const qid of pickByLeastTried(
    poolQuestionIds(bank, "project", projectCards),
    config.project,
    mastery,
    `${dateKey}:project`,
  )) {
    items.push({ qid, kind: "project" });
  }

  return items;
}
