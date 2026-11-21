import { z } from "zod";

export const frontmatterSchema = z.object({
  title: z.string().min(1),
  status: z.string().optional(),
  updated: z.string().optional(),
});
export type Frontmatter = z.infer<typeof frontmatterSchema>;

// 四维评分，口径沿用《综合模拟面试》：0 说不清 / 1 有概念缺证据 / 2 机制、边界与验证完整
export const DIMENSIONS = [
  { key: "factual", label: "事实准确" },
  { key: "mechanism", label: "技术机制" },
  { key: "failure", label: "失败路径" },
  { key: "expression", label: "表达结构" },
] as const;

export type DimKey = (typeof DIMENSIONS)[number]["key"];
export type Score = 0 | 1 | 2;

const scoreSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

export const scoresSchema = z.object({
  factual: scoreSchema,
  mechanism: scoreSchema,
  failure: scoreSchema,
  expression: scoreSchema,
});
export type Scores = z.infer<typeof scoresSchema>;

export function minScore(scores: Scores): Score {
  return Math.min(scores.factual, scores.mechanism, scores.failure, scores.expression) as Score;
}

// 练习条目来源：retest=卡点复测，其余对应每日配比与刷题模式
export type ItemKind = "retest" | "p0p1" | "ai" | "design" | "project";

export const KIND_LABEL: Record<ItemKind, string> = {
  retest: "卡点复测",
  p0p1: "P0·P1",
  ai: "AI追问",
  design: "系统设计",
  project: "项目口述",
};

export interface Attempt {
  qid: string;
  date: string; // YYYY-MM-DD
  ts: number;
  kind: ItemKind;
  scores: Scores;
  note: string;
}

export const attemptSchema = z.object({
  qid: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ts: z.number(),
  kind: z.enum(["retest", "p0p1", "ai", "design", "project"]),
  scores: scoresSchema,
  note: z.string(),
});

// 「题」的统一抽象：知识题来自题库 md，项目口述题来自项目地图的 P01–P07
// v2：题目级元数据（标签/难度/频次），旧文档缺省时为空
export interface Question {
  id: string; // `${sectionId}/${title}`
  sectionId: string;
  title: string;
  tags: string[];
  difficulty?: string; // 简单 / 中等 / 困难
  frequency?: string; // 高 / 中 / 低
  points: string; // 旧格式为「回答要点」标签段；F/A/S 题卡保留完整参考正文
  acceptance: string; // 「验收」标签段，可能为空
  bodyMd: string; // 原始正文；无标签的题目（如系统设计 bullets）靠它渲染
}

export interface SectionNote {
  title: string;
  bodyMd: string;
}

export interface BankSection {
  id: string; // 文件名去序号，如 P0-必背
  file: string;
  title: string;
  intro: string;
  notes: SectionNote[];
  questions: Question[];
  candidate: boolean; // 候选题库（待人工审核合入正库），不进任何刷题池
}

export interface DocMeta {
  slug: string; // 文件名去序号去 .md
  title: string;
  file: string;
}

export interface MockDoc extends DocMeta {
  body: string;
}

export interface ProjectCard {
  code: string; // P01
  name: string;
  slug: string; // 对应项目文档 slug
}
