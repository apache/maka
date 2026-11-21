/**
 * PRD 分布卡片组件
 * 展示 P0/P1/P2 的分布情况
 */
import { Card, CardHeader, CardTitle, CardContent } from '@ggbdpq/console-ui'
import { Badge } from '@ggbdpq/console-ui'
import type { PRDItem } from '@ggbdpq/console-shared'

export interface PRDDistributionCardProps {
  /** PRD 项目列表 */
  items: readonly PRDItem[]
  /** 自定义类名 */
  className?: string
}

/**
 * PRD 分布卡片
 */
export function PRDDistributionCard({
  items,
  className,
}: PRDDistributionCardProps) {
  const p0Items = items.filter((item) => item.priority === 'P0')
  const p1Items = items.filter((item) => item.priority === 'P1')
  const p2Items = items.filter((item) => item.priority === 'P2')

  const p0Completed = p0Items.filter((item) => item.passes).length
  const p1Completed = p1Items.filter((item) => item.passes).length
  const p2Completed = p2Items.filter((item) => item.passes).length

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>PRD 分布</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <DistributionRow
            priority="P0"
            total={p0Items.length}
            completed={p0Completed}
          />
          <DistributionRow
            priority="P1"
            total={p1Items.length}
            completed={p1Completed}
          />
          <DistributionRow
            priority="P2"
            total={p2Items.length}
            completed={p2Completed}
          />
        </div>
      </CardContent>
    </Card>
  )
}

interface DistributionRowProps {
  priority: 'P0' | 'P1' | 'P2'
  total: number
  completed: number
}

function DistributionRow({ priority, total, completed }: DistributionRowProps) {
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant={priority.toLowerCase() as 'p0' | 'p1' | 'p2'}>
            {priority}
          </Badge>
          <span className="text-sm text-muted-foreground">
            {completed} / {total}
          </span>
        </div>
        <span className="text-sm font-medium text-foreground">{percentage}%</span>
      </div>
      <div className="h-2 w-full rounded-full bg-accent">
        <div
          className="h-2 rounded-full bg-info transition-all"
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  )
}
