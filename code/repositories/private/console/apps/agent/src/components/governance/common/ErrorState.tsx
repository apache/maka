/**
 * 错误状态组件
 * 用于显示错误信息和重试操作
 */
import { cn } from '@ggbdpq/console-ui'
import { Button } from '@ggbdpq/console-ui'

export interface ErrorStateProps {
  /** 错误信息 */
  message: string
  /** 重试回调 */
  onRetry?: () => void
  /** 自定义类名 */
  className?: string
}

/**
 * 错误图标
 */
function ErrorIcon() {
  return (
    <svg
      className="h-12 w-12 text-destructive"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
      />
    </svg>
  )
}

/**
 * 错误状态展示组件
 */
export function ErrorState({ message, onRetry, className }: ErrorStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center py-12 text-center',
        className
      )}
    >
      <ErrorIcon />
      <h3 className="mt-4 text-lg font-medium text-foreground">出错了</h3>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      {onRetry && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="mt-4"
        >
          重试
        </Button>
      )}
    </div>
  )
}
