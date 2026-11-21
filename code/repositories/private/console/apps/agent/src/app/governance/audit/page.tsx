'use client';
/**
 * Audit 页面 - 审计与可追溯链路
 * PRD → Progress → Commit 三向联查
 */
import { useState } from 'react'
import { useAuditData } from '@/hooks/governance/useAuditData'
import { AuditTrailCard, AuditLinkView } from '@/components/governance/audit'
import { LoadingState, ErrorState, EmptyState } from '@/components/governance/common'
import { Card, CardContent, CardHeader, CardTitle } from '@ggbdpq/console-ui'
import { cn } from '@ggbdpq/console-ui'

type ViewType = 'cards' | 'link'

/**
 * Audit 页面
 */
export default function AuditPage() {
  const { trails, report, warnings, loading, error, reload } = useAuditData()
  const [viewType, setViewType] = useState<ViewType>('cards')

  if (loading) {
    return <LoadingState />
  }

  if (error) {
    return <ErrorState message={error} onRetry={reload} />
  }

  if (trails.length === 0) {
    return (
      <EmptyState title="暂无审计数据" description="当前没有可追溯的 PRD 链路数据" icon="📋" />
    )
  }

  return (
    <div className="space-y-6">
      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">审计链路</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setViewType('cards')}
            className={cn(
              'px-3 py-1.5 text-sm rounded-lg transition-colors',
              viewType === 'cards'
                ? 'bg-primary text-primary-foreground'
                : 'bg-accent text-foreground hover:bg-secondary'
            )}
          >
            卡片视图
          </button>
          <button
            onClick={() => setViewType('link')}
            className={cn(
              'px-3 py-1.5 text-sm rounded-lg transition-colors',
              viewType === 'link'
                ? 'bg-primary text-primary-foreground'
                : 'bg-accent text-foreground hover:bg-secondary'
            )}
          >
            联查视图
          </button>
        </div>
      </div>

      {/* 完整性统计卡片 */}
      {report && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard title="总 PRD 数" value={report.totalPRDs} color="blue" />
          <StatCard title="完整链路" value={report.completeTrails} color="emerald" />
          <StatCard title="部分链路" value={report.partialTrails} color="amber" />
          <StatCard title="断裂链路" value={report.brokenTrails} color="rose" />
        </div>
      )}

      {/* 警告信息 */}
      {warnings.length > 0 && (
        <Card className="border-warning/30 bg-warning/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-warning">警告信息</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm text-warning">
              {warnings.map((warning, index) => (
                <li key={index}>• {warning}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* 视图切换 */}
      {viewType === 'cards' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {trails.map((trail) => (
            <AuditTrailCard key={trail.prdItem.id} trail={trail} />
          ))}
        </div>
      ) : (
        <AuditLinkView trails={trails} />
      )}

      {/* 导出按钮 */}
      <div className="flex gap-4">
        <button className="px-4 py-2 bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg text-sm transition-colors">
          导出 CSV
        </button>
        <button className="px-4 py-2 bg-accent hover:bg-secondary rounded-lg text-sm transition-colors">
          导出 JSON
        </button>
      </div>
    </div>
  )
}

/**
 * 统计卡片组件
 */
function StatCard({
  title,
  value,
  color = 'blue',
}: {
  title: string
  value: number | string
  color?: 'blue' | 'emerald' | 'amber' | 'rose'
}) {
  const colorClasses = {
    blue: 'text-info border-info/30',
    emerald: 'text-success border-success/30',
    amber: 'text-warning border-warning/30',
    rose: 'text-destructive border-destructive/30',
  }

  return (
    <Card className={cn('border', colorClasses[color])}>
      <CardContent className="p-4">
        <p className="text-sm text-muted-foreground">{title}</p>
        <p className={cn('text-2xl font-bold', colorClasses[color].split(' ')[0])}>{value}</p>
      </CardContent>
    </Card>
  )
}
