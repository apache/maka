"use client"

// 要点范例库（R2）：按章节 × 主题筛选，点击以二级要点插入 body 光标处（追加式）。

import { useState } from "react"
import { Lightbulb } from "lucide-react"
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  cn,
} from "@ggbdpq/console-ui"
import {
  BULLET_LIBRARY,
  BULLET_TOPICS,
  type BulletSection,
  type BulletTopic,
} from "@/features/resume/lib/bullet-library"
import { useBulletFavs } from "@/features/resume/lib/bullet-favs"

export function BulletLibraryButton({
  section,
  onInsert,
}: {
  section: BulletSection
  /** 插入一条范例文本（调用方负责追加到 body） */
  onInsert: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [topic, setTopic] = useState<BulletTopic | "全部">("全部")
  const [onlyFav, setOnlyFav] = useState(false)
  const [sectionFilter, setSectionFilter] = useState<BulletSection | "all">(section)
  const favs = useBulletFavs()
  const toggleFav = useBulletFavs((s) => s.toggle)

  const list = BULLET_LIBRARY.filter(
    (b) =>
      (sectionFilter === "all" || b.section === sectionFilter) &&
      (topic === "全部" || b.topic === topic) &&
      (!onlyFav || favs.ids.includes(b.id)),
  )

  return (
    <>
      <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => setOpen(true)}>
        <Lightbulb className="size-3.5" /> 范例库
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>要点范例库</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            点击范例以二级要点追加到条目；〔量化〕占位请替换为你的真实数据——数字是简历的硬通货。
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {(["all", section, section === "work" ? "project" : "work"] as Array<"all" | BulletSection>).map(
              (s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSectionFilter(s)}
                  aria-pressed={sectionFilter === s}
                  className={cn(
                    "rounded-md border px-2 py-1 text-xs transition-colors",
                    sectionFilter === s
                      ? "border-primary bg-primary/5 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent",
                  )}
                >
                  {s === "all" ? "全部" : s === "work" ? "工作经历" : "项目经历"}
                </button>
              ),
            )}
            <span className="mx-1 h-4 w-px bg-border" />
            {(["全部", ...BULLET_TOPICS] as Array<"全部" | BulletTopic>).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTopic(t)}
                aria-pressed={topic === t}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs transition-colors",
                  topic === t
                    ? "border-primary bg-primary/5 text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent",
                )}
              >
                {t}
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-border" />
            <button
              type="button"
              onClick={() => setOnlyFav((v) => !v)}
              aria-pressed={onlyFav}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                onlyFav
                  ? "border-primary bg-primary/5 text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent",
              )}
            >
              ★ 收藏{favs.ids.length > 0 ? ` ${favs.ids.length}` : ""}
            </button>
          </div>
          <ul className="max-h-80 space-y-1.5 overflow-y-auto">
            {list.map((b) => (
              <li key={b.id} className="relative">
                <button
                  type="button"
                  aria-label="收藏此范例"
                  onClick={() => favs.toggle(b.id)}
                  className={cn(
                    "absolute right-2 top-2 z-10 text-sm leading-none transition-transform hover:scale-125",
                    favs.ids.includes(b.id) ? "text-warning" : "text-muted-foreground/40",
                  )}
                >
                  ★
                </button>
                <button
                  type="button"
                  onClick={() => onInsert(b.text)}
                  className="w-full rounded-md border border-border px-3 py-2 pr-8 text-left text-sm text-foreground transition-colors hover:border-primary/40 hover:bg-accent"
                >
                  {b.text}
                  <span className="ml-2 text-[10px] text-muted-foreground">{b.topic}</span>
                </button>
              </li>
            ))}
            {list.length === 0 && (
              <li className="py-8 text-center text-xs text-muted-foreground">
                {onlyFav ? "还没有收藏的范例（点范例右上角 ★ 收藏）" : "该组合暂无范例"}
              </li>
            )}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  )
}
