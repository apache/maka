import type { BankSection, Question } from "@ig/content/types";

// 小语料直接打分检索：标题命中权重最高，其次标签，再次正文。
// 题库到千题级这个方案依然够用，不引搜索库
export function searchQuestions(questions: Question[], query: string): Question[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: Array<{ q: Question; score: number }> = [];
  for (const question of questions) {
    const title = question.title.toLowerCase();
    let score = 0;
    if (title.startsWith(q)) score += 15;
    else if (title.includes(q)) score += 10;
    if (question.tags.some((t) => t.toLowerCase().includes(q))) score += 6;
    if (question.points.toLowerCase().includes(q)) score += 2;
    if (question.acceptance.toLowerCase().includes(q)) score += 2;
    if (question.bodyMd.toLowerCase().includes(q)) score += 1;
    if (score > 0) scored.push({ q: question, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.q);
}

// 全库标签聚合，按出现次数降序
export function collectTags(bank: BankSection[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const section of bank) {
    for (const q of section.questions) {
      for (const tag of q.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}
