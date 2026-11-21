/**
 * PRD 过滤组件
 * 支持按 passes 状态和 priority 优先级过滤
 */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ggbdpq/console-ui'

export interface PRDFiltersProps {
  /** 当前状态过滤值 */
  statusFilter: 'all' | 'passed' | 'pending'
  /** 状态过滤变更回调 */
  onStatusFilterChange: (value: 'all' | 'passed' | 'pending') => void
  /** 当前优先级过滤值 */
  priorityFilter: 'all' | 'P0' | 'P1' | 'P2'
  /** 优先级过滤变更回调 */
  onPriorityFilterChange: (value: 'all' | 'P0' | 'P1' | 'P2') => void
}

/**
 * PRD 过滤器组件
 * 纯前端过滤，不改数据源
 */
export function PRDFilters({
  statusFilter,
  onStatusFilterChange,
  priorityFilter,
  onPriorityFilterChange,
}: PRDFiltersProps) {
  return (
    <div className="flex flex-wrap gap-4">
      {/* 状态过滤 */}
      <div className="flex items-center gap-2">
        <label htmlFor="status-filter" className="text-sm text-muted-foreground">
          状态
        </label>
        <Select
          value={statusFilter}
          onValueChange={(value) =>
            onStatusFilterChange(value as 'all' | 'passed' | 'pending')
          }
        >
          <SelectTrigger id="status-filter" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            <SelectItem value="passed">已完成</SelectItem>
            <SelectItem value="pending">待完成</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* 优先级过滤 */}
      <div className="flex items-center gap-2">
        <label htmlFor="priority-filter" className="text-sm text-muted-foreground">
          优先级
        </label>
        <Select
          value={priorityFilter}
          onValueChange={(value) =>
            onPriorityFilterChange(value as 'all' | 'P0' | 'P1' | 'P2')
          }
        >
          <SelectTrigger id="priority-filter" className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            <SelectItem value="P0">P0</SelectItem>
            <SelectItem value="P1">P1</SelectItem>
            <SelectItem value="P2">P2</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
