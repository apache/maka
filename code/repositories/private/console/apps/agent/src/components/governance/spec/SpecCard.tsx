/**
 * Spec 卡片组件
 * 显示 Spec 名称与完整性状态
 */
import { useState } from 'react'
import type { SpecDocument } from '@ggbdpq/console-shared'
import { Badge } from '@ggbdpq/console-ui'
import { Card, CardContent, CardHeader, CardTitle } from '@ggbdpq/console-ui'
import { cn } from '@ggbdpq/console-ui'
import { isSpecComplete, getMissingFiles } from '@/hooks/governance/useSpecData'

export interface SpecCardProps {
  /** Spec 文档数据 */
  spec: SpecDocument
  /** 点击时的回调 */
  onClick?: () => void
  /** 自定义类名 */
  className?: string
}

/**
 * 文件状态图标
 */
function FileStatusIcon({ exists }: { exists: boolean }) {
  return (
    <span className={cn('text-sm', exists ? 'text-success' : 'text-muted-foreground/70')}>
      {exists ? '✓' : '○'}
    </span>
  )
}

/**
 * Spec 卡片组件
 */
export function SpecCard({ spec, onClick, className }: SpecCardProps) {
  const [expanded, setExpanded] = useState(false)
  const complete = isSpecComplete(spec.completeness)
  const missingFiles = getMissingFiles(spec.completeness)

  return (
    <Card
      className={cn(
        'transition-all hover:shadow-lg',
        onClick && 'cursor-pointer hover:border-ring',
        className
      )}
      onClick={onClick}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-mono">{spec.name}</CardTitle>
          <Badge variant={complete ? 'pass' : 'pending'}>{complete ? '完整' : '不完整'}</Badge>
        </div>
        <p className="text-xs text-muted-foreground truncate">{spec.path}</p>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* 文件完整性检查 */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">文档状态</p>
          <div className="grid grid-cols-3 gap-2 text-sm">
            <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-2">
              <FileStatusIcon exists={spec.completeness.hasRequirements} />
              <span className="text-muted-foreground">requirements</span>
            </div>
            <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-2">
              <FileStatusIcon exists={spec.completeness.hasDesign} />
              <span className="text-muted-foreground">design</span>
            </div>
            <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-2">
              <FileStatusIcon exists={spec.completeness.hasTasks} />
              <span className="text-muted-foreground">tasks</span>
            </div>
          </div>
        </div>

        {/* 缺失文件提示 */}
        {missingFiles.length > 0 && (
          <div className="rounded-lg bg-warning/5 border border-warning/30 p-2">
            <p className="text-xs text-warning">
              缺失: {missingFiles.join(', ')}
            </p>
          </div>
        )}

        {/* 展开/收起按钮 */}
        {(spec.requirements || spec.design || spec.tasks) && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              setExpanded(!expanded)
            }}
            className="text-xs text-info hover:text-info transition-colors"
          >
            {expanded ? '▲ 收起内容' : '▼ 查看内容'}
          </button>
        )}

        {/* 内容预览 */}
        {expanded && (
          <div className="space-y-3 border-t border-border pt-3">
            {spec.requirements && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">requirements.md</p>
                <pre className="text-xs text-muted-foreground bg-muted/50 rounded p-2 overflow-x-auto max-h-32 overflow-y-auto">
                  {spec.requirements.slice(0, 500)}
                  {spec.requirements.length > 500 ? '...' : ''}
                </pre>
              </div>
            )}
            {spec.design && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">design.md</p>
                <pre className="text-xs text-muted-foreground bg-muted/50 rounded p-2 overflow-x-auto max-h-32 overflow-y-auto">
                  {spec.design.slice(0, 500)}
                  {spec.design.length > 500 ? '...' : ''}
                </pre>
              </div>
            )}
            {spec.tasks && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">tasks.md</p>
                <pre className="text-xs text-muted-foreground bg-muted/50 rounded p-2 overflow-x-auto max-h-32 overflow-y-auto">
                  {spec.tasks.slice(0, 500)}
                  {spec.tasks.length > 500 ? '...' : ''}
                </pre>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
