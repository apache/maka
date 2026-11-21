'use client';
/**
 * Progress 页面 - 执行时间线
 */
import { useState, useMemo } from 'react'
import { useProgressData } from '@/hooks/governance/useProgressData'
import { PageHeader } from '@/components/governance/layout/PageHeader'
import { DateRangeFilter, TimelineList } from '@/components/governance/progress'
import { LoadingState, ErrorState, EmptyState } from '@/components/governance/common'
import { Card, CardContent } from '@ggbdpq/console-ui'

/**
 * Progress 页面组件
 */
export default function ProgressPage() {
  const { data, loading, error, reload } = useProgressData()

  // 日期过滤状态
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  // 过滤后的数据
  const filteredEntries = useMemo(() => {
    if (!data || data.length === 0) return []

    return data.filter((entry) => {
      // 如果没有日期，跳过日期过滤
      if (!entry.datetime) return true

      const entryDate = entry.datetime.getTime()

      // 开始日期过滤
      if (startDate) {
        const start = new Date(startDate).getTime()
        if (entryDate < start) return false
      }

      // 结束日期过滤
      if (endDate) {
        const end = new Date(endDate).getTime() + 24 * 60 * 60 * 1000 - 1 // 包含结束日期当天
        if (entryDate > end) return false
      }

      return true
    })
  }, [data, startDate, endDate])

  // 加载状态
  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Progress 时间线" description="执行进度与迭代记录" />
        <LoadingState lines={6} />
      </div>
    )
  }

  // 错误状态
  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Progress 时间线" description="执行进度与迭代记录" />
        <ErrorState message={error} onRetry={reload} />
      </div>
    )
  }

  // 空数据状态
  if (!data || data.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Progress 时间线" description="执行进度与迭代记录" />
        <EmptyState
          title="暂无进度记录"
          description="progress.txt 文件为空或不存在"
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Progress 时间线"
        description={`共 ${data.length} 条记录`}
      />

      {/* 日期过滤器 */}
      <Card>
        <CardContent className="pt-4">
          <DateRangeFilter
            startDate={startDate}
            endDate={endDate}
            onStartDateChange={setStartDate}
            onEndDateChange={setEndDate}
          />
        </CardContent>
      </Card>

      {/* 时间线列表 */}
      <Card>
        <CardContent className="pt-6">
          {filteredEntries.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              没有符合日期范围的记录
            </div>
          ) : (
            <TimelineList entries={filteredEntries} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
