/**
 * 统计卡片组件
 * 用于 Dashboard 展示核心指标
 */
import { Card, CardContent } from '@ggbdpq/console-ui'
import { cn } from '@ggbdpq/console-ui'

export interface StatCardProps {
  /** 标题 */
  title: string
  /** 数值 */
  value: string | number
  /** 说明文字 */
  description?: string
  /** 颜色变体 */
  variant?: 'default' | 'success' | 'warning' | 'error'
  /** 自定义类名 */
  className?: string
}

const variantStyles = {
  default: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-destructive',
}

/**
 * 统计卡片组件
 */
export function StatCard({
  title,
  value,
  description,
  variant = 'default',
  className,
}: StatCardProps) {
  return (
    <Card className={cn('transition-shadow hover:shadow-lg', className)}>
      <CardContent className="pt-4">
        <p className="text-sm text-muted-foreground">{title}</p>
        <p className={cn('text-2xl font-bold', variantStyles[variant])}>
          {value}
        </p>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        )}
      </CardContent>
    </Card>
  )
}
