/**
 * Iteration 数据 Hook
 * 基于 PRD + Progress 数据构建 Iteration 列表
 */
import { useMemo } from 'react'
import { usePRDData } from './usePRDData'
import { useProgressData } from './useProgressData'
import type { IterationRecord } from '@ggbdpq/console-shared'

export interface UseIterationDataResult {
  /** Iteration 列表 */
  data: readonly IterationRecord[]
  /** 是否加载中 */
  loading: boolean
  /** 错误信息 */
  error: string | null
  /** 重新加载 */
  reload: () => void
}

/**
 * 获取 Iteration 数据的 Hook
 * 将 PRD 和 Progress 数据关联构建 Iteration 列表
 */
export function useIterationData(): UseIterationDataResult {
  const { data: prdData, loading: prdLoading, error: prdError, reload: reloadPRD } = usePRDData()
  const { data: progressData, loading: progressLoading, error: progressError, reload: reloadProgress } = useProgressData()

  const loading = prdLoading || progressLoading
  const error = prdError || progressError

  // 构建 Iteration 列表
  const iterations = useMemo<readonly IterationRecord[]>(() => {
    if (!prdData?.items || !progressData) return []

    // 按 PRD ID 分组 Progress
    const progressByPRD = new Map<string, typeof progressData[number]>()
    for (const entry of progressData) {
      if (entry.prdId && !progressByPRD.has(entry.prdId)) {
        progressByPRD.set(entry.prdId, entry)
      }
    }

    // 为每个已完成的 PRD 构建 Iteration
    return prdData.items
      .filter((item) => item.passes)
      .map((item): IterationRecord => {
        const progress = progressByPRD.get(item.id)

        return {
          prdId: item.id,
          component: item.component,
          priority: item.priority,
          startTime: progress?.datetime ?? null,
          endTime: progress?.datetime ?? null,
          steps: {
            select: true,
            implement: true,
            typecheck: true,
            progress: !!progress,
            commit: !!progress?.commitMessage,
          },
          isValid: item.passes && !!progress,
          commitHash: progress?.commitMessage ?? null,
          notes: progress?.what ?? '',
        }
      })
      .sort((a, b) => {
        // 按时间降序排列
        const timeA = a.endTime?.getTime() ?? 0
        const timeB = b.endTime?.getTime() ?? 0
        return timeB - timeA
      })
  }, [prdData, progressData])

  const reload = () => {
    reloadPRD()
    reloadProgress()
  }

  return {
    data: iterations,
    loading,
    error,
    reload,
  }
}
