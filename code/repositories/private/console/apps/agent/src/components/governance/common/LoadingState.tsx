/**
 * 加载状态组件
 * 提供骨架屏和加载动画
 */
import { cn } from '@ggbdpq/console-ui'

export interface LoadingStateProps {
  /** 自定义类名 */
  className?: string
  /** 骨架屏行数 */
  lines?: number
}

/**
 * 骨架屏单行
 */
function SkeletonLine({ width = '100%' }: { width?: string }) {
  return (
    <div
      className="h-4 animate-pulse rounded bg-accent"
      style={{ width }}
    />
  )
}

/**
 * 加载状态展示组件
 */
export function LoadingState({ className, lines = 3 }: LoadingStateProps) {
  return (
    <div className={cn('space-y-3 py-4', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonLine
          key={i}
          width={i === lines - 1 ? '60%' : '100%'}
        />
      ))}
    </div>
  )
}

/**
 * 加载旋转动画组件
 */
export function LoadingSpinner({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center justify-center py-8', className)}>
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" />
    </div>
  )
}

/**
 * 卡片骨架屏
 */
export function CardSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-lg border border-border bg-muted p-4',
        className
      )}
    >
      <div className="mb-3 h-5 w-1/3 rounded bg-accent" />
      <div className="space-y-2">
        <div className="h-4 rounded bg-accent" />
        <div className="h-4 w-5/6 rounded bg-accent" />
      </div>
    </div>
  )
}
