/**
 * PRD 表格组件
 * 展示 PRD 列表，支持行点击
 */
import type { PRDItem } from '@ggbdpq/console-shared'
import { Badge } from '@ggbdpq/console-ui'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ggbdpq/console-ui'
import { cn } from '@ggbdpq/console-ui'

export interface PRDTableProps {
  /** PRD 列表数据 */
  items: readonly PRDItem[]
  /** 行点击回调 */
  onRowClick?: (item: PRDItem) => void
  /** 当前选中的 PRD ID */
  selectedId?: string
  /** 自定义类名 */
  className?: string
}

/**
 * 获取优先级 Badge 变体
 */
function getPriorityVariant(priority: string): 'p0' | 'p1' | 'p2' | 'default' {
  switch (priority) {
    case 'P0':
      return 'p0'
    case 'P1':
      return 'p1'
    case 'P2':
      return 'p2'
    default:
      return 'default'
  }
}

/**
 * 获取状态 Badge 变体
 */
function getStatusVariant(passes: boolean): 'pass' | 'pending' {
  return passes ? 'pass' : 'pending'
}

/**
 * PRD 表格组件
 */
export function PRDTable({
  items,
  onRowClick,
  selectedId,
  className,
}: PRDTableProps) {
  return (
    <Table className={className}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-24">ID</TableHead>
          <TableHead>Component</TableHead>
          <TableHead className="w-24">Priority</TableHead>
          <TableHead className="w-24">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.length === 0 ? (
          <TableRow>
            <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
              暂无数据
            </TableCell>
          </TableRow>
        ) : (
          items.map((item) => (
            <TableRow
              key={item.id}
              onClick={() => onRowClick?.(item)}
              className={cn(
                onRowClick && 'cursor-pointer',
                selectedId === item.id && 'bg-accent/50'
              )}
              data-state={selectedId === item.id ? 'selected' : undefined}
            >
              <TableCell className="font-mono text-info">
                {item.id}
              </TableCell>
              <TableCell className="font-medium">{item.component}</TableCell>
              <TableCell>
                <Badge variant={getPriorityVariant(item.priority)}>
                  {item.priority}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge variant={getStatusVariant(item.passes)}>
                  {item.passes ? '已完成' : '待完成'}
                </Badge>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}
