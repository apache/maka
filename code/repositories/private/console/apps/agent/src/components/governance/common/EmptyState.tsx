/**
 * 空状态组件
 * 用于显示无数据或空列表的占位
 */
import { cn } from '@ggbdpq/console-ui'

export interface EmptyStateProps {
  /** 标题 */
  title: string
  /** 描述信息 */
  description?: string
  /** 图标（React 节点） */
  icon?: React.ReactNode
  /** 自定义类名 */
  className?: string
  /** 子元素（如操作按钮） */
  children?: React.ReactNode
}

/**
 * 空状态展示组件
 */
export function EmptyState({
  title,
  description,
  icon,
  className,
  children,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center py-12 text-center',
        className
      )}
    >
      {icon && (
        <div className="mb-4 text-muted-foreground">
          {icon}
        </div>
      )}
      <h3 className="text-lg font-medium text-foreground">{title}</h3>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
      {children && <div className="mt-4">{children}</div>}
    </div>
  )
}
