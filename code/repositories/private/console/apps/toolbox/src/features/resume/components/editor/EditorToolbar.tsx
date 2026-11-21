"use client"

import { useRef, useState } from "react"
import Link from "next/link"
import {
  ArrowLeft,
  Download,
  FileJson,
  FileText,
  Image,
  Printer,
  RotateCcw,
  Sparkles,
  Upload,
} from "lucide-react"
import { Button } from "@ggbdpq/console-ui"
import { cn } from "@ggbdpq/console-ui"
import { Label } from "@ggbdpq/console-ui"
import { Separator } from "@ggbdpq/console-ui"
import { Slider } from "@ggbdpq/console-ui"
import { Switch } from "@ggbdpq/console-ui"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@ggbdpq/console-ui"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@ggbdpq/console-ui"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@ggbdpq/console-ui"
import { downloadText, markdownToResume, resumeToMarkdown } from "@/features/resume/lib/markdown"
import { ThemeMarketButton } from "@/features/resume/components/editor/ThemeMarketDialog"
import { HistoryButton } from "@/features/resume/components/editor/HistoryDialog"
import { ScoreBadge } from "@/features/resume/components/editor/ScoreBadge"
import { JdMatchButton } from "@/features/resume/components/editor/JdMatchButton"
import { useActiveDoc, useResumeStore } from "@/features/resume/store/resume-store"

function AppearanceSliders() {
  const appearance = useResumeStore((s) => s.appearance)
  const updateAppearance = useResumeStore((s) => s.updateAppearance)
  return (
    <div className="hidden items-center gap-5 lg:flex">
      <div className="flex w-36 items-center gap-2">
        <Label className="shrink-0 text-xs text-muted-foreground">字号</Label>
        <Slider
          min={11}
          max={18}
          step={0.5}
          value={[appearance.fontSize]}
          onValueChange={([v]) => updateAppearance({ fontSize: v })}
        />
      </div>
      <div className="flex w-36 items-center gap-2">
        <Label className="shrink-0 text-xs text-muted-foreground">行距</Label>
        <Slider
          min={1.2}
          max={2}
          step={0.05}
          value={[appearance.lineHeight]}
          onValueChange={([v]) => updateAppearance({ lineHeight: v })}
        />
      </div>
      <div className="flex w-36 items-center gap-2">
        <Label className="shrink-0 text-xs text-muted-foreground">页边距</Label>
        <Slider
          min={24}
          max={72}
          step={2}
          value={[appearance.pagePadding]}
          onValueChange={([v]) => updateAppearance({ pagePadding: v })}
        />
      </div>
    </div>
  )
}

function FitSwitch() {
  const fit = useResumeStore((s) => s.appearance.fitToOnePage)
  const showAvatar = useResumeStore((s) => s.appearance.showAvatar)
  const avatarRound = useResumeStore((s) => s.appearance.avatarRound)
  const fontFamily = useResumeStore((s) => s.appearance.fontFamily)
  const updateAppearance = useResumeStore((s) => s.updateAppearance)
  return (
    <div className="hidden items-center gap-4 md:flex">
      <div className="flex items-center gap-2">
        <Switch
          id="fit-one-page"
          checked={fit}
          onCheckedChange={(v) => updateAppearance({ fitToOnePage: v })}
        />
        <Label
          htmlFor="fit-one-page"
          className="flex items-center gap-1 text-xs whitespace-nowrap"
        >
          <Sparkles className="size-3.5 text-warning" />
          智能一页
        </Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id="show-avatar"
          checked={showAvatar}
          onCheckedChange={(v) => updateAppearance({ showAvatar: v })}
        />
        <Label htmlFor="show-avatar" className="flex items-center gap-1 text-xs whitespace-nowrap">
          <Image className="size-3.5 text-muted-foreground" />
          证件照
        </Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id="avatar-round"
          checked={avatarRound}
          onCheckedChange={(v) => updateAppearance({ avatarRound: v })}
          disabled={!showAvatar}
        />
        <Label htmlFor="avatar-round" className="text-xs whitespace-nowrap">
          圆形
        </Label>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id="serif-font"
          checked={fontFamily === "serif"}
          onCheckedChange={(v) => updateAppearance({ fontFamily: v ? "serif" : "sans" })}
        />
        <Label htmlFor="serif-font" className="text-xs whitespace-nowrap">
          衬线
        </Label>
      </div>
    </div>
  )
}

