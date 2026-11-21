/**
 * 最近迭代卡片组件
 * 展示最近 5 条 progress 记录
 */
import { Card, CardHeader, CardTitle, CardContent } from '@ggbdpq/console-ui'
import { Badge } from '@ggbdpq/console-ui'
import type { ProgressEntry } from '@ggbdpq/console-shared'

export interface RecentIterationsCardProps {
  /** Progress 条目列表 */
  entries: readonly ProgressEntry[]
  /** 最多显示条数 */
  limit?: number
  /** 自定义类名 */
  className?: string
}

/**
 * 最近迭代卡片
 */
export function RecentIterationsCard({
  entries,
  limit = 5,
  className,
}: RecentIterationsCardProps) {
  const recentEntries = entries.slice(0, limit)

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>最近迭代</CardTitle>
      </CardHeader>
      <CardContent>
        {recentEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无迭代记录</p>
        ) : (
          <div className="space-y-3">
            {recentEntries.map((entry, index) => (
              <IterationEntry key={`${entry.prdId}-${index}`} entry={entry} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

interface IterationEntryProps {
  entry: ProgressEntry
}

function IterationEntry({ entry }: IterationEntryProps) {
  const priorityVariant = entry.priority.toLowerCase() as 'p0' | 'p1' | 'p2'

  return (
    <div className="flex items-start gap-3 rounded-md border border-border bg-muted/50 p-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{entry.prdId}</span>
          <Badge variant={priorityVariant}>{entry.priority}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground truncate">{entry.what}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {entry.datetime.toLocaleString('zh-CN')}
        </p>
      </div>
    </div>
  )
}
