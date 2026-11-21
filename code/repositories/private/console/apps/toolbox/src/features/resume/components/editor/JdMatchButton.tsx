"use client"

// JD 对齐：粘贴目标职位描述 → 技术关键词覆盖分析（词典法，本地离线）。
// 命中 = 简历已有支撑；缺失 = 高频却未体现，按重要度排序提示补写。

import { useMemo, useState } from "react"
import { Target } from "lucide-react"
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, cn } from "@ggbdpq/console-ui"
import {
  extractJdKeywords,
  matchResumeToJd,
  type JdMatchResult,
} from "@/features/resume/lib/jd-match"
import { useResumeStore } from "@/features/resume/store/resume-store"

const JD_STORAGE_KEY = "resume-jd-text"

export function JdMatchButton() {
  const docs = useResumeStore((s) => s.docs)
  const activeId = useResumeStore((s) => s.activeId)
  const [open, setOpen] = useState(false)
  const [jd, setJd] = useState("")
  const [result, setResult] = useState<JdMatchResult | null>(null)

  const analyze = () => {
    const resumeText = JSON.stringify(docs.find((d) => d.id === activeId) ?? docs[0] ?? {})
    setResult(matchResumeToJd(extractJdKeywords(jd), resumeText))
  }

  const openDialog = () => {
    setJd(localStorage.getItem(JD_STORAGE_KEY) ?? "")
    setResult(null)
    setOpen(true)
  }

  const run = () => {
    localStorage.setItem(JD_STORAGE_KEY, jd)
    analyze()
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={openDialog}>
        <Target className="size-4" /> JD 对齐
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>JD 对齐</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            粘贴目标职位描述，分析简历对其中技术关键词的覆盖情况（本地词典分析，内容不出本机）。
          </p>
          <textarea
            rows={6}
            value={jd}
            onChange={(e) => setJd(e.target.value)}
            placeholder="粘贴职位描述（岗位职责 + 任职要求）…"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40"
          />
          <div className="flex items-center justify-between">
            <Button size="sm" onClick={run} disabled={!jd.trim()}>
              分析覆盖情况
            </Button>
            {result && result.total > 0 && (
              <span
                className={cn(
                  "tnum rounded-full px-2.5 py-1 text-xs font-semibold",
                  result.coverage >= 70
                    ? "bg-success/15 text-success"
                    : result.coverage >= 40
                      ? "bg-warning/15 text-warning"
                      : "bg-destructive/15 text-destructive",
                )}
              >
                覆盖率 {result.coverage}%（{result.matched}/{result.total}）
              </span>
            )}
          </div>
          {result && result.total > 0 && (
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {result.keywords.map((k) => (
                <div
                  key={k.term}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-1.5 text-sm"
                >
                  <span className="font-medium text-foreground">
                    {k.term}
                    {k.count > 1 && <span className="ml-1.5 text-xs text-muted-foreground">×{k.count}</span>}
                  </span>
                  {k.matched ? (
                    <span className="text-xs text-success">✓ 简历已体现</span>
                  ) : (
                    <span className="text-xs text-warning">
                      ✗ 未体现——{k.count > 1 ? "高频词，" : ""}考虑补写相关经历或技能
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
