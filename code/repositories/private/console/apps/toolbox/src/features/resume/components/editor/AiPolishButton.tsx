"use client"

// AI 润色（R5）：润色此条目 / 生成三段式草稿 → 对比预览 → 采纳覆盖。
// key 未配置时按钮禁用并指引（G5-45）；简历内容会发往 DeepSeek（G5-49 UI 明示）。

import { useEffect, useState } from "react"
import { Sparkle } from "lucide-react"
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from "@ggbdpq/console-ui"
import type { Entry } from "@/features/resume/lib/resume-schema"
import { cn } from "@ggbdpq/console-ui"

type Action = "polish" | "draft"

export function AiPolishButton({
  entry,
  onApply,
}: {
  entry: Entry
  onApply: (md: string) => void
}) {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState<Action | null>(null)
  const [suggestion, setSuggestion] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch("/api/resume/polish")
      .then((r) => r.json())
      .then((d: { available?: boolean }) => {
        if (alive) setAvailable(Boolean(d.available))
      })
      .catch(() => {
        if (alive) setAvailable(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const run = async (action: Action) => {
    setLoading(action)
    setError(null)
    setSuggestion(null)
    try {
      const r = await fetch("/api/resume/polish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, text: entry.body, title: entry.title, subtitle: entry.subtitle }),
      })
      const d = (await r.json()) as { ok: boolean; text?: string; error?: string }
      if (d.ok && d.text) {
        setSuggestion(d.text)
      } else {
        setError(d.error ?? "请求失败")
      }
    } catch {
      setError("网络错误")
    } finally {
      setLoading(null)
    }
  }

  const disabled = available === false

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-1.5 text-xs"
        disabled={disabled || loading !== null}
        title={
          available === false
            ? "需在 apps/console/.env.local 配置 DEEPSEEK_API_KEY 后可用"
            : "AI 只改表达不编造事实；简历内容将发往 DeepSeek"
        }
        onClick={() => {
          setSuggestion(null)
          setError(null)
          setOpen(true)
        }}
      >
        <Sparkle className="size-3.5" /> AI
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>AI 助手</DialogTitle>
          </DialogHeader>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void run("polish")} disabled={loading !== null || !entry.body.trim()}>
              {loading === "polish" ? "润色中…" : "润色此条目"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void run("draft")} disabled={loading !== null}>
              {loading === "draft" ? "生成中…" : "生成三段式草稿"}
            </Button>
            <span className="ml-auto self-center text-[10px] text-muted-foreground">
              内容将发送至 DeepSeek；只改表达不编造事实
            </span>
          </div>
          {error && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
          {suggestion && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">当前内容</p>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2.5 text-xs">
                  {entry.body || "（空）"}
                </pre>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">AI 建议</p>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-primary/30 bg-primary/5 p-2.5 text-xs">
                  {suggestion}
                </pre>
              </div>
              <Button
                className="sm:col-span-2"
                onClick={() => {
                  onApply(suggestion)
                  setOpen(false)
                }}
              >
                采纳并覆盖条目内容
              </Button>
            </div>
          )}
          {available === false && (
            <p className={cn("text-xs text-muted-foreground")}>
              启用方式：复制 apps/console/.env.example 为 .env.local，填入 DEEPSEEK_API_KEY，重启 dev。
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
