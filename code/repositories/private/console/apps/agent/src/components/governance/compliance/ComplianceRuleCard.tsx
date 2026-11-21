/**
 * 合规规则卡片组件
 * 规则卡片 + 状态 badge
 */
import { useState } from 'react'
import type { ComplianceResult } from '@ggbdpq/console-shared'
import { Badge } from '@ggbdpq/console-ui'
import { Card, CardContent, CardHeader, CardTitle } from '@ggbdpq/console-ui'
import { ViolationDetail } from './ViolationDetail'
import { cn } from '@ggbdpq/console-ui'

export interface ComplianceRuleCardProps {
  /** 合规检查结果 */
  result: ComplianceResult
  /** 自定义类名 */
  className?: string
}

/**
 * 获取状态 Badge 变体
 */
function getStatusVariant(status: string): 'pass' | 'pending' | 'blocked' | 'default' {
  switch (status) {
    case 'passed':
      return 'pass'
    case 'failed':
      return 'blocked'
    case 'unverifiable':
      return 'pending'
    default:
      return 'default'
  }
}

/**
 * 获取状态文本
 */
function getStatusText(status: string): string {
  switch (status) {
    case 'passed':
      return '通过'
    case 'failed':
      return '失败'
    case 'unverifiable':
      return '无法验证'
    default:
      return status
  }
}

/**
 * 合规规则卡片组件
 */
export function ComplianceRuleCard({ result, className }: ComplianceRuleCardProps) {
  const [expanded, setExpanded] = useState(false)
  const hasViolations = result.violations.length > 0

  return (
    <Card className={cn('transition-shadow hover:shadow-lg', className)}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">
            {result.rule.name}
          </CardTitle>
          <Badge variant={getStatusVariant(result.status)}>
            {getStatusText(result.status)}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {result.rule.description}
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* 详情 */}
        {result.details && (
          <p className="text-sm text-foreground">{result.details}</p>
        )}

        {/* 违规数量提示 */}
        {hasViolations && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-destructive hover:text-destructive transition-colors"
          >
            {expanded ? '▲ 收起' : '▼ 展开'} {result.violations.length} 个违规
          </button>
        )}

        {/* 违规详情 */}
        {expanded && hasViolations && (
          <ViolationDetail violations={result.violations} className="mt-2" />
        )}

        {/* 规则 ID */}
        <p className="text-xs text-muted-foreground">
          规则: {result.rule.id}
        </p>
      </CardContent>
    </Card>
  )
}
