/**
 * Iteration 步骤列表组件
 * 展示 select/implement/typecheck/progress/commit 步骤状态
 */
import { cn } from '@ggbdpq/console-ui'

export interface IterationSteps {
  /** 选择 PRD */
  select: boolean
  /** 实现功能 */
  implement: boolean
  /** TypeCheck 通过 */
  typecheck: boolean
  /** 记录 Progress */
  progress: boolean
  /** Git Commit */
  commit: boolean
}

export interface IterationStepListProps {
  /** 步骤状态 */
  steps: IterationSteps
  /** 自定义类名 */
  className?: string
}

const stepLabels = [
  { key: 'select', label: 'Select' },
  { key: 'implement', label: 'Implement' },
  { key: 'typecheck', label: 'TypeCheck' },
  { key: 'progress', label: 'Progress' },
  { key: 'commit', label: 'Commit' },
] as const

/**
 * Iteration 步骤列表组件
 */
export function IterationStepList({ steps, className }: IterationStepListProps) {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      {stepLabels.map(({ key, label }, index) => {
        const isCompleted = steps[key]
        const isLast = index === stepLabels.length - 1

        return (
          <div key={key} className="flex items-center">
            {/* 步骤节点 */}
            <div
              className={cn(
                'flex items-center justify-center',
                'h-8 px-3 rounded-md text-xs font-medium transition-colors',
                isCompleted
                  ? 'bg-success/20 text-success border border-success/30'
                  : 'bg-accent/50 text-muted-foreground border border-border/60'
              )}
            >
              {isCompleted ? '✓' : '○'} {label}
            </div>

            {/* 连接线 */}
            {!isLast && (() => {
              const nextStep = stepLabels[index + 1]
              const nextCompleted = nextStep ? steps[nextStep.key] : false
              return (
                <div
                  className={cn(
                    'w-4 h-0.5',
                    isCompleted && nextCompleted
                      ? 'bg-success/30'
                      : 'bg-secondary/30'
                  )}
                />
              )
            })()}
          </div>
        )
      })}
    </div>
  )
}
