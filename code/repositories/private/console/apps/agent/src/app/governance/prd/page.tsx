'use client';
/**
 * PRD 页面 - PRD 列表与完成度追踪
 */
import { useState, useMemo } from 'react'
import type { PRDItem } from '@ggbdpq/console-shared'
import { usePRDData } from '@/hooks/governance/usePRDData'
import { PageHeader } from '@/components/governance/layout/PageHeader'
import { PRDFilters, PRDTable, PRDDetailDrawer } from '@/components/governance/prd'
import { LoadingState, ErrorState, EmptyState } from '@/components/governance/common'
import { Card, CardContent } from '@ggbdpq/console-ui'

/**
 * PRD 页面组件
 */
export default function PRDPage() {
  const { data, loading, error, reload } = usePRDData()

  // 过滤状态
  const [statusFilter, setStatusFilter] = useState<'all' | 'passed' | 'pending'>('all')
  const [priorityFilter, setPriorityFilter] = useState<'all' | 'P0' | 'P1' | 'P2'>('all')

  // 抽屉状态
  const [selectedItem, setSelectedItem] = useState<PRDItem | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  // 过滤后的数据
  const filteredItems = useMemo(() => {
    if (!data?.items) return []

    return data.items.filter((item) => {
      // 状态过滤
      if (statusFilter === 'passed' && !item.passes) return false
      if (statusFilter === 'pending' && item.passes) return false

      // 优先级过滤
      if (priorityFilter !== 'all' && item.priority !== priorityFilter) return false

      return true
    })
  }, [data?.items, statusFilter, priorityFilter])

  // 处理行点击
  const handleRowClick = (item: PRDItem) => {
    setSelectedItem(item)
    setDrawerOpen(true)
  }

  // 关闭抽屉
  const handleCloseDrawer = () => {
    setDrawerOpen(false)
  }

  // 加载状态
  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="PRD 列表" description="产品需求文档完成度追踪" />
        <LoadingState lines={8} />
      </div>
    )
  }

  // 错误状态
  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="PRD 列表" description="产品需求文档完成度追踪" />
        <ErrorState message={error} onRetry={reload} />
      </div>
    )
  }

  // 空数据状态
  if (!data?.items || data.items.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="PRD 列表" description="产品需求文档完成度追踪" />
        <EmptyState
          title="暂无 PRD 数据"
          description="prd.json 文件为空或不存在"
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="PRD 列表"
        description={`共 ${data.items.length} 项需求，已完成 ${data.statistics?.passing ?? 0} 项`}
      />

      {/* 过滤器 */}
      <Card>
        <CardContent className="pt-4">
          <PRDFilters
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            priorityFilter={priorityFilter}
            onPriorityFilterChange={setPriorityFilter}
          />
        </CardContent>
      </Card>

      {/* PRD 表格 */}
      <Card>
        <CardContent className="p-0">
          {filteredItems.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              没有符合筛选条件的 PRD
            </div>
          ) : (
            <PRDTable
              items={filteredItems}
              onRowClick={handleRowClick}
              {...(selectedItem?.id ? { selectedId: selectedItem.id } : {})}
            />
          )}
        </CardContent>
      </Card>

      {/* 详情抽屉 */}
      <PRDDetailDrawer
        item={selectedItem}
        open={drawerOpen}
        onClose={handleCloseDrawer}
      />
    </div>
  )
}
