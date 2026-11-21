import { Card, CardContent, CardHeader, CardTitle, cn } from '@ggbdpq/console-ui'

interface PatchStep {
  target: {
    type: string
    fileType: string
    path?: string
  }
  op: 'set' | 'delete'
  path: string
  value?: unknown
  oldValue?: unknown
  highRisk?: boolean
}

interface DiffViewerProps {
  steps: PatchStep[]
  showHighRiskOnly?: boolean
}

export function DiffViewer({ steps, showHighRiskOnly = false }: DiffViewerProps) {
  const filteredSteps = showHighRiskOnly ? steps.filter((s) => s.highRisk) : steps

  // Group by target
  const groupedSteps = filteredSteps.reduce(
    (acc, step) => {
      const key = `${step.target.type}:${step.target.fileType}`
      if (!acc[key]) {
        acc[key] = []
      }
      acc[key].push(step)
      return acc
    },
    {} as Record<string, PatchStep[]>
  )

  if (filteredSteps.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-muted-foreground">
            {showHighRiskOnly ? '无高风险变更' : '没有待应用的变更'}
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {Object.entries(groupedSteps).map(([target, targetSteps]) => (
        <Card key={target}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-mono">{target}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {targetSteps.map((step, index) => (
                <DiffLine key={index} step={step} />
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function DiffLine({ step }: { step: PatchStep }) {
  const isDelete = step.op === 'delete'
  const bgColor = isDelete ? 'bg-destructive/10' : 'bg-success/10'
  const textColor = isDelete ? 'text-destructive' : 'text-success'
  const prefix = isDelete ? '-' : '+'

  return (
    // ponytail: 高风险用整圈警示边框表达，不用侧边条
    <div
      className={cn(
        'rounded px-3 py-2 font-mono text-sm',
        bgColor,
        step.highRisk ? 'border border-warning' : '',
      )}
    >
      <div className="flex items-start gap-2">
        <span className={cn(textColor, 'font-bold w-4 shrink-0')}>{prefix}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-foreground">{step.path}</span>
            {step.highRisk && (
              <span className="rounded bg-warning/15 px-1.5 py-0.5 text-xs text-warning">
                高风险
              </span>
            )}
          </div>
          {!isDelete && step.value !== undefined && (
            <div className="mt-1 text-muted-foreground text-xs">
              = {JSON.stringify(step.value)}
            </div>
          )}
          {step.oldValue !== undefined && (
            <div className="mt-1 text-xs text-destructive/70 line-through">
              原值: {JSON.stringify(step.oldValue)}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
