import { promises as fs } from "node:fs";
import path from "node:path";
import { cache } from "react";
import { problemSchema, type Problem, type ProblemSummary } from "@/schemas/problem";

// 题库唯一入口：content/problems/*.json，zod fail-fast，编号升序

const CONTENT_DIR = path.join(process.cwd(), "content", "problems");

const loadAll = cache(async (): Promise<Problem[]> => {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(CONTENT_DIR);
  } catch {
    return [];
  }
  const problems = await Promise.all(
    entries
      .filter((f) => f.endsWith(".json"))
      .map(async (file) => problemSchema.parse(JSON.parse(await fs.readFile(path.join(CONTENT_DIR, file), "utf8")))),
  );
  return problems.sort((a, b) => Number(a.id) - Number(b.id));
});

export const listProblems = cache(
  async (filter: { difficulty?: string; tag?: string } = {}): Promise<ProblemSummary[]> => {
    const all = await loadAll();
    return all
      .filter((p) => !filter.difficulty || p.difficulty === filter.difficulty)
      .filter((p) => !filter.tag || p.tags.includes(filter.tag))
      .map(({ description: _d, solution: _s, signature: _sig, ...summary }) => summary);
  },
);

export const getProblemBySlug = cache(async (slug: string): Promise<Problem | undefined> => {
  const all = await loadAll();
  return all.find((p) => p.slug === slug);
});

export const getAllProblemSlugs = cache(async (): Promise<string[]> => {
  const all = await loadAll();
  return all.map((p) => p.slug);
});
