/** 单个用例的执行结果(执行器返回,尚未与期望值比对)。 */
export interface CaseRun {
  /** 用户函数实际返回值。 */
  actual: unknown;
  /** 用户代码 console.log 捕获的输出。 */
  stdout: string[];
  /** 该用例执行错误(运行时异常);null 表示无错。 */
  error: string | null;
}

/** 执行器入参。 */
export interface RunArgs {
  /** 用户代码。 */
  code: string;
  /** 入口函数名。 */
  entry: string;
  /** 各用例入参(按顺序展开调用入口函数)。 */
  inputs: unknown[][];
  /** 超时(毫秒)。 */
  timeoutMs: number;
}

/** 执行器出参。 */
export interface RunOutcome {
  /** 各用例执行结果(与 inputs 同序)。 */
  results: CaseRun[];
  /** 整体错误(如找不到入口函数/代码语法错误);存在时 results 为空。 */
  error?: string;
}

/** 执行器接口:各语言实现,字典驱动注册。 */
export interface Runner {
  /** 执行用户代码并返回每个用例的运行结果。 */
  run(args: RunArgs): Promise<RunOutcome>;
}
