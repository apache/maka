'use client';
import { useState } from 'react'
import Link from 'next/link';
import { useParams } from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  buttonVariants,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  cn,
} from '@ggbdpq/console-ui'
import { DiffViewer } from '@/components/agentops/DiffViewer'

interface PatchStep {
  target: {
    type: string
    fileType: string
    path?: string
  }
  op: 'set' | 'delete'
  path: string
  value?: unknown
  oldValue?: unknown
  highRisk?: boolean
}

interface Plan {
  steps: PatchStep[]
  summary: {
    changed: number
    deleted: number
    highRisk: number
  }
}

interface TimelineEvent {
  type: string
  timestamp: string
  message: string
  details?: Record<string, unknown>
}

interface RunRecord {
  id: string
  mode: 'dry-run' | 'apply'
  result: 'pending' | 'success' | 'error' | 'rolled-back'
  plan: Plan
  timeline: TimelineEvent[]
  error?: string
  createdAt: string
  completedAt?: string
}

async function fetchRun(runId: string): Promise<{ run: RunRecord }> {
  const res = await fetch(`/api/agentops/runs/${runId}`)
  return res.json()
}

async function rollbackRun(runId: string) {
  const res = await fetch(`/api/agentops/runs/${runId}/rollback`, { method: 'POST' })
  return res.json()
}

// 时间线事件按语义着色：扫描/规划=info，备份=warning，写入/校验/完成=success，异常=destructive，回滚=info。
const eventTypeColors: Record<string, string> = {
  scan: 'text-info',
  plan: 'text-info',
  backup: 'text-warning',
  patch: 'text-success',
  validate: 'text-success',
  done: 'text-success',
  error: 'text-destructive',
  rollback: 'text-info',
}

export default function RunDetailPage() {
  const { runId } = useParams()
  const runIdStr = Array.isArray(runId) ? runId[0] : runId
  const queryClient = useQueryClient()
  const [showHighRiskOnly, setShowHighRiskOnly] = useState(false)
  const [showRollbackConfirm, setShowRollbackConfirm] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['run', runId],
    queryFn: () => fetchRun(runIdStr!),
    enabled: !!runId,
  })

  const rollbackMutation = useMutation({
    mutationFn: () => rollbackRun(runIdStr!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['run', runId] })
      queryClient.invalidateQueries({ queryKey: ['runs'] })
    },
  })

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-muted-foreground">加载运行详情中…</p>
      </div>
    )
  }

  if (error || !data?.run) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-destructive">运行记录不存在</p>
      </div>
    )
  }

  const run = data.run
  const canRollback = run.mode === 'apply' && run.result === 'success'

  const handleRollbackClick = () => {
    setShowRollbackConfirm(true)
  }

  const handleRollback = () => {
    rollbackMutation.mutate()
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <Link
            href="/agentops/runs"
            className="mb-2 inline-block text-sm text-muted-foreground hover:text-foreground"
          >
            ← 返回运行记录
          </Link>
          <h2 className="text-3xl font-bold tracking-tight">运行详情</h2>
          <p className="font-mono text-sm text-muted-foreground">{run.id}</p>
        </div>
        {canRollback && (
          <Button
            onClick={handleRollbackClick}
            variant="destructive"
            disabled={rollbackMutation.isPending}
          >
            {rollbackMutation.isPending ? '回滚中…' : '回滚'}
          </Button>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>运行信息</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">模式</span>
              <span>{run.mode}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">结果</span>
              <span>{run.result}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">创建时间</span>
              <span>{new Date(run.createdAt).toLocaleString()}</span>
            </div>
            {run.completedAt && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">完成时间</span>
                <span>{new Date(run.completedAt).toLocaleString()}</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>变更摘要</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">变更</span>
              <span className="text-success">+{run.plan.summary.changed}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">删除</span>
              <span className="text-destructive">-{run.plan.summary.deleted}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">高风险</span>
              <span className="text-warning">{run.plan.summary.highRisk}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {run.error && (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="text-destructive">错误</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap text-sm text-destructive">{run.error}</pre>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>变更对比</CardTitle>
            {run.plan.summary.highRisk > 0 && (
              <label className="flex items-center gap-2 text-sm font-medium">
                <Checkbox
                  checked={showHighRiskOnly}
                  onCheckedChange={(checked) => setShowHighRiskOnly(checked === true)}
                />
                仅显示高风险
              </label>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <DiffViewer steps={run.plan.steps} showHighRiskOnly={showHighRiskOnly} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>执行时间线</CardTitle>
          <CardDescription>执行历史</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {run.timeline.map((event, index) => (
              <div key={index} className="flex gap-4">
                <div className="w-24 shrink-0 text-xs text-muted-foreground">
                  {new Date(event.timestamp).toLocaleTimeString()}
                </div>
                <div
                  className={cn(
                    'w-20 shrink-0 font-mono text-xs font-medium',
                    eventTypeColors[event.type] ?? 'text-muted-foreground',
                  )}
                >
                  {event.type}
                </div>
                <div className="text-sm">{event.message}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showRollbackConfirm} onOpenChange={setShowRollbackConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认回滚</AlertDialogTitle>
            <AlertDialogDescription>
              将把编辑器设置恢复到本次运行之前的状态。确定继续吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRollback}
              className={cn(buttonVariants({ variant: 'destructive' }))}
            >
              回滚
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
