'use client';

import { Play } from 'lucide-react';
import { Button } from '@ggbdpq/console-ui';
import { cn } from '@ggbdpq/console-ui';
import type { Problem } from '@/features/algo/types/problem';
import { SUPPORTED_LANGUAGES, LANGUAGE_LABELS, MONACO_LANGUAGE } from '@/features/algo/constants/languages';
import { useJudge } from './index.hook';
import { CodeEditor } from './components/code-editor';
import { ResultPanel } from './components/result-panel';

interface JudgePanelProps {
  problem: Problem;
}

/** 判题面板:语言切换 + 代码编辑器 + 运行按钮 + 结果展示。 */
export function JudgePanel({ problem }: JudgePanelProps) {
  const { language, code, setCode, changeLanguage, run, running, result, error } = useJudge(problem);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-bold tracking-tight">
          <span className="size-1.5 rounded-full bg-primary" aria-hidden />
          编写代码并判题
        </h2>
        <div className="flex items-center gap-2">
          <div
            className="inline-flex rounded-lg border border-border bg-card/50 p-0.5"
            role="group"
            aria-label="选择语言"
          >
            {SUPPORTED_LANGUAGES.map((lang) => (
              <button
                key={lang}
                type="button"
                onClick={() => changeLanguage(lang)}
                className={cn(
                  'rounded-md px-2.5 py-0.5 text-xs font-medium transition-colors',
                  language === lang
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {LANGUAGE_LABELS[lang]}
              </button>
            ))}
          </div>
          <Button type="button" size="sm" onClick={run} disabled={running}>
            <Play className="size-3.5" />
            {running ? '运行中…' : '运行'}
          </Button>
        </div>
      </div>
      <CodeEditor
        value={code}
        onChange={setCode}
        language={MONACO_LANGUAGE[language] ?? 'javascript'}
      />
      <div className="overflow-hidden rounded-xl border border-border bg-card/60 backdrop-blur-sm">
        <div className="flex items-center gap-2 border-b border-border/60 px-5 py-3 sm:px-6">
          <span className="size-1.5 rounded-full bg-primary" aria-hidden />
          <span className="text-base font-bold tracking-tight">运行结果</span>
        </div>
        <ResultPanel result={result} running={running} error={error} />
      </div>
    </section>
  );
}
