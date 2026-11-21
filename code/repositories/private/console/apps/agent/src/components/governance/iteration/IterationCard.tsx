/**
 * Iteration 卡片组件
 * 展示 PRD/Progress/Commit 关联与 isValid 状态
 */
import type { IterationRecord } from '@ggbdpq/console-shared'
import { Badge } from '@ggbdpq/console-ui'
import { Card, CardContent, CardHeader, CardTitle } from '@ggbdpq/console-ui'
import { IterationStepList } from './IterationStepList'
import { cn } from '@ggbdpq/console-ui'

export interface IterationCardProps {
  /** Iteration 数据 */
  iteration: IterationRecord
  /** 自定义类名 */
  className?: string
}

/**
 * 获取优先级 Badge 变体
 */
function getPriorityVariant(priority: string): 'p0' | 'p1' | 'p2' | 'default' {
  switch (priority) {
    case 'P0':
      return 'p0'
    case 'P1':
      return 'p1'
    case 'P2':
      return 'p2'
    default:
      return 'default'
  }
}

/**
 * 格式化日期
 */
function formatDate(date: Date | null): string {
  if (!date) return '-'
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

/**
 * Iteration 卡片组件
 */
export function IterationCard({ iteration, className }: IterationCardProps) {
  return (
    <Card className={cn('transition-shadow hover:shadow-lg', className)}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <span className="font-mono text-info">{iteration.prdId}</span>
            <Badge variant={getPriorityVariant(iteration.priority)}>
              {iteration.priority}
            </Badge>
          </CardTitle>
          <Badge variant={iteration.isValid ? 'pass' : 'pending'}>
            {iteration.isValid ? '有效' : '待验证'}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{iteration.component}</p>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* 步骤状态 */}
        <IterationStepList steps={iteration.steps} />

        {/* 详细信息 */}
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">完成时间</span>
            <p className="text-foreground">{formatDate(iteration.endTime)}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Commit</span>
            <p className="text-foreground font-mono text-xs truncate">
              {iteration.commitHash ?? '-'}
            </p>
          </div>
        </div>

        {/* 备注 */}
        {iteration.notes && (
          <div>
            <span className="text-xs text-muted-foreground">备注</span>
            <p className="text-sm text-muted-foreground mt-1">{iteration.notes}</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
