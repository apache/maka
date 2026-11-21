/**
 * 审计链路卡片组件
 * 展示 PRD→Progress→Commit 链路与 integrity 状态
 */
import { useState } from 'react'
import type { AuditTrail, AuditIntegrity } from '@ggbdpq/console-shared'
import { Badge } from '@ggbdpq/console-ui'
import { Card, CardContent, CardHeader, CardTitle } from '@ggbdpq/console-ui'
import { cn } from '@ggbdpq/console-ui'

export interface AuditTrailCardProps {
  /** 审计链路数据 */
  trail: AuditTrail
  /** 点击 PRD 时的回调 */
  onPRDClick?: (prdId: string) => void
  /** 点击 Progress 时的回调 */
  onProgressClick?: (prdId: string) => void
  /** 点击 Commit 时的回调 */
  onCommitClick?: (hash: string) => void
  /** 自定义类名 */
  className?: string
}

/**
 * 获取完整性状态的 Badge 变体
 */
function getIntegrityVariant(integrity: AuditIntegrity): 'pass' | 'pending' | 'blocked' {
  switch (integrity) {
    case 'complete':
      return 'pass'
    case 'partial':
      return 'pending'
    case 'broken':
      return 'blocked'
  }
}

/**
 * 获取完整性状态的中文文本
 */
function getIntegrityText(integrity: AuditIntegrity): string {
  switch (integrity) {
    case 'complete':
      return '完整'
    case 'partial':
      return '部分'
    case 'broken':
      return '断裂'
  }
}

/**
 * 获取完整性状态的颜色
 */
function getIntegrityColor(integrity: AuditIntegrity): string {
  switch (integrity) {
    case 'complete':
      return 'text-success'
    case 'partial':
      return 'text-warning'
    case 'broken':
      return 'text-destructive'
  }
}

/**
 * 格式化日期
 */
function formatDate(date: Date): string {
  return date.toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * 审计链路卡片组件
 */
export function AuditTrailCard({
  trail,
  onPRDClick,
  onProgressClick,
  onCommitClick,
  className,
}: AuditTrailCardProps) {
  const [expanded, setExpanded] = useState(false)
  const { prdItem, progressEntries, gitCommits, integrity } = trail

  return (
    <Card className={cn('transition-shadow hover:shadow-lg', className)}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <button
              onClick={() => onPRDClick?.(prdItem.id)}
              className="font-mono text-info hover:text-info transition-colors"
            >
              {prdItem.id}
            </button>
            <Badge variant={prdItem.passes ? 'pass' : 'pending'}>
              {prdItem.passes ? '已完成' : '进行中'}
            </Badge>
          </CardTitle>
          <Badge variant={getIntegrityVariant(integrity)}>{getIntegrityText(integrity)}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{prdItem.component}</p>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* 链路概览 */}
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">链路:</span>
          <span className={cn('font-medium', getIntegrityColor(integrity))}>
            PRD → {progressEntries.length > 0 ? 'Progress' : '?'} →{' '}
            {gitCommits.length > 0 ? 'Commit' : '?'}
          </span>
        </div>

        {/* 统计信息 */}
        <div className="grid grid-cols-3 gap-4 text-center text-sm">
          <div className="rounded-lg bg-muted/50 p-2">
            <p className="text-muted-foreground">PRD Steps</p>
            <p className="text-lg font-semibold text-foreground">{prdItem.steps?.length ?? 0}</p>
          </div>
          <div className="rounded-lg bg-muted/50 p-2">
            <p className="text-muted-foreground">Progress</p>
            <p className="text-lg font-semibold text-foreground">{progressEntries.length}</p>
          </div>
          <div className="rounded-lg bg-muted/50 p-2">
            <p className="text-muted-foreground">Commits</p>
            <p className="text-lg font-semibold text-foreground">{gitCommits.length}</p>
          </div>
        </div>

        {/* 展开/收起按钮 */}
        {(progressEntries.length > 0 || gitCommits.length > 0) && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-info hover:text-info transition-colors"
          >
            {expanded ? '▲ 收起详情' : '▼ 展开详情'}
          </button>
        )}

        {/* 详情区域 */}
        {expanded && (
          <div className="space-y-3 border-t border-border pt-3">
            {/* Progress 列表 */}
            {progressEntries.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Progress 记录</p>
                <div className="space-y-2">
                  {progressEntries.map((entry, index) => (
                    <button
                      key={index}
                      onClick={() => onProgressClick?.(entry.prdId)}
                      className="w-full text-left rounded-lg bg-muted/30 p-2 hover:bg-muted/50 transition-colors"
                    >
                      <p className="text-sm text-foreground truncate">{entry.what}</p>
                      <p className="text-xs text-muted-foreground">{formatDate(entry.datetime)}</p>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Git Commits 列表 */}
            {gitCommits.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Git Commits</p>
                <div className="space-y-2">
                  {gitCommits.map((commit) => (
                    <button
                      key={commit.sha}
                      onClick={() => onCommitClick?.(commit.sha)}
                      className="w-full text-left rounded-lg bg-muted/30 p-2 hover:bg-muted/50 transition-colors"
                    >
                      <p className="text-sm text-foreground truncate">{commit.message}</p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-mono">{commit.sha.slice(0, 7)}</span>
                        <span>•</span>
                        <span>{formatDate(commit.date)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
