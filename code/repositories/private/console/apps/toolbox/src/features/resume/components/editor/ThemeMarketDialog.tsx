"use client"

// 主题市场（木及式）：真实缩略图预览 + 两段式应用（选定→确定才生效）。

import { useState } from "react"
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  cn,
} from "@ggbdpq/console-ui"
import { useResumeStore } from "@/features/resume/store/resume-store"
import { themes } from "@/features/resume/lib/themes"
import { appearanceSchema } from "@/features/resume/lib/resume-schema"
import { sampleResume } from "@/features/resume/lib/sample-resume"
import { ResumePaper } from "@/features/resume/components/preview/ResumePaper"

/** 主题缩略图：0.18 倍整页缩放（794→143px 宽） */
function ThemeThumb({ themeId }: { themeId: string }) {
  const appearance = { ...appearanceSchema.parse({}), themeId }
  return (
    <div
      aria-hidden
      className="relative h-[202px] w-[143px] overflow-hidden rounded-md border border-border bg-white" // style:ok A4 纸张物理白，同 ResumePaper
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: "scale(0.18)", width: 794 }}
      >
        <ResumePaper resume={sampleResume} appearance={appearance} />
      </div>
    </div>
  )
}

export function ThemeMarketDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const current = useResumeStore((s) => s.appearance.themeId)
  const updateAppearance = useResumeStore((s) => s.updateAppearance)
  const [selected, setSelected] = useState<string | null>(null)
  const chosen = selected ?? current

  const apply = () => {
    if (chosen) updateAppearance({ themeId: chosen })
    setSelected(null)
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setSelected(null)
        onOpenChange(v)
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>选择主题</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          主题决定配色与标题排版；纸面内容保持不变。应用前可预览效果。
        </p>
        <div className="grid max-h-[58vh] grid-cols-2 gap-4 overflow-y-auto py-2 sm:grid-cols-4">
          {themes.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSelected(t.id)}
              aria-pressed={chosen === t.id}
              className={cn(
                "flex flex-col items-center gap-2 rounded-lg border p-2 transition-colors",
                chosen === t.id
                  ? "border-primary ring-2 ring-primary/30"
                  : "border-border hover:border-ring/40",
              )}
            >
              <ThemeThumb themeId={t.id} />
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-foreground">{t.name}</span>
                {t.id === current && (
                  <Badge variant="secondary" className="px-1 py-0 text-[10px]">
                    当前
                  </Badge>
                )}
              </div>
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setSelected(null)
              onOpenChange(false)
            }}
          >
            取消
          </Button>
          <Button onClick={apply} disabled={chosen === current}>
            应用主题
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 工具栏触发钮：显示当前主题名 */
export function ThemeMarketButton() {
  const current = useResumeStore((s) => s.appearance.themeId)
  const theme = themes.find((t) => t.id === current)
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        主题 · {theme?.name ?? "默认"}
      </Button>
      <ThemeMarketDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
