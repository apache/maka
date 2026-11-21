'use client';
/**
 * Dashboard 页面 - 统计与度量仪表盘
 */
import { usePRDData } from '@/hooks/governance/usePRDData'
import { useProgressData } from '@/hooks/governance/useProgressData'
import {
  StatCard,
  BlockedCard,
  PRDDistributionCard,
  RecentIterationsCard,
} from '@/components/governance/dashboard'
import { LoadingState } from '@/components/governance/common'
import { PageHeader } from '@/components/governance/layout/PageHeader'

export default function DashboardPage() {
  const { data: prdData, loading: prdLoading } = usePRDData()
  const { data: progressData, loading: progressLoading } = useProgressData()

  const loading = prdLoading || progressLoading

  if (loading) {
    return (
      <div>
        <PageHeader title="Dashboard" description="统计与度量仪表盘" />
        <LoadingState lines={5} />
      </div>
    )
  }

  const stats = prdData?.statistics
  const items = prdData?.items ?? []

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" description="统计与度量仪表盘" />

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="总体完成度"
          value={stats?.completion ?? '--%'}
          description="PRD 完成百分比"
        />
        <StatCard
          title="PRD 总数"
          value={stats?.total ?? '--'}
          description="全部需求项"
        />
        <StatCard
          title="已完成"
          value={stats?.passing ?? '--'}
          variant="success"
          description="passes: true"
        />
        <StatCard
          title="待完成"
          value={stats?.failing ?? '--'}
          variant="warning"
          description="passes: false"
        />
      </div>

      {/* 阻塞状态 */}
      <BlockedCard blockedReason={stats?.blocked_reason} />

      {/* 两列布局：分布 + 最近迭代 */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <PRDDistributionCard items={items} />
        <RecentIterationsCard entries={progressData} />
      </div>
    </div>
  )
}
