'use client';
/**
 * Spec 页面 - 规划文档管理
 * 展示 .kiro/specs/ 目录下的所有 Spec 文档
 */
import { useSpecData } from '@/hooks/governance/useSpecData'
import { SpecCard } from '@/components/governance/spec'
import { LoadingState, ErrorState, EmptyState } from '@/components/governance/common'
import { Card, CardContent, CardHeader, CardTitle } from '@ggbdpq/console-ui'
import { cn } from '@ggbdpq/console-ui'

/**
 * Spec 页面
 */
export default function SpecPage() {
  const { data: specs, warnings, loading, error, reload } = useSpecData()

  if (loading) {
    return <LoadingState />
  }

  if (error) {
    return <ErrorState message={error} onRetry={reload} />
  }

  if (specs.length === 0) {
    return (
      <EmptyState
        title="暂无 Spec 文档"
        description="在 .kiro/specs/ 目录下创建 Spec 文档以开始规划"
        icon="📁"
      />
    )
  }

  // 统计完整性
  const completeCount = specs.filter(
    (s) => s.completeness.hasRequirements && s.completeness.hasDesign && s.completeness.hasTasks
  ).length
  const incompleteCount = specs.length - completeCount

  return (
    <div className="space-y-6">
      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">规划文档</h1>
        <button
          onClick={reload}
          className="px-3 py-1.5 text-sm bg-accent hover:bg-secondary rounded-lg transition-colors"
        >
          刷新
        </button>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard title="总 Spec 数" value={specs.length} color="blue" />
        <StatCard title="完整 Spec" value={completeCount} color="emerald" />
        <StatCard title="不完整 Spec" value={incompleteCount} color="amber" />
      </div>

      {/* 警告信息 */}
      {warnings.length > 0 && (
        <Card className="border-warning/30 bg-warning/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-warning">完整性警告</CardTitle>
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

      {/* Spec 卡片列表 */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {specs.map((spec) => (
          <SpecCard key={spec.path} spec={spec} />
        ))}
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
