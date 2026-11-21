"use client"

// 历史快照：编辑前自动入栈（30 秒内合并）+ 手动快照，恢复可回退。

import { useState } from "react"
import { History } from "lucide-react"
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from "@ggbdpq/console-ui"
import { useResumeStore } from "@/features/resume/store/resume-store"

export function HistoryButton() {
  const takeSnapshot = useResumeStore((s) => s.takeSnapshot)
  const restoreSnapshot = useResumeStore((s) => s.restoreSnapshot)
  // selector 必须返回稳定引用：?? [] 会每次生成新数组触发无限更新（zustand v5）
  const history = useResumeStore(
    (s) => s.docs.find((d) => d.id === s.activeId)?.history,
  )
  const list = history ?? []
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <History className="size-4" /> 历史
        {list.length > 0 && (
          <span className="tnum text-xs text-muted-foreground">{list.length}</span>
        )}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>历史快照</DialogTitle>
          </DialogHeader>
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              每次编辑前自动入栈（30 秒内合并），最多 20 条。
            </p>
            <Button size="sm" variant="outline" onClick={() => takeSnapshot("手动快照")}>
              保存当前版本
            </Button>
          </div>
          <ul className="max-h-80 overflow-y-auto text-sm">
            {list.length === 0 && (
              <li className="py-6 text-center text-xs text-muted-foreground">
                暂无快照，继续编辑或点上方按钮保存
              </li>
            )}
            {list.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between rounded-md px-2 py-1.5 transition-colors hover:bg-accent"
              >
                <div>
                  <p className="text-foreground">{s.label}</p>
                  <p className="tnum text-xs text-muted-foreground">
                    {new Date(s.at).toLocaleString("zh-CN")}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => restoreSnapshot(s.id)}>
                  恢复
                </Button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  )
}
