/**
 * 时间线列表组件
 * 支持展开/折叠
 */
import { useState } from 'react'
import type { ProgressEntry } from '@ggbdpq/console-shared'
import { TimelineEntry } from './TimelineEntry'
import { TimelineEntryDetail } from './TimelineEntryDetail'

export interface TimelineListProps {
  /** 进度条目列表 */
  entries: readonly ProgressEntry[]
  /** 自定义类名 */
  className?: string
}

/**
 * 时间线列表组件
 */
export function TimelineList({ entries, className }: TimelineListProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  if (entries.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        暂无进度记录
      </div>
    )
  }

  return (
    <div className={className}>
      {entries.map((entry, index) => {
        const id = `${entry.prdId}-${index}`
        const isExpanded = expandedIds.has(id)

        return (
          <div key={id}>
            <TimelineEntry
              datetime={entry.datetime}
              prdId={entry.prdId}
              priority={entry.priority}
              what={entry.what}
              expanded={isExpanded}
              onToggle={() => toggleExpand(id)}
            />
            {isExpanded && (
              <div className="pl-8 -mt-4 mb-6">
                <TimelineEntryDetail
                  why={entry.why}
                  typecheckResult={entry.typecheckResult}
                  commitMessage={entry.commitMessage}
                  next={entry.next}
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
