/**
 * 页面标题组件
 * 显示页面标题和描述
 */
import { cn } from '@ggbdpq/console-ui'

export interface PageHeaderProps {
  /** 页面标题 */
  title: string
  /** 页面描述 */
  description?: string
  /** 自定义类名 */
  className?: string
  /** 右侧操作区 */
  actions?: React.ReactNode
}

/**
 * 页面标题组件
 */
export function PageHeader({
  title,
  description,
  className,
  actions,
}: PageHeaderProps) {
  return (
    <div className={cn('mb-6 flex items-start justify-between', className)}>
      <div>
        <h1 className="text-2xl font-bold text-foreground">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center space-x-2">{actions}</div>}
    </div>
  )
}
