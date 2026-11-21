/**
 * PRD 详情抽屉组件
 * 展示 PRD 的 steps/passes/blocked_reason
 */
import type { PRDItem } from '@ggbdpq/console-shared'
import {
  Badge,
  cn,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@ggbdpq/console-ui'

export interface PRDDetailDrawerProps {
  /** PRD 数据 */
  item: PRDItem | null
  /** 是否显示 */
  open: boolean
  /** 关闭回调 */
  onClose: () => void
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
 * PRD 详情抽屉组件
 */
export function PRDDetailDrawer({
  item,
  open,
  onClose,
}: PRDDetailDrawerProps) {
  if (!item) return null

  return (
    <Drawer open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DrawerContent side="right" className="max-w-lg">
        <DrawerHeader>
          <DrawerTitle className="flex items-center gap-2">
            <span className="font-mono text-info">{item.id}</span>
            <Badge variant={getPriorityVariant(item.priority)}>
              {item.priority}
            </Badge>
            <Badge variant={item.passes ? 'pass' : 'pending'}>
              {item.passes ? '已完成' : '待完成'}
            </Badge>
          </DrawerTitle>
          <DrawerDescription>{item.component}</DrawerDescription>
        </DrawerHeader>

        {/* Steps 列表 */}
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-medium text-foreground mb-2">
              执行步骤 ({item.steps.length})
            </h3>
            {item.steps.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">暂无步骤</p>
            ) : (
              <ol className="space-y-2">
                {item.steps.map((step, index) => (
                  <li
                    key={index}
                    className={cn(
                      'flex gap-3 text-sm',
                      item.passes ? 'text-muted-foreground' : 'text-foreground'
                    )}
                  >
                    <span
                      className={cn(
                        'shrink-0 size-6 rounded-full flex items-center justify-center text-xs font-medium',
                        item.passes
                          ? 'bg-success/20 text-success'
                          : 'bg-accent text-muted-foreground'
                      )}
                    >
                      {item.passes ? '✓' : index + 1}
                    </span>
                    <span className="flex-1 pt-0.5">{step}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {/* 状态信息 */}
          <div className="pt-4 border-t border-border">
            <h3 className="text-sm font-medium text-foreground mb-2">
              状态信息
            </h3>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">完成状态</dt>
                <dd
                  className={
                    item.passes ? 'text-success' : 'text-warning'
                  }
                >
                  {item.passes ? 'passes: true' : 'passes: false'}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">优先级</dt>
                <dd>{item.priority}</dd>
              </div>
            </dl>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  )
}