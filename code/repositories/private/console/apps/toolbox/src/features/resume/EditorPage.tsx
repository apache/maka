"use client"

import { Suspense, useDeferredValue, useEffect, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import { cn } from "@ggbdpq/console-ui"
import { EditorPanel } from "@/features/resume/components/editor/EditorPanel"
import { EditorToolbar } from "@/features/resume/components/editor/EditorToolbar"
import { ResumeSheets } from "@/features/resume/components/preview/ResumeSheets"
import { useResumeStore } from "@/features/resume/store/resume-store"

const PANEL_MIN = 320
const PANEL_MAX = 760
const PANEL_DEFAULT = 420
const PANEL_STORAGE_KEY = "resume-editor-panel-width"

function EditorSurface() {
  const resume = useResumeStore((s) => s.resume)
  const appearance = useResumeStore((s) => s.appearance)
  const switchResume = useResumeStore((s) => s.switchResume)
  const id = useSearchParams().get("id")
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT)
  const [zoom, setZoom] = useState(100)
  const dragging = useRef(false)
  const previewRef = useRef<HTMLElement>(null)
  const [paneWidth, setPaneWidth] = useState(900)

  // 预览自适应：面板变窄时整体缩小，A4 纸始终完整可见
  useEffect(() => {
    const el = previewRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      setPaneWidth(entries[0]!.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // 810 ≈ 794 纸宽 + 阴影/边距余量；fit 后用户缩放仍可放大到 125%
  const fitZoom = Math.min(1, paneWidth / 810)

  // 预览防抖（rerender-use-deferred-value）：滑杆/输入保持即时，重渲染的纸面让路给高优先级更新
  const deferredResume = useDeferredValue(resume)
  const deferredAppearance = useDeferredValue(appearance)

  // 带 ?id 进入时切换激活简历（非法 id 由 switchResume 兜底忽略）
  useEffect(() => {
    if (id) switchResume(id)
  }, [id, switchResume])

  // 恢复上次调宽（SSR 首帧用默认值，挂载后校准）
  useEffect(() => {
    const saved = Number(localStorage.getItem(PANEL_STORAGE_KEY))
    if (saved >= PANEL_MIN && saved <= PANEL_MAX) setPanelWidth(saved)
  }, [])

  /** 分栏拖宽：pointer 捕获全局 move/up，松手持久化 */
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    dragging.current = true
    const startX = e.clientX
    const startW = panelWidth
    const onMove = (ev: PointerEvent) => {
      if (!dragging.current) return
      setPanelWidth(Math.min(PANEL_MAX, Math.max(PANEL_MIN, startW + ev.clientX - startX)))
    }
    const onUp = () => {
      dragging.current = false
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      setPanelWidth((w) => {
        localStorage.setItem(PANEL_STORAGE_KEY, String(w))
        return w
      })
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col overflow-hidden">
      <div className="no-print">
        <EditorToolbar />
      </div>
      <div className="flex flex-1 overflow-hidden">
        {/* 左：编辑面板（宽度可拖拽调，<lg 隐藏） */}
        <aside
          className="no-print hidden shrink-0 border-r bg-background lg:block"
          style={{ width: panelWidth }}
        >
          <EditorPanel />
        </aside>
        {/* 分栏拖拽手柄（lg 以上出现；双击恢复默认宽度） */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖拽调整编辑面板宽度，双击恢复默认"
          title="拖拽调宽 · 双击复位"
          onPointerDown={startDrag}
          onDoubleClick={() => {
            setPanelWidth(PANEL_DEFAULT)
            localStorage.setItem(PANEL_STORAGE_KEY, String(PANEL_DEFAULT))
          }}
          className="no-print hidden w-1 shrink-0 cursor-col-resize bg-border/50 transition-colors hover:bg-primary/40 lg:block"
        />
        {/* 右：实时预览（消费防抖值；多页/智能一页由 ResumeSheets 处理） */}
        <main
          ref={previewRef}
          className="relative min-w-0 flex-1 overflow-auto bg-muted py-8"
        >
          <div className="no-print absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md border bg-card p-1 text-xs">
            {[75, 100, 125].map((z) => (
              <button
                key={z}
                type="button"
                onClick={() => setZoom(z)}
                className={cn(
                  "rounded px-1.5 py-0.5 transition-colors",
                  zoom === z ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60",
                )}
              >
                {z}%
              </button>
            ))}
          </div>
          <div
            id="resume-print-area"
            className="flex flex-col items-center gap-8"
            style={{ zoom: (fitZoom * zoom) / 100 }}
          >
            <ResumeSheets resume={deferredResume} appearance={deferredAppearance} />
          </div>
        </main>
      </div>
    </div>
  )
}

export function EditorPage() {
  return (
    <Suspense>
      <EditorSurface />
    </Suspense>
  )
}
