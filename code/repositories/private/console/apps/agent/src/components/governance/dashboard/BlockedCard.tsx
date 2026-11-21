/**
 * 阻塞状态卡片组件
 */
import { Card, CardHeader, CardTitle, CardContent } from '@ggbdpq/console-ui'
import { Badge } from '@ggbdpq/console-ui'

export interface BlockedCardProps {
  /** 阻塞原因 */
  blockedReason: string | null | undefined
  /** 自定义类名 */
  className?: string
}

/**
 * 阻塞状态卡片
 */
export function BlockedCard({ blockedReason, className }: BlockedCardProps) {
  const hasBlock = blockedReason && blockedReason.trim().length > 0

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          阻塞状态
          {hasBlock ? (
            <Badge variant="blocked">阻塞中</Badge>
          ) : (
            <Badge variant="pass">正常</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {hasBlock ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive">{blockedReason}</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">当前无阻塞，执行流程正常运行</p>
        )}
      </CardContent>
    </Card>
  )
}
