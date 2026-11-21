import { DIMENSIONS } from "@ig/content/types";
import type { Attempt, ItemKind } from "@ig/content/types";
import type { LookupEntry } from "./lookup";

const KIND_LABEL: Record<ItemKind, string> = {
  retest: "卡点复测",
  p0p1: "P0·P1",
  ai: "AI追问",
  design: "系统设计",
  project: "项目口述",
};

// 导出格式对齐《05-模拟面试记录》的字段：日期 / 原题 / 评分 / 备注
export function attemptsToMarkdown(attempts: Attempt[], lookup: Map<string, LookupEntry>): string {
  const byDate = new Map<string, Attempt[]>();
  for (const a of attempts) {
    const list = byDate.get(a.date) ?? [];
    list.push(a);
    byDate.set(a.date, list);
  }

  const lines: string[] = [
    "# 自练场练习记录",
    "",
    "> 导出自「面试自练场」，仅记录真实练习过程。",
    "",
  ];
  for (const date of [...byDate.keys()].sort().reverse()) {
    lines.push(`## ${date}`, "");
    for (const a of byDate.get(date)!) {
      const entry = lookup.get(a.qid);
      const title = entry ? `${entry.sectionTitle} / ${entry.title}` : a.qid;
      lines.push(`- 原题：${title}（${KIND_LABEL[a.kind]}）`);
      lines.push(`- 评分：${DIMENSIONS.map((d) => `${d.label} ${a.scores[d.key]}`).join(" / ")}`);
      if (a.note.trim()) lines.push(`- 备注：${a.note.trim()}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

export function downloadMarkdown(md: string, filename: string): void {
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
