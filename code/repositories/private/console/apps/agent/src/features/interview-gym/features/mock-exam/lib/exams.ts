import { seededShuffle, hashString } from "@ig/lib/rng";
import { poolQuestionIds } from "@ig/state/session";
import type { PoolKey } from "@ig/state/session";
import type { BankSection, ItemKind, ProjectCard } from "@ig/content/types";
import type { SessionItem } from "@ig/state/session";

// 五个既有模拟入口的计时配置，参考同一份合并说明；
// 题量是文档里环节规模的量化（如「15分钟：事件循环、闭包、TS缩窄」≈ 3 题 15 分钟）
export interface ExamSegment {
  label: string;
  pool: PoolKey;
  count: number;
  minutes: number;
}

export interface ExamConfig {
  slug: string;
  title: string;
  intro: string;
  segments: ExamSegment[];
}

export const EXAMS: ExamConfig[] = [
  {
    slug: "基础能力面试",
    title: "基础能力模拟卷",
    intro: "15 分钟 JS/TS 基础 → 20 分钟 React 与竞态 → 15 分钟网络与权限 → 10 分钟复盘一个反例。",
    segments: [
      { label: "JS 与 TS 基础", pool: "p0p1", count: 3, minutes: 15 },
      { label: "Effect、状态所有权与竞态", pool: "p0p1", count: 3, minutes: 20 },
      { label: "网络缓存与前后端权限", pool: "p0p1", count: 3, minutes: 15 },
      { label: "复盘一个反例", pool: "all", count: 1, minutes: 10 },
    ],
  },
  {
    slug: "AI项目深挖",
    title: "AI 项目深挖卷",
    intro: "先项目口述，再 AI 工程追问；每答必落到本人职责与证据。",
    segments: [
      { label: "项目口述", pool: "project", count: 2, minutes: 20 },
      { label: "AI 工程追问", pool: "ai", count: 4, minutes: 25 },
    ],
  },
  {
    slug: "系统设计面试",
    title: "系统设计模拟卷",
    intro: "按「需求澄清 → 数据与状态 → 最小架构 → 失败路径 → 权衡 → 验收」的顺序作答。",
    segments: [{ label: "系统设计", pool: "design", count: 3, minutes: 45 }],
  },
  {
    slug: "实战编码面试",
    title: "实战编码模拟卷",
    intro: "按合并说明选择一个小问题，口述最小实现与失败检查；当前按需材料没有独立可抽题题池。",
    segments: [{ label: "手写代码", pool: "coding", count: 4, minutes: 40 }],
  },
  {
    slug: "综合与HR面试",
    title: "综合与 HR 模拟卷",
    intro: "全库混抽，练表达结构与取舍叙事。",
    segments: [{ label: "综合混抽", pool: "all", count: 5, minutes: 30 }],
  },
];

export function examBySlug(slug: string): ExamConfig | undefined {
  return EXAMS.find((e) => e.slug === slug);
}

function kindOf(qid: string): ItemKind {
  if (qid.startsWith("project/")) return "project";
  if (qid.includes("系统设计")) return "design";
  if (qid.includes("AI")) return "ai";
  return "p0p1";
}

// 每段从对应题池随机抽 count 题（同一次开考内确定），拼成整卷
export function buildExamItems(
  exam: ExamConfig,
  bank: BankSection[],
  projectCards: ProjectCard[],
): { items: SessionItem[]; segmentOf: (index: number) => string } {
  const items: SessionItem[] = [];
  const segmentIndex: number[] = [];
  exam.segments.forEach((seg, segIdx) => {
    const ids = seededShuffle(
      poolQuestionIds(bank, seg.pool, projectCards),
      hashString(`${exam.slug}:${Date.now()}`),
    );
    const picked = ids.slice(0, seg.count);
    picked.forEach((qid) => {
      items.push({ qid, kind: kindOf(qid) });
      segmentIndex.push(segIdx);
    });
  });
  return {
    items,
    segmentOf: (index) => exam.segments[segmentIndex[index]]?.label ?? "",
  };
}
