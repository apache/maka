import type { Content } from "@ig/content/loader";
import type { ProjectCard, Question } from "@ig/content/types";

export interface LookupEntry {
  title: string;
  sectionTitle: string; // 展示用分区名（P0-必背 / AI追问 / 项目口述）
  question?: Question;
  project?: ProjectCard;
}

// qid → 展示信息。知识题 id 形如 "P0-必背/事件循环"，项目题 id 形如 "project/P01"
export function buildLookup(content: Content): Map<string, LookupEntry> {
  const map = new Map<string, LookupEntry>();
  for (const section of content.bank) {
    for (const q of section.questions) {
      map.set(q.id, { title: q.title, sectionTitle: section.title, question: q });
    }
  }
  for (const card of content.projectCards) {
    map.set(`project/${card.code}`, {
      title: `${card.code} ${card.name}`,
      sectionTitle: "项目口述",
      project: card,
    });
  }
  return map;
}
