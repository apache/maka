'use client'
// src/app/components/FilesPane.jsx —— 沙盒文件视图（原 files-view.js 的 React 化，期4）。
//
// 数据来自 vfs 的版本史（getHistory）：每次 write_file / edit 都留了
// before → after。agent 改过什么、怎么改的，一目了然——
// 这就是 coding agent 的"commit 历史"，也是 utils/diff.js 的唯一消费者。
// store.vfsVersion 变化（tool_result / 重置沙盒）时重算。

import { useMemo, useSyncExternalStore } from 'react'
import { CaretRightIcon } from '@phosphor-icons/react'
import * as vfs from '@ggbdpq/agent-lab-core/src/web-utils/vfs.js'
import { diffHunks } from '@ggbdpq/agent-lab-core/src/web-utils/diff.js'

function DiffBlock({ before, after, title }) {
  const hunks = useMemo(() => diffHunks(before, after), [before, after])
  let adds = 0
  let dels = 0
  for (const h of hunks) {
    for (const op of h.ops) {
      if (op.type === 'add') adds++
      else if (op.type === 'del') dels++
    }
  }
  return (
    <div className="mx-2 mb-2 overflow-hidden rounded-chip border border-line-soft bg-lab-base">
      <div className="flex items-center justify-between border-b border-line-soft px-2.5 py-1.5 font-mono text-[11px] text-ink-faint">
        <span>{title}</span>
        {hunks.length > 0 && (
          <span className="flex-none"><span className="text-green">+{adds}</span> <span className="text-red">-{dels}</span></span>
        )}
      </div>
      {hunks.length === 0 && <div className="px-2.5 py-2 text-[11.5px] text-ink-faint">无变化</div>}
      {hunks.map((h, i) => h.ops.map((op, j) => (
        <div
          key={`${i}-${j}`}
          className={`flex px-2.5 font-mono text-[11.5px] leading-relaxed ${
            op.type === 'add' ? 'bg-green/10 text-green'
            : op.type === 'del' ? 'bg-red/10 text-red'
            : 'text-ink-faint'
          }`}
        >
          <span className="w-3 flex-none select-none">{op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' '}</span>
          <span className="whitespace-pre-wrap break-all">{op.text}</span>
        </div>
      )))}
    </div>
  )
}

export default function FilesPane({ store }) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)

  const files = useMemo(
    () => vfs.listFiles().map(path => ({ path, versions: vfs.getHistory(path) })),
    [snap.vfsVersion],
  )

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="flex flex-col gap-2.5">
        {files.map(({ path, versions }) => {
          const changes = versions.length - 1
          return (
            <details
              key={path}
              className={`overflow-hidden rounded-panel border bg-raised${changes > 0 ? ' border-lab-accent/30' : ' border-line'}`}
              open={changes > 0}
            >
              <summary className="flex cursor-pointer select-none items-center gap-1.5 px-2.5 py-2 text-ink-dim transition-colors hover:bg-overlay/40 [&::-webkit-details-marker]:hidden">
                <CaretRightIcon size={12} className="flex-none text-ink-faint transition-transform open:rotate-90" />
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{path}</span>
                {changes > 0 && (
                  <span className="flex-none rounded-chip bg-lab-accent-soft px-1.5 py-0.5 font-mono text-[10.5px] text-lab-accent">
                    {changes} 次修改
                  </span>
                )}
              </summary>
              {/* 改动历史：第 v 版相对第 v-1 版的 diff，一次修改一个块 */}
              {versions.slice(1).map((v, i) => (
                <DiffBlock key={i} before={versions[i].content} after={v.content} title={`改动 #${i + 1} · ${v.tool}`} />
              ))}
              {versions.length > 0 && (
                <>
                  <div className="px-3 pb-1 pt-2 text-[11px] text-ink-faint">{changes > 0 ? '当前内容' : '内容'}</div>
                  <pre className="mx-2 mb-2 overflow-x-auto rounded-chip border border-line-soft bg-lab-base p-2.5 font-mono text-[11.5px] leading-relaxed text-ink-dim">
                    {versions[versions.length - 1].content}
                  </pre>
                </>
              )}
            </details>
          )
        })}
      </div>
    </div>
  )
}
