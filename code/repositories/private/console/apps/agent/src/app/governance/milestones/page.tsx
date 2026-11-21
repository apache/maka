'use client';
/**
 * Milestone 页面 - 多 PRD 聚合视图
 * 按优先级或组件分组展示
 */
import { useState } from 'react'
import { useMilestoneData } from '@/hooks/governance/useMilestoneData'
import { MilestoneGroup } from '@/components/governance/milestone'
import { LoadingState, ErrorState, EmptyState } from '@/components/governance/common'
import { Card, CardContent } from '@ggbdpq/console-ui'
import { cn } from '@ggbdpq/console-ui'
import type { MilestoneGroupBy } from '@ggbdpq/console-shared'

/**
 * Milestone 页面
 */
export default function MilestonePage() {
  const [groupBy, setGroupBy] = useState<MilestoneGroupBy>('priority')
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)
  const { data: milestones, loading, error, reload } = useMilestoneData(groupBy)

  if (loading) {
    return <LoadingState />
  }

  if (error) {
    return <ErrorState message={error} onRetry={reload} />
  }

  if (milestones.length === 0) {
    return (
      <EmptyState title="暂无里程碑数据" description="当前没有可展示的里程碑分组" icon="🏁" />
    )
  }

  // 计算总体统计
  const totalStats = milestones.reduce(
    (acc, m) => ({
      total: acc.total + m.statistics.total,
      completed: acc.completed + m.statistics.completed,
    }),
    { total: 0, completed: 0 }
  )
  const overallPercentage =
    totalStats.total > 0 ? Math.round((totalStats.completed / totalStats.total) * 100) : 0

  return (
    <div className="space-y-6">
      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">里程碑</h1>
        <select
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value as MilestoneGroupBy)}
          className="bg-accent border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="priority">按优先级分组</option>
          <option value="component">按组件分组</option>
        </select>
      </div>

      {/* 总体进度卡片 */}
      <Card className="bg-gradient-to-r from-muted to-background border-border">
        <CardContent className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-foreground">整体完成进度</h2>
              <p className="text-sm text-muted-foreground">
                共 {totalStats.total} 个任务，已完成 {totalStats.completed} 个
              </p>
            </div>
            <div className="text-right">
              <p
                className={cn(
                  'text-3xl font-bold',
                  overallPercentage >= 80
                    ? 'text-success'
                    : overallPercentage >= 50
                      ? 'text-info'
                      : 'text-warning'
                )}
              >
                {overallPercentage}%
              </p>
              <p className="text-xs text-muted-foreground">完成率</p>
            </div>
          </div>

          {/* 总进度条 */}
          <div className="w-full bg-accent rounded-full h-3 overflow-hidden">
            <div
              className={cn(
                'h-3 rounded-full transition-all duration-700',
                overallPercentage >= 80
                  ? 'bg-success'
                  : overallPercentage >= 50
                    ? 'bg-info'
                    : 'bg-warning'
              )}
              style={{ width: `${overallPercentage}%` }}
            />
          </div>
        </CardContent>
      </Card>

      {/* Milestone 分组卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {milestones.map((milestone, index) => (
          <MilestoneGroup
            key={`${milestone.groupBy}-${milestone.name}`}
            milestone={milestone}
            expanded={expandedIndex === index}
            onClick={() => setExpandedIndex(expandedIndex === index ? null : index)}
          />
        ))}
      </div>
    </div>
  )
}
