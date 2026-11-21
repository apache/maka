/**
 * 题目相关领域类型定义。
 *
 * 与 schemas/problem.ts 的 zod schema 同源:schema 用于运行时校验
 * (API 出/入站、JSON 题目文件加载),类型用于编译期与 IDE 提示。
 */

/** 难度等级。 */
export type Difficulty = 'easy' | 'medium' | 'hard';

/** 用户做题状态(仅存在于客户端 zustand,不入题目 JSON)。 */
export type ProblemStatus = 'not-started' | 'attempted' | 'solved';

/** 单条测试用例。 */
export interface TestCase {
  /** 是否为样例(列表/详情页对用户可见);false 表示隐藏用例,仅用于判题。 */
  sample: boolean;
  /** 入参数组,按 signature.params 顺序展开调用入口函数。 */
  input: unknown[];
  /** 期望返回值(JSON 可序列化)。 */
  expected: unknown;
  /** 可选:用例说明(失败时展示,辅助调试)。 */
  explanation?: string;
}

/** 题目函数签名(驱动代码模板生成与函数式判题)。 */
export interface ProblemSignature {
  /** 语言键,如 'javascript'。 */
  language: string;
  /** 入口函数名,如 'twoSum'。 */
  entry: string;
  /** 形参列表。 */
  params: Array<{ name: string; type: string }>;
  /** 返回类型描述。 */
  returns: string;
}

/** 列表页用的轻量摘要(不含题干/答案/测试用例,减小首屏 payload)。 */
export interface ProblemSummary {
  id: string;
  slug: string;
  title: string;
  difficulty: Difficulty;
  tags: string[];
}

/** 完整题目(详情页/判题用)。 */
export interface Problem extends ProblemSummary {
  /** 题干 markdown。 */
  description: string;
  /** 题解 markdown(详情页默认隐藏,点击"查看答案"显示)。 */
  solution: string;
  /** 函数签名。 */
  signature: ProblemSignature;
  /** 全部测试用例(样例 + 隐藏)。 */
  testCases: TestCase[];
}

/** 列表筛选条件。 */
export interface ProblemFilter {
  difficulty?: Difficulty | 'all';
  tag?: string | null;
  query?: string;
}

/** 列表响应。 */
export interface ProblemListResponse {
  items: ProblemSummary[];
  total: number;
}

/** 单个用例的判题结果。 */
export interface JudgeCaseResult {
  /** 用例序号(从 0 开始)。 */
  index: number;
  /** 是否通过。 */
  passed: boolean;
  /** 入参。 */
  input: unknown[];
  /** 期望输出。 */
  expected: unknown;
  /** 实际输出。 */
  actual: unknown;
  /** 用户代码的标准输出(console.log 捕获)。 */
  stdout: string[];
  /** 运行错误信息(抛错/超时/找不到入口函数)。 */
  error?: string;
}

/** 一次提交的总体判题结果。 */
export interface JudgeResult {
  /** 全部用例是否通过。 */
  passed: boolean;
  /** 用例总数。 */
  total: number;
  /** 通过数。 */
  passedCount: number;
  /** 各用例明细。 */
  results: JudgeCaseResult[];
  /** 总耗时(毫秒)。 */
  durationMs: number;
}
