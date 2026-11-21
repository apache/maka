/**
 * 日期范围过滤组件
 * 用于 Progress 页面的时间范围过滤
 */
import { Input } from '@ggbdpq/console-ui'

export interface DateRangeFilterProps {
  /** 开始日期 */
  startDate: string
  /** 结束日期 */
  endDate: string
  /** 开始日期变更回调 */
  onStartDateChange: (date: string) => void
  /** 结束日期变更回调 */
  onEndDateChange: (date: string) => void
}

/**
 * 日期范围过滤组件
 * 纯前端过滤，不改数据源
 */
export function DateRangeFilter({
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
}: DateRangeFilterProps) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-2">
        <label htmlFor="start-date" className="text-sm text-muted-foreground whitespace-nowrap">
          开始日期
        </label>
        <Input
          id="start-date"
          type="date"
          value={startDate}
          onChange={(e) => onStartDateChange(e.target.value)}
          className="w-40"
        />
      </div>
      <div className="flex items-center gap-2">
        <label htmlFor="end-date" className="text-sm text-muted-foreground whitespace-nowrap">
          结束日期
        </label>
        <Input
          id="end-date"
          type="date"
          value={endDate}
          onChange={(e) => onEndDateChange(e.target.value)}
          className="w-40"
        />
      </div>
    </div>
  )
}