/** 主题强调色快捷换色（木及「可换色」）：跟随主题 / 六个 accent */
function AccentSwatches() {
  const appearance = useResumeStore((s) => s.appearance)
  const updateAppearance = useResumeStore((s) => s.updateAppearance)
  const accents = ["#0969da", "#1a7f37", "#cf222e", "#9a6700", "#8250df", "#e1670e"]
  return (
    <div className="hidden items-center gap-1.5 xl:flex">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label="强调色：跟随主题"
            onClick={() => updateAppearance({ accentOverride: undefined })}
            className={cn(
              "size-5 rounded-full border-2 transition-transform hover:scale-110",
              appearance.accentOverride
                ? "border-border bg-muted"
                : "border-primary ring-2 ring-primary/30",
            )}
          />
        </TooltipTrigger>
        <TooltipContent>跟随主题</TooltipContent>
      </Tooltip>
      {accents.map((c) => (
        <Tooltip key={c}>
          <TooltipTrigger asChild>
            <button
              aria-label={`强调色：${c}`}
              onClick={() => updateAppearance({ accentOverride: c })}
              className={cn(
                "size-5 rounded-full border-2 transition-transform hover:scale-110",
                appearance.accentOverride === c ? "border-foreground ring-2 ring-ring/40" : "border-transparent",
              )}
              style={{ backgroundColor: c }}
            />
          </TooltipTrigger>
          <TooltipContent>强调色 {c}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

/** 三档密度预设（紧凑 / 标准 / 宽松） */
function DensityPresets() {
  const updateAppearance = useResumeStore((s) => s.updateAppearance)
  const presets = [
    { name: "紧凑", v: { fontSize: 12, lineHeight: 1.4, pagePadding: 44 } },
    { name: "标准", v: { fontSize: 12.5, lineHeight: 1.5, pagePadding: 48 } },
    { name: "宽松", v: { fontSize: 13.5, lineHeight: 1.7, pagePadding: 56 } },
  ]
  return (
    <div className="hidden items-center gap-1.5 xl:flex">
      {presets.map((p) => (
        <Button
          key={p.name}
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => updateAppearance(p.v)}
        >
          {p.name}
        </Button>
      ))}
    </div>
  )
}

function ImportExport() {
  const resume = useResumeStore((s) => s.resume)
  const appearance = useResumeStore((s) => s.appearance)
  const importJson = useResumeStore((s) => s.importJson)
  const setResume = useResumeStore((s) => s.setResume)
  const resetAll = useResumeStore((s) => s.resetAll)
  const fileRef = useRef<HTMLInputElement>(null)
  const mdFileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)

  const handleFile = async (file: File) => {
    const text = await file.text()
    const result = importJson(text)
    setError(result.ok ? null : (result.error ?? "导入失败"))
  }

  const handleMdFile = async (file: File) => {
    const text = await file.text()
    try {
      setResume(markdownToResume(text))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Markdown 解析失败")
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void handleFile(f)
          e.target.value = ""
        }}
      />
      <input
        ref={mdFileRef}
        type="file"
        accept="text/markdown,.md"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void handleMdFile(f)
          e.target.value = ""
        }}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <Download className="h-4 w-4" /> 导出
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => window.print()}>
            <Printer className="h-4 w-4" /> 打印 / 导出 PDF
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              downloadText(
                `${resume.profile.name || "resume"}-简历.md`,
                resumeToMarkdown(resume),
                "text/markdown",
              )
            }
          >
            <FileText className="h-4 w-4" /> 导出 Markdown
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              downloadText(
                `${resume.profile.name || "resume"}-简历.json`,
                JSON.stringify({ resume, appearance }, null, 2),
                "application/json",
              )
            }
          >
            <FileJson className="h-4 w-4" /> 导出 JSON（含外观）
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {error && (
        <p role="alert" className="max-w-40 text-xs leading-4 text-destructive">
          {error}
        </p>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <Upload className="size-4" /> 导入
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => fileRef.current?.click()}>
            <FileJson className="size-4" /> 导入 JSON
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => mdFileRef.current?.click()}>
            <FileText className="size-4" /> 导入 Markdown
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog>
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm" className="text-muted-foreground">
            <RotateCcw className="h-4 w-4" /> 重置
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重置简历？</DialogTitle>
            <DialogDescription>
              将恢复为示例简历，当前所有修改都会被清除。建议先导出 JSON 备份。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="destructive" onClick={resetAll}>
              确认重置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function EditorToolbar() {
  const doc = useActiveDoc()
  return (
    <div className="flex h-14 shrink-0 items-center gap-4 border-b bg-background px-4">
      <Link
        href="/resume"
        aria-label="返回简历列表"
        className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> 列表
      </Link>
      <Separator orientation="vertical" className="h-6" />
      <span className="max-w-60 truncate text-sm font-semibold tracking-tight text-foreground" title={doc?.name}>
        {doc?.name ?? "简历编辑器"}
      </span>
      <ScoreBadge />
      <JdMatchButton />
      <Separator orientation="vertical" className="h-6" />
      <ThemeMarketButton />
      <Separator orientation="vertical" className="hidden h-6 lg:block" />
      <DensityPresets />
      <Separator orientation="vertical" className="hidden h-6 lg:block" />
      <AccentSwatches />
      <Separator orientation="vertical" className="hidden h-6 xl:block" />
      <AppearanceSliders />
      <div className="flex-1" />
      <FitSwitch />
      <Separator orientation="vertical" className="hidden h-6 md:block" />
      <HistoryButton />
      <Separator orientation="vertical" className="hidden h-6 md:block" />
      <ImportExport />
    </div>
  )
}
