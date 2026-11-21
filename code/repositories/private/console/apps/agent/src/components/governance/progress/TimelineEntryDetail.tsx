/**
 * 时间线详情组件
 * 展示 why/typecheck/commit/next
 */
import { cn } from '@ggbdpq/console-ui'

export interface TimelineEntryDetailProps {
  /** Why - 为什么这样做 */
  why: string
  /** typecheck 结果 */
  typecheckResult: string
  /** commit message */
  commitMessage: string
  /** 下一步计划 */
  next?: string
  /** 自定义类名 */
  className?: string
}

/**
 * 时间线详情组件
 */
export function TimelineEntryDetail({
  why,
  typecheckResult,
  commitMessage,
  next,
  className,
}: TimelineEntryDetailProps) {
  return (
    <div className={cn('space-y-4 p-4 bg-background/50 rounded-b-lg border-x border-b border-border', className)}>
      {/* Why */}
      {why && (
        <div>
          <h4 className="text-xs font-medium text-muted-foreground uppercase mb-1">
            Why（为什么这样做）
          </h4>
          <p className="text-sm text-foreground">{why}</p>
        </div>
      )}

      {/* typecheck 结果 */}
      {typecheckResult && (
        <div>
          <h4 className="text-xs font-medium text-muted-foreground uppercase mb-1">
            TypeCheck 结果
          </h4>
          <pre className="text-xs text-success bg-background p-2 rounded font-mono overflow-x-auto">
            {typecheckResult}
          </pre>
        </div>
      )}

      {/* Commit Message */}
      {commitMessage && (
        <div>
          <h4 className="text-xs font-medium text-muted-foreground uppercase mb-1">
            Git Commit
          </h4>
          <code className="text-sm text-warning bg-background px-2 py-1 rounded font-mono">
            {commitMessage}
          </code>
        </div>
      )}

      {/* Next */}
      {next && (
        <div>
          <h4 className="text-xs font-medium text-muted-foreground uppercase mb-1">
            下一步计划
          </h4>
          <p className="text-sm text-foreground">{next}</p>
        </div>
      )}
    </div>
  )
}
