/**
 * 违规详情组件
 * 展开显示违规详情与建议
 */
import type { ComplianceViolation } from '@ggbdpq/console-shared'
import { cn } from '@ggbdpq/console-ui'

export interface ViolationDetailProps {
  /** 违规列表 */
  violations: readonly ComplianceViolation[]
  /** 自定义类名 */
  className?: string
}

/**
 * 违规详情组件
 */
export function ViolationDetail({ violations, className }: ViolationDetailProps) {
  if (violations.length === 0) {
    return (
      <div className={cn('text-sm text-success', className)}>
        ✓ 无违规
      </div>
    )
  }

  return (
    <div className={cn('space-y-3', className)}>
      {violations.map((violation, index) => (
        <div
          key={index}
          className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg"
        >
          {/* 消息 */}
          <p className="text-sm text-destructive">{violation.message}</p>

          {/* 位置 */}
          {violation.location && (
            <p className="text-xs text-destructive/80 mt-1">
              位置: {violation.location}
            </p>
          )}

          {/* 建议 */}
          {violation.suggestion && (
            <div className="mt-2 pt-2 border-t border-destructive/20">
              <p className="text-xs text-muted-foreground">
                💡 建议: {violation.suggestion}
              </p>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
