/**
 * 审计链路联查视图
 * 三向联查交互：点击 PRD 显示关联 Progress/Commit
 */
import { useState, useMemo } from 'react'
import type { AuditTrail } from '@ggbdpq/console-shared'
import { Card, CardContent, CardHeader, CardTitle } from '@ggbdpq/console-ui'
import { Badge } from '@ggbdpq/console-ui'
import { cn } from '@ggbdpq/console-ui'

export interface AuditLinkViewProps {
  /** 审计链路列表 */
  trails: readonly AuditTrail[]
  /** 自定义类名 */
  className?: string
}

type ViewMode = 'prd' | 'progress' | 'commit'

/**
 * 审计链路联查视图
 */
export function AuditLinkView({ trails, className }: AuditLinkViewProps) {
  const [selectedPrdId, setSelectedPrdId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('prd')

  // 获取选中的链路
  const selectedTrail = useMemo(() => {
    if (!selectedPrdId) return null
    return trails.find((t) => t.prdItem.id === selectedPrdId) ?? null
  }, [trails, selectedPrdId])

  // PRD 列表
  const prdList = useMemo(() => {
    return trails.map((t) => ({
      id: t.prdItem.id,
      component: t.prdItem.component,
      passes: t.prdItem.passes,
      integrity: t.integrity,
    }))
  }, [trails])

  return (
    <div className={cn('grid grid-cols-1 lg:grid-cols-3 gap-4', className)}>
      {/* PRD 列表 */}
      <Card className="lg:col-span-1">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">PRD 列表</CardTitle>
            <Badge variant="default">{prdList.length}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-1 max-h-96 overflow-y-auto">
            {prdList.map((prd) => (
              <button
                key={prd.id}
                onClick={() => setSelectedPrdId(prd.id)}
                className={cn(
                  'w-full text-left rounded-lg p-2 transition-colors',
                  selectedPrdId === prd.id
                    ? 'bg-info/15 border border-info/50'
                    : 'hover:bg-muted/50'
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm text-info">{prd.id}</span>
                  <Badge
                    variant={
                      prd.integrity === 'complete'
                        ? 'pass'
                        : prd.integrity === 'partial'
                          ? 'pending'
                          : 'blocked'
                    }
                  >
                    {prd.integrity === 'complete'
                      ? '完整'
                      : prd.integrity === 'partial'
                        ? '部分'
                        : '断裂'}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground truncate">{prd.component}</p>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* 详情面板 */}
      <Card className="lg:col-span-2">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              {selectedTrail ? `${selectedTrail.prdItem.id} 链路详情` : '选择 PRD 查看详情'}
            </CardTitle>
            {selectedTrail && (
              <div className="flex gap-1">
                <button
                  onClick={() => setViewMode('prd')}
                  className={cn(
                    'px-2 py-1 text-xs rounded transition-colors',
                    viewMode === 'prd'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-accent text-foreground hover:bg-secondary'
                  )}
                >
                  PRD
                </button>
                <button
                  onClick={() => setViewMode('progress')}
                  className={cn(
                    'px-2 py-1 text-xs rounded transition-colors',
                    viewMode === 'progress'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-accent text-foreground hover:bg-secondary'
                  )}
                >
                  Progress
                </button>
                <button
                  onClick={() => setViewMode('commit')}
                  className={cn(
                    'px-2 py-1 text-xs rounded transition-colors',
                    viewMode === 'commit'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-accent text-foreground hover:bg-secondary'
                  )}
                >
                  Commit
                </button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {!selectedTrail ? (
            <p className="text-muted-foreground text-center py-8">请从左侧选择一个 PRD 查看链路详情</p>
          ) : (
            <div className="space-y-4">
              {/* PRD 视图 */}
              {viewMode === 'prd' && (
                <div className="space-y-3">
                  <div className="rounded-lg bg-muted/50 p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-mono text-info">{selectedTrail.prdItem.id}</span>
                      <Badge variant={selectedTrail.prdItem.passes ? 'pass' : 'pending'}>
                        {selectedTrail.prdItem.passes ? '已完成' : '进行中'}
                      </Badge>
                    </div>
                    <p className="text-sm text-foreground">{selectedTrail.prdItem.component}</p>
                    <p className="text-xs text-muted-foreground mt-2">
                      优先级: {selectedTrail.prdItem.priority}
                    </p>
                  </div>

                  {/* Steps */}
                  {selectedTrail.prdItem.steps && selectedTrail.prdItem.steps.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-2">执行步骤</p>
                      <div className="space-y-1">
                        {selectedTrail.prdItem.steps.map((step, index) => (
                          <div key={index} className="text-sm text-muted-foreground flex items-start gap-2">
                            <span className="text-muted-foreground/70">{index + 1}.</span>
                            <span>{step}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Progress 视图 */}
              {viewMode === 'progress' && (
                <div className="space-y-3">
                  {selectedTrail.progressEntries.length === 0 ? (
                    <p className="text-muted-foreground text-center py-4">无 Progress 记录</p>
                  ) : (
                    selectedTrail.progressEntries.map((entry, index) => (
                      <div key={index} className="rounded-lg bg-muted/50 p-4">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-medium text-foreground">{entry.what}</span>
                          <span className="text-xs text-muted-foreground">
                            {entry.datetime.toLocaleDateString('zh-CN')}
                          </span>
                        </div>
                        {entry.why && <p className="text-xs text-muted-foreground mb-2">{entry.why}</p>}
                        {entry.typecheckResult && (
                          <p className="text-xs text-muted-foreground">
                            TypeCheck: {entry.typecheckResult}
                          </p>
                        )}
                        {entry.commitMessage && (
                          <p className="text-xs text-muted-foreground font-mono mt-1">
                            Commit: {entry.commitMessage}
                          </p>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* Commit 视图 */}
              {viewMode === 'commit' && (
                <div className="space-y-3">
                  {selectedTrail.gitCommits.length === 0 ? (
                    <p className="text-muted-foreground text-center py-4">无 Git Commit 记录</p>
                  ) : (
                    selectedTrail.gitCommits.map((commit) => (
                      <div key={commit.sha} className="rounded-lg bg-muted/50 p-4">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="font-mono text-xs text-info">
                            {commit.sha.slice(0, 7)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {commit.date.toLocaleDateString('zh-CN')}
                          </span>
                        </div>
                        <p className="text-sm text-foreground">{commit.message}</p>
                        <p className="text-xs text-muted-foreground mt-1">作者: {commit.author}</p>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
