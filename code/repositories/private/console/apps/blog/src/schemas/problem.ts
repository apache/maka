import { z } from "zod";

// 迁移自 ggbdpq-site features/algo/schemas/problem（题解判题机不迁，signature 保留展示用）

export const difficultySchema = z.enum(["easy", "medium", "hard"]);
export type Difficulty = z.infer<typeof difficultySchema>;

export const problemSignatureSchema = z.object({
  language: z.string(),
  entry: z.string(),
  params: z.array(z.object({ name: z.string(), type: z.string() })),
  returns: z.string(),
});

/** 题目摘要（列表用） */
export const problemSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  difficulty: difficultySchema,
  tags: z.array(z.string()),
});
export type ProblemSummary = z.infer<typeof problemSummarySchema>;

/** 测试用例（judge 判题用） */
export const testCaseSchema = z.object({
  sample: z.boolean(),
  input: z.array(z.unknown()),
  expected: z.unknown(),
  explanation: z.string().optional(),
});

/** 完整题目 */
export const problemSchema = problemSummarySchema.extend({
  description: z.string(),
  solution: z.string(),
  signature: problemSignatureSchema,
  testCases: z.array(testCaseSchema),
});
export type Problem = z.infer<typeof problemSchema>;

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: "简单",
  medium: "中等",
  hard: "困难",
};
