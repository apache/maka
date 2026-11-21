/**
 * Milestone 分组卡片组件
 * 显示数量/完成数/百分比
 */
import type { Milestone } from '@ggbdpq/console-shared'
import { Badge } from '@ggbdpq/console-ui'
import { Card, CardContent, CardHeader, CardTitle } from '@ggbdpq/console-ui'
import { cn } from '@ggbdpq/console-ui'

export interface MilestoneGroupProps {
  /** Milestone 数据 */
  milestone: Milestone
  /** 点击时的回调 */
  onClick?: () => void
  /** 是否展开显示 PRD 列表 */
  expanded?: boolean
  /** 自定义类名 */
  className?: string
}

/**
 * 获取进度条颜色
 */
function getProgressColor(percentage: number): string {
  if (percentage >= 80) return 'bg-success'
  if (percentage >= 50) return 'bg-info'
  if (percentage >= 20) return 'bg-warning'
  return 'bg-destructive'
}

/**
 * 获取状态文本颜色
 */
function getStatusColor(percentage: number): string {
  if (percentage >= 80) return 'text-success'
  if (percentage >= 50) return 'text-info'
  if (percentage >= 20) return 'text-warning'
  return 'text-destructive'
}

/**
 * Milestone 分组卡片
 */
export function MilestoneGroup({ milestone, onClick, expanded, className }: MilestoneGroupProps) {
  const { name, statistics, prdItems } = milestone
  const percentage = parseInt(statistics.completion.replace('%', ''), 10) || 0

  return (
    <Card
      className={cn(
        'transition-all hover:shadow-lg',
        onClick && 'cursor-pointer hover:border-ring',
        className
      )}
      onClick={onClick}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">{name}</CardTitle>
          <Badge variant={percentage === 100 ? 'pass' : percentage > 0 ? 'pending' : 'blocked'}>
            {statistics.completion}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* 进度条 */}
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">完成进度</span>
            <span className={getStatusColor(percentage)}>{statistics.completion}</span>
          </div>
          <div className="w-full bg-accent rounded-full h-2 overflow-hidden">
            <div
              className={cn('h-2 rounded-full transition-all duration-500', getProgressColor(percentage))}
              style={{ width: `${percentage}%` }}
            />
          </div>
        </div>

        {/* 统计数据 */}
        <div className="grid grid-cols-3 gap-4 text-center text-sm">
          <div className="rounded-lg bg-muted/50 p-2">
            <p className="text-muted-foreground">总数</p>
            <p className="text-lg font-semibold text-foreground">{statistics.total}</p>
          </div>
          <div className="rounded-lg bg-muted/50 p-2">
            <p className="text-muted-foreground">已完成</p>
            <p className="text-lg font-semibold text-success">{statistics.completed}</p>
          </div>
          <div className="rounded-lg bg-muted/50 p-2">
            <p className="text-muted-foreground">待完成</p>
            <p className="text-lg font-semibold text-warning">
              {statistics.total - statistics.completed}
            </p>
          </div>
        </div>

        {/* PRD 列表（展开时显示） */}
        {expanded && prdItems.length > 0 && (
          <div className="border-t border-border pt-3 mt-3">
            <p className="text-xs font-medium text-muted-foreground mb-2">包含的 PRD</p>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {prdItems.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between rounded-lg bg-muted/30 p-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-info">{item.id}</span>
                    <span className="text-xs text-muted-foreground truncate max-w-32">
                      {item.component}
                    </span>
                  </div>
                  <Badge variant={item.passes ? 'pass' : 'pending'} className="text-xs">
                    {item.passes ? '完成' : '进行中'}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
