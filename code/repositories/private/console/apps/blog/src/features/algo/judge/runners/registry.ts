import type { Runner } from './types';
import { javascriptRunner } from './javascript';
import { pythonRunner } from './python';

/** 语言 → 执行器(字典驱动,新增语言在此注册,业务代码零改动)。 */
const RUNNERS: Record<string, Runner> = {
  javascript: javascriptRunner,
  python: pythonRunner,
};

/**
 * 取指定语言的执行器。
 *
 * @param language - 语言键(如 'javascript'、'python')。
 * @returns 对应执行器。
 * @throws 不支持的语言时抛错。
 */
export function getRunner(language: string): Runner {
  const runner = RUNNERS[language];
  if (!runner) throw new Error(`不支持的判题语言: ${language}`);
  return runner;
}
