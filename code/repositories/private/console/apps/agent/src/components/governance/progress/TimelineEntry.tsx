/**
 * 时间线单条组件
 * 展示 time/prdId/what
 */
import { Badge } from '@ggbdpq/console-ui'
import { cn } from '@ggbdpq/console-ui'

export interface TimelineEntryProps {
  /** 日期时间 */
  datetime: Date | null
  /** PRD ID */
  prdId: string
  /** 优先级 */
  priority: string
  /** What - 做了什么 */
  what: string
  /** 是否展开 */
  expanded?: boolean
  /** 点击展开/折叠回调 */
  onToggle?: () => void
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
  if (!date) return '未知日期'
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * 时间线单条组件
 */
export function TimelineEntry({
  datetime,
  prdId,
  priority,
  what,
  expanded = false,
  onToggle,
  className,
}: TimelineEntryProps) {
  return (
    <div
      className={cn(
        'relative pl-8 pb-6',
        'before:absolute before:left-[11px] before:top-2 before:h-full before:w-0.5 before:bg-accent',
        'last:before:hidden',
        className
      )}
    >
      {/* 时间线节点 */}
      <div className="absolute left-0 top-1.5 h-6 w-6 rounded-full bg-info/20 border-2 border-info flex items-center justify-center">
        <div className="h-2 w-2 rounded-full bg-info" />
      </div>

      {/* 内容 */}
      <div
        className={cn(
          'rounded-lg border border-border bg-muted/50 p-4 transition-colors',
          onToggle && 'cursor-pointer hover:bg-muted'
        )}
        onClick={onToggle}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between gap-4 mb-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-info font-medium">{prdId}</span>
            <Badge variant={getPriorityVariant(priority)}>{priority}</Badge>
          </div>
          <time className="text-xs text-muted-foreground">{formatDate(datetime)}</time>
        </div>

        {/* What */}
        <p className="text-sm text-foreground">{what}</p>

        {/* 展开指示器 */}
        {onToggle && (
          <div className="mt-2 text-xs text-muted-foreground">
            {expanded ? '点击收起详情 ▲' : '点击展开详情 ▼'}
          </div>
        )}
      </div>
    </div>
  )
}
