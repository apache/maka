'use client';
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

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

type TargetType = 'vscode' | 'cursor'

interface ExecuteRequest {
  profile: string
  targets: TargetType[]
}

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

interface RunResult {
  run: {
    id: string
    mode: string
    result: string
    plan: Plan
  }
  success: boolean
  error?: string
}

async function executeDryRun(request: ExecuteRequest): Promise<RunResult> {
  const res = await fetch('/api/agentops/runs/dry-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  return res.json()
}

async function executeApply(request: ExecuteRequest): Promise<RunResult> {
  const res = await fetch('/api/agentops/runs/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  return res.json()
}

export default function OverviewPage() {
  const queryClient = useQueryClient()
  const [selectedTargets, setSelectedTargets] = useState<TargetType[]>(['cursor'])
  const [showHighRiskOnly, setShowHighRiskOnly] = useState(false)
  const [showApplyConfirm, setShowApplyConfirm] = useState(false)

  const dryRunMutation = useMutation({
    mutationFn: executeDryRun,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['runs'] })
    },
  })

  const applyMutation = useMutation({
    mutationFn: executeApply,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['runs'] })
    },
  })

  const toggleTarget = (target: TargetType) => {
    setSelectedTargets((prev) =>
      prev.includes(target) ? prev.filter((t) => t !== target) : [...prev, target]
    )
  }

  const handleDryRun = () => {
    dryRunMutation.mutate({ profile: 'default', targets: selectedTargets })
  }

  const handleApplyClick = () => {
    const plan = dryRunMutation.data?.run?.plan
    if (plan && plan.summary.highRisk > 0) {
      setShowApplyConfirm(true)
    } else {
      handleApply()
    }
  }

  const handleApply = () => {
    applyMutation.mutate({ profile: 'default', targets: selectedTargets })
  }

  const isLoading = dryRunMutation.isPending || applyMutation.isPending
  const dryRunResult = dryRunMutation.data
  const applyResult = applyMutation.data
  const plan = dryRunResult?.run?.plan

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">总览</h2>
        <p className="text-muted-foreground">管理并同步各编辑器的配置（Dry Run 预览，确认后应用）</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>同步目标</CardTitle>
            <CardDescription>选择要同步配置的编辑器</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox
                checked={selectedTargets.includes('vscode')}
                onCheckedChange={() => toggleTarget('vscode')}
              />
              VSCode
            </label>
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox
                checked={selectedTargets.includes('cursor')}
                onCheckedChange={() => toggleTarget('cursor')}
              />
              Cursor
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>执行操作</CardTitle>
            <CardDescription>先 Dry Run 生成计划，再应用到目标编辑器</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              onClick={handleDryRun}
              disabled={isLoading || selectedTargets.length === 0}
              variant="secondary"
              className="w-full"
            >
              {dryRunMutation.isPending ? '试运行中…' : 'Dry Run 试运行'}
            </Button>
            <Button
              onClick={handleApplyClick}
              disabled={isLoading || selectedTargets.length === 0}
              className="w-full"
            >
              {applyMutation.isPending ? '应用中…' : '应用变更'}
            </Button>
          </CardContent>
        </Card>
      </div>

      {plan && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>变更摘要</CardTitle>
              <div className="flex items-center gap-4">
                <span className="text-sm text-success">+{plan.summary.changed} 处变更</span>
                <span className="text-sm text-destructive">-{plan.summary.deleted} 处删除</span>
                {plan.summary.highRisk > 0 && (
                  <span className="text-sm text-warning">{plan.summary.highRisk} 处高风险</span>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {plan.summary.highRisk > 0 && (
              <label className="flex items-center gap-2 text-sm font-medium">
                <Checkbox
                  checked={showHighRiskOnly}
                  onCheckedChange={(checked) => setShowHighRiskOnly(checked === true)}
                />
                仅显示高风险变更
              </label>
            )}
            <DiffViewer steps={plan.steps} showHighRiskOnly={showHighRiskOnly} />
          </CardContent>
        </Card>
      )}

      {applyResult && (
        <Card className={applyResult.success ? 'border-success/50' : 'border-destructive/50'}>
          <CardHeader>
            <CardTitle className={applyResult.success ? 'text-success' : 'text-destructive'}>
              {applyResult.success ? '应用成功' : '应用失败'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {applyResult.error ? (
              <pre className="text-sm text-destructive">{applyResult.error}</pre>
            ) : (
              <p className="text-sm text-muted-foreground">
                Run ID: {applyResult.run?.id}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <AlertDialog open={showApplyConfirm} onOpenChange={setShowApplyConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>检测到高风险变更</AlertDialogTitle>
            <AlertDialogDescription>
              本次操作包含 {plan?.summary.highRisk ?? 0} 处高风险变更，可能影响编辑器行为。确定继续吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          {plan && (
            <div className="max-h-48 overflow-auto">
              <DiffViewer steps={plan.steps} showHighRiskOnly={true} />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleApply}
              className={cn(buttonVariants({ variant: 'destructive' }))}
            >
              仍要应用
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
