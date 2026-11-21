import type { CaseRun } from './types';

/** 把任意值格式化为可读字符串(用于 stdout 展示)。 */
function formatArg(arg: unknown): string {
  if (typeof arg === 'object' && arg !== null) {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

/** executeCases 的返回(与 RunOutcome 结构一致,便于 worker 直接 postMessage)。 */
export interface ExecuteResult {
  results: CaseRun[];
  error?: string;
}

/**
 * 在当前作用域执行用户代码,逐用例调用入口函数,返回每个用例的结果。
 *
 * 纯执行逻辑(无 Worker 依赖):既被 Worker 调用以获得隔离,也可在 Node 单测中直接验证。
 * entry 来自受信任的题目 JSON(非用户输入),拼接安全。
 *
 * @param code - 用户代码。
 * @param entry - 入口函数名。
 * @param inputs - 各用例入参(按顺序展开调用)。
 * @returns 各用例执行结果;若找不到入口函数或代码语法错误,返回 error。
 */
export function executeCases(code: string, entry: string, inputs: unknown[][]): ExecuteResult {
  const results: CaseRun[] = [];
  const logs: string[] = [];

  // 重写 console.log 捕获用户输出,避免污染调用方控制台
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(formatArg).join(' '));

  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function(
      `${code}\n; return typeof ${entry} === 'function' ? ${entry} : null;`,
    );
    const fn = factory();
    if (typeof fn !== 'function') {
      return { results, error: `找不到入口函数: ${entry}` };
    }
    for (const input of inputs) {
      logs.length = 0;
      try {
        const actual = fn(...input);
        results.push({ actual, stdout: [...logs], error: null });
      } catch (err) {
        results.push({
          actual: undefined,
          stdout: [...logs],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { results };
  } catch (err) {
    return { results, error: err instanceof Error ? err.message : String(err) };
  } finally {
    console.log = originalLog;
  }
}
