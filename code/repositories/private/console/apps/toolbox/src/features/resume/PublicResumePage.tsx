"use client"

import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { ArrowLeft, Printer } from "lucide-react"
import { Button } from "@ggbdpq/console-ui"
import { ResumeSheets } from "@/features/resume/components/preview/ResumeSheets"
import { useResumeStore } from "@/features/resume/store/resume-store"

/** 公开预览：渲染指定（或当前激活）简历文档，打印只出 A4 纸面 */
export function PublicResumePage() {
  const id = useSearchParams().get("id")
  const docs = useResumeStore((s) => s.docs)
  const activeId = useResumeStore((s) => s.activeId)
  const doc = docs.find((d) => d.id === id) ?? docs.find((d) => d.id === activeId) ?? docs[0]

  if (!doc) return null

  return (
    <div className="bg-muted">
      <div className="no-print mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <Link
          href="/resume"
          className="flex items-center gap-1 text-xs text-muted-foreground/80 hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> 返回列表
        </Link>
        <p className="text-sm text-muted-foreground">{doc.name} · 公开预览</p>
        <div className="flex items-center gap-4">
          <Link
            href={`/resume/editor?id=${doc.id}`}
            className="text-xs text-muted-foreground/80 hover:text-foreground"
          >
            编辑这份简历
          </Link>
          <Button onClick={() => window.print()}>
            <Printer className="size-4" /> 打印 / 导出 PDF
          </Button>
        </div>
      </div>
      <div className="flex justify-center pb-16" id="resume-print-area">
        <ResumeSheets resume={doc.resume} appearance={doc.appearance} />
      </div>
    </div>
  )
}
