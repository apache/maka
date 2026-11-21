'use client';
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'

import { Card, CardContent, CardDescription, CardHeader, CardTitle, cn } from '@ggbdpq/console-ui'

interface Target {
  type: string
  fileType: string
  path?: string
}

interface RunIndexItem {
  id: string
  mode: 'dry-run' | 'apply'
  result: 'pending' | 'success' | 'error' | 'rolled-back'
  targets: Target[]
  createdAt: string
  completedAt?: string
}

async function fetchRuns(): Promise<{ runs: RunIndexItem[] }> {
  const res = await fetch('/api/agentops/runs')
  return res.json()
}

const resultColors = {
  pending: 'bg-warning/15 text-warning',
  success: 'bg-success/15 text-success',
  error: 'bg-destructive/15 text-destructive',
  'rolled-back': 'bg-info/15 text-info',
}

const resultLabels = {
  pending: '待执行',
  success: '成功',
  error: '失败',
  'rolled-back': '已回滚',
}

const modeLabels = {
  'dry-run': 'Dry Run',
  apply: 'Apply',
}

export default function RunsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['runs'],
    queryFn: fetchRuns,
  })

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-muted-foreground">加载运行记录中…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-destructive">运行记录加载失败</p>
      </div>
    )
  }

  const runs = data?.runs ?? []

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">运行记录</h2>
        <p className="text-muted-foreground">查看全部配置同步运行</p>
      </div>

      {runs.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">
              暂无运行记录。到总览页发起第一次 Dry Run。
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {runs.map((run) => (
            <Link key={run.id} href={`/agentops/runs/${run.id}`}>
              <Card className="cursor-pointer transition-colors hover:bg-secondary/50">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <CardTitle className="text-lg">{modeLabels[run.mode]}</CardTitle>
                      <div className="flex gap-1">
                        {run.targets.map((target, i) => (
                          <span
                            key={i}
                            className="rounded bg-secondary px-2 py-0.5 text-xs"
                          >
                            {target.type}
                          </span>
                        ))}
                      </div>
                    </div>
                    <span
                      className={cn('rounded-full px-2 py-1 text-xs font-medium', resultColors[run.result])}
                    >
                      {resultLabels[run.result]}
                    </span>
                  </div>
                  <CardDescription>
                    {new Date(run.createdAt).toLocaleString()}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="font-mono text-sm text-muted-foreground">
                    {run.id}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
