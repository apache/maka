/**
 * Progress 数据 Hook
 * 调用 ProgressParserService.parse 获取进度数据
 */
import { useState, useEffect } from 'react'
import type { ProgressEntry } from '@ggbdpq/console-shared'
import { parseProgressContent } from '@/server/governance/services/progress-parser'

export interface UseProgressDataResult {
  /** Progress 条目列表 */
  data: readonly ProgressEntry[]
  /** 是否加载中 */
  loading: boolean
  /** 错误信息 */
  error: string | null
  /** 重新加载 */
  reload: () => void
}

/**
 * 获取 Progress 数据的 Hook
 * 注意：此 Hook 使用模拟数据，实际应从文件系统读取
 */
export function useProgressData(): UseProgressDataResult {
  const [data, setData] = useState<readonly ProgressEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadData = () => {
    setLoading(true)
    setError(null)
    fetch('/api/governance/progress')
      .then((r) => r.json())
      .then(
        (body: {
          entries: Array<{
            datetime: string | null
            prdId: string
            component: string
            priority: string
            what: string
            why: string
            typecheckResult: string
            commitMessage: string
            next: string
          }>
        }) => {
          const mapped: ProgressEntry[] = body.entries
            .filter((e) => e.prdId && e.what && e.datetime)
            .map((e) => ({
              datetime: new Date(e.datetime as string),
              prdId: e.prdId,
              component: e.component,
              priority: (e.priority as ProgressEntry['priority']) ?? 'P0',
              what: e.what,
              why: e.why,
              typecheckResult: e.typecheckResult,
              commitMessage: e.commitMessage,
              next: e.next,
              rawContent: '',
            }))
          setData(mapped)
          setError(null)
        },
      )
      .catch(() => {
        setData([])
        setError('加载 progress 数据失败')
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    loadData()
  }, [])

  return {
    data,
    loading,
    error,
    reload: loadData,
  }
}
