"use client"

// 简历质量分（R4）：工具栏常驻小徽章 + 分维度详情（纯本地规则，实时派生）。

import { useState } from "react"
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, cn } from "@ggbdpq/console-ui"
import { scoreResume } from "@/features/resume/lib/resume-score"
import { useResumeStore } from "@/features/resume/store/resume-store"

export function ScoreBadge() {
  const resume = useResumeStore((s) => s.resume)
  const lastPages = useResumeStore((s) => s.lastPages)
  const score = scoreResume(resume, { pages: lastPages ?? undefined })
  const [open, setOpen] = useState(false)

  const tone =
    score.total >= 80
      ? "bg-success/15 text-success"
      : score.total >= 60
        ? "bg-warning/15 text-warning"
        : "bg-destructive/15 text-destructive"

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="简历质量分：点击查看分维度详情"
        className={cn(
          "tnum flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold transition-transform hover:scale-105",
          tone,
        )}
      >
        质量分 {score.total}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              简历质量分
              <span className={cn("tnum rounded-full px-2 py-0.5 text-sm", tone)}>
                {score.total} · {score.grade}
              </span>
            </DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            本地规则实时派生（完整性 / 量化率 / 动词强度 / 篇幅 / 多样性），非 ATS 评分。
            {lastPages != null ? `当前预览实际 ${lastPages} 页。` : "篇幅按要点量估算。"}
          </p>
          <ul className="space-y-2.5">
            {score.dimensions.map((d) => (
              <li key={d.key}>
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium text-foreground">{d.label}</span>
                  <span className="tnum text-muted-foreground">
                    {d.score} / {d.max}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      d.score / d.max >= 0.8
                        ? "bg-success"
                        : d.score / d.max >= 0.6
                          ? "bg-warning"
                          : "bg-destructive",
                    )}
                    style={{ width: `${(d.score / d.max) * 100}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{d.advice}</p>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  )
}
