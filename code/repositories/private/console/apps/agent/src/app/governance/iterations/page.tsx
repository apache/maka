'use client';
/**
 * Iteration 页面 - 单 PRD 执行周期
 */
import { useIterationData } from '@/hooks/governance/useIterationData'
import { PageHeader } from '@/components/governance/layout/PageHeader'
import { IterationCard } from '@/components/governance/iteration'
import { LoadingState, ErrorState, EmptyState } from '@/components/governance/common'

/**
 * Iteration 页面组件
 */
export default function IterationPage() {
  const { data, loading, error, reload } = useIterationData()

  // 加载状态
  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Iterations"
          description="单 PRD 执行周期追踪"
        />
        <LoadingState lines={6} />
      </div>
    )
  }

  // 错误状态
  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Iterations"
          description="单 PRD 执行周期追踪"
        />
        <ErrorState message={error} onRetry={reload} />
      </div>
    )
  }

  // 空数据状态
  if (!data || data.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Iterations"
          description="单 PRD 执行周期追踪"
        />
        <EmptyState
          title="暂无 Iteration 数据"
          description="没有已完成的 PRD 记录"
        />
      </div>
    )
  }

  // 统计
  const validCount = data.filter((i) => i.isValid).length
  const totalCount = data.length

  return (
    <div className="space-y-6">
      <PageHeader
        title="Iterations"
        description={`共 ${totalCount} 个迭代，${validCount} 个有效`}
      />

      {/* Iteration 卡片列表 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {data.map((iteration) => (
          <IterationCard key={iteration.prdId} iteration={iteration} />
        ))}
      </div>
    </div>
  )
}
