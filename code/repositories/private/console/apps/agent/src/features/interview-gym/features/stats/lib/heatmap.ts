import type { Attempt } from "@ig/content/types";
import { localDateKey } from "@ig/lib/dates";

export interface HeatCell {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
}

// 分档：0 天 / 1–2 次 / 3–5 次 / 6–9 次 / 10+ 次
function levelOf(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (count < 3) return 1;
  if (count < 6) return 2;
  if (count < 10) return 3;
  return 4;
}

// GitHub 式日历热力图：周一为每周首行，默认展示 26 周
export function buildHeatmap(attempts: Attempt[], weeks = 26): HeatCell[] {
  const byDate = new Map<string, number>();
  for (const a of attempts) byDate.set(a.date, (byDate.get(a.date) ?? 0) + 1);

  const today = new Date();
  const cells: HeatCell[] = [];
  // 从本周周一往回推 (weeks-1) 周，补齐到整周
  const monday = new Date(today);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const start = new Date(monday);
  start.setDate(start.getDate() - (weeks - 1) * 7);

  const cursor = new Date(start);
  while (cursor <= today) {
    const date = localDateKey(cursor);
    const count = byDate.get(date) ?? 0;
    cells.push({ date, count, level: levelOf(count) });
    cursor.setDate(cursor.getDate() + 1);
  }
  return cells;
}

// 连续练习天数：从今天（或昨天）往前数有练习记录的天数
export function currentStreak(attempts: Attempt[]): number {
  const dates = new Set(attempts.map((a) => a.date));
  const cursor = new Date();
  if (!dates.has(localDateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (dates.has(localDateKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export function attemptTotals(attempts: Attempt[]): {
  count: number;
  days: number;
  questions: number;
} {
  const dates = new Set<string>();
  const questions = new Set<string>();
  for (const a of attempts) {
    dates.add(a.date);
    questions.add(a.qid);
  }
  return { count: attempts.length, days: dates.size, questions: questions.size };
}
