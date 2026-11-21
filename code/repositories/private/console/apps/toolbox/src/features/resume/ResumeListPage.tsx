"use client"

// 简历列表页：多份简历管理（木及式）——缩略图卡片 / 编辑 / 复制 / 删除 / 新建（内容模板）。

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Copy, FileText, Pencil, Plus, Trash2 } from "lucide-react"
import { Button, Card, Dialog, DialogContent, DialogHeader, DialogTitle, cn } from "@ggbdpq/console-ui"
import { ResumePaper } from "@/features/resume/components/preview/ResumePaper"
import { fetchTemplates, type ResumeTemplate } from "@/features/resume/lib/templates"
import { useResumeStore, type ResumeDoc } from "@/features/resume/store/resume-store"

/** A4 缩略图：0.22 倍整页缩放（794→175px 宽） */
function PaperThumb({ doc }: { doc: ResumeDoc }) {
  return (
    <div
      aria-hidden
      className="relative h-[247px] w-[175px] overflow-hidden rounded-md border border-border"
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: "scale(0.22)", width: 794 }}
      >
        <ResumePaper resume={doc.resume} appearance={doc.appearance} />
      </div>
    </div>
  )
}

function formatUpdatedAt(ts: number) {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 单张简历卡：缩略图 + 名称 + 更新时间 + 行内两步删除确认（DESIGN.md §2） */
function ResumeCard({ doc, canDelete }: { doc: ResumeDoc; canDelete: boolean }) {
  const router = useRouter()
  const duplicateResume = useResumeStore((s) => s.duplicateResume)
  const deleteResume = useResumeStore((s) => s.deleteResume)
  const [confirming, setConfirming] = useState(false)

  return (
    <Card className="gap-3 p-4">
          <Link href={`/resume/editor?id=${doc.id}`} aria-label={`编辑「${doc.name}」`} className="block">
            <PaperThumb doc={doc} />
          </Link>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground" title={doc.name}>
              {doc.name}
            </p>
            <p className="tnum mt-0.5 text-xs text-muted-foreground">
              更新于 {formatUpdatedAt(doc.updatedAt)}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="secondary" size="sm" asChild>
              <Link href={`/resume/editor?id=${doc.id}`}>
                <Pencil /> 编辑
              </Link>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const newId = duplicateResume(doc.id)
                if (newId) router.push(`/resume/editor?id=${newId}`)
              }}
            >
              <Copy /> 复制
            </Button>
        {confirming ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            确认删除？
            <button
              type="button"
              aria-label={`确认删除「${doc.name}」`}
              onClick={() => {
                setConfirming(false)
                deleteResume(doc.id)
              }}
              className="grid size-6 place-items-center rounded-sm text-destructive transition hover:bg-destructive/10"
            >
              ✓
            </button>
            <button
              type="button"
              aria-label="取消删除"
              onClick={() => setConfirming(false)}
              className="grid size-6 place-items-center rounded-sm text-muted-foreground transition hover:bg-accent"
            >
              ✗
            </button>
          </span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`删除「${doc.name}」`}
            disabled={!canDelete}
            onClick={() => setConfirming(true)}
          >
            <Trash2 />
          </Button>
        )}
      </div>
    </Card>
  )
}

/** 新建简历：选内容模板（templates.ts）+ 命名，两段式确认 */
function NewResumeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const router = useRouter()
  const createResume = useResumeStore((s) => s.createResume)
  const [templates, setTemplates] = useState<ResumeTemplate[]>([])
  const [templateId, setTemplateId] = useState<string>("blank")
  const [name, setName] = useState("")

  useEffect(() => {
    if (!open) return
    let alive = true
    void fetchTemplates().then((t) => {
      if (alive) setTemplates(t)
    })
    return () => {
      alive = false
    }
  }, [open])

  const handleCreate = async () => {
    const tpl = templates.find((t) => t.id === templateId)
    const resume = tpl ? structuredClone(tpl.resume) : undefined
    if (tpl) {
      // 模板自带主题，切换外观保持一致
      const id = createResume(resume, name.trim() || tpl.name)
      // themeId 跟随模板：创建后写一次外观
      useResumeStore.getState().updateAppearance({ themeId: tpl.themeId })
      onOpenChange(false)
      router.push(`/resume/editor?id=${id}`)
      return
    }
    const id = createResume(undefined, name.trim() || undefined)
    onOpenChange(false)
    router.push(`/resume/editor?id=${id}`)
  }

  const options = [
    { id: "blank", name: "空白简历", description: "从零开始填写" },
    ...templates.map((t) => ({ id: t.id, name: t.name, description: t.description })),
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>新建简历</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="text-sm font-medium text-foreground" htmlFor="new-resume-name">
            简历名称
          </label>
          <input
            id="new-resume-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：前端开发工程师-校招"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/40"
          />
          <div className="flex flex-col gap-1.5">
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => setTemplateId(o.id)}
                aria-pressed={templateId === o.id}
                className={cn(
                  "flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors",
                  templateId === o.id
                    ? "border-primary bg-primary/5 text-foreground"
                    : "border-border hover:bg-accent",
                )}
              >
                <span className="font-medium">{o.name}</span>
                <span className="text-xs text-muted-foreground">{o.description}</span>
              </button>
            ))}
          </div>
          <Button className="self-end" onClick={() => void handleCreate()}>
            <Plus /> 创建并编辑
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ResumeListPage() {
  const docs = useResumeStore((s) => s.docs)
  const [newOpen, setNewOpen] = useState(false)

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">简历管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            共 {docs.length} 份简历 · 点击卡片编辑，打印/导出在编辑器内
          </p>
        </div>
        <Button onClick={() => setNewOpen(true)}>
          <Plus /> 新建简历
        </Button>
      </header>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {docs.map((doc) => (
          <ResumeCard key={doc.id} doc={doc} canDelete={docs.length > 1} />
        ))}
      </div>

      <div className="mt-10 flex items-center gap-2 text-xs text-muted-foreground">
        <FileText className="size-3.5" />
        数据仅保存在本机浏览器（localStorage），导出 JSON/md 可备份
      </div>

      <NewResumeDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  )
}
