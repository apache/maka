'use client';
/**
 * Compliance 页面 - 执行合规性检查
 */
import { useComplianceData } from '@/hooks/governance/useComplianceData'
import { PageHeader } from '@/components/governance/layout/PageHeader'
import { ComplianceRuleCard } from '@/components/governance/compliance'
import { LoadingState, ErrorState, EmptyState } from '@/components/governance/common'

/**
 * Compliance 页面组件
 */
export default function CompliancePage() {
  const { data, loading, error, reload } = useComplianceData()

  // 加载状态
  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Compliance"
          description="执行合规性检查"
        />
        <LoadingState lines={4} />
      </div>
    )
  }

  // 错误状态
  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Compliance"
          description="执行合规性检查"
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
          title="Compliance"
          description="执行合规性检查"
        />
        <EmptyState
          title="暂无合规检查数据"
          description="无法获取合规检查结果"
        />
      </div>
    )
  }

  // 统计
  const passedCount = data.filter((r) => r.status === 'passed').length
  const failedCount = data.filter((r) => r.status === 'failed').length
  const totalCount = data.length

  return (
    <div className="space-y-6">
      <PageHeader
        title="Compliance"
        description={`${passedCount}/${totalCount} 规则通过${failedCount > 0 ? `，${failedCount} 个失败` : ''}`}
      />

      {/* 规则卡片列表 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {data.map((result) => (
          <ComplianceRuleCard key={result.rule.id} result={result} />
        ))}
      </div>
    </div>
  )
}
