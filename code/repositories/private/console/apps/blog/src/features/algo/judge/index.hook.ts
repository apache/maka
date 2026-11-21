'use client';

import { useCallback, useEffect, useState } from 'react';
import { getRunner } from './runners/registry';
import { normalizeCompare } from '@/features/algo/lib/judge-utils';
import { buildCodeTemplate } from '@/features/algo/constants/languages';
import { useProgressStore } from '@/features/algo/stores/progress-store';
import { useDraftStore } from '@/features/algo/stores/draft-store';
import { useHydrated } from '@/features/algo/lib/use-hydrated';
import { SITE_CONFIG } from '@/features/algo/config/site';
import type { JudgeResult, Problem } from '@/features/algo/types/problem';

/**
 * 判题 hook:管理语言、代码内容(按语言持久化草稿)、运行状态与结果。
 */
export function useJudge(problem: Problem) {
  const hydrated = useHydrated();
  const [language, setLanguage] = useState<string>(problem.signature.language);
  const [code, setCode] = useState<string>(() =>
    buildCodeTemplate(problem.signature, problem.signature.language),
  );
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<JudgeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mark = useProgressStore((s) => s.mark);

  // 水合后载入当前语言的草稿(SSR/首屏用模板,避免水合不一致)
  useEffect(() => {
    if (hydrated) {
      const d = useDraftStore.getState().drafts[`${problem.id}:${language}`];
      if (d != null) setCode(d);
    }
    // 仅在水合完成时执行一次;语言切换由 changeLanguage 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  /** 切换判题语言:载入该语言的草稿,无则用模板;清空上次结果。 */
  const changeLanguage = useCallback(
    (lang: string) => {
      setLanguage(lang);
      const d = hydrated ? useDraftStore.getState().drafts[`${problem.id}:${lang}`] : null;
      setCode(d ?? buildCodeTemplate(problem.signature, lang));
      setResult(null);
      setError(null);
    },
    [hydrated, problem.id, problem.signature],
  );

  /** 更新代码并持久化草稿(按语言分别保存)。 */
  const updateCode = useCallback(
    (value: string) => {
      setCode(value);
      useDraftStore.getState().setDraft(`${problem.id}:${language}`, value);
    },
    [problem.id, language],
  );

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    // Python 首次需加载 Pyodide,给更长超时
    const timeoutMs =
      language === 'python' ? SITE_CONFIG.pythonJudgeTimeoutMs : SITE_CONFIG.judgeTimeoutMs;
    const start = performance.now();
    try {
      const runner = getRunner(language);
      const inputs = problem.testCases.map((tc) => tc.input);
      const outcome = await runner.run({
        code,
        entry: problem.signature.entry,
        inputs,
        timeoutMs,
      });

      // 整体错误(找不到入口函数 / 语法错误 / 运行时加载失败)
      if (outcome.error) {
        setError(outcome.error);
        mark(problem.id, false);
        return;
      }

      // 逐用例比对实际输出与期望值
      const results = problem.testCases.map((tc, i) => {
        const runResult = outcome.results[i];
        const actual = runResult?.actual;
        const passed = !runResult?.error && normalizeCompare(actual, tc.expected);
        return {
          index: i,
          passed,
          input: tc.input,
          expected: tc.expected,
          actual,
          stdout: runResult?.stdout ?? [],
          error: runResult?.error ?? undefined,
        };
      });
      const passedCount = results.filter((r) => r.passed).length;
      const allPassed = passedCount === results.length && results.length > 0;

      setResult({
        passed: allPassed,
        total: results.length,
        passedCount,
        results,
        durationMs: Math.round(performance.now() - start),
      });
      mark(problem.id, allPassed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      mark(problem.id, false);
    } finally {
      setRunning(false);
    }
  }, [code, language, problem, mark]);

  return { language, code, setCode: updateCode, changeLanguage, run, running, result, error };
}
