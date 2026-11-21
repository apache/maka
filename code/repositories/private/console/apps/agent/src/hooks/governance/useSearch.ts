/**
 * 全局搜索 Hook
 * 基于前端已有数据检索 PRD/Component/CommitHash
 */
import { useState, useMemo, useCallback } from 'react'
import { usePRDData } from './usePRDData'
import { useProgressData } from './useProgressData'

/**
 * 搜索结果类型
 */
export type SearchResultType = 'prd' | 'component' | 'progress'

/**
 * 搜索结果项
 */
export interface SearchResultItem {
  /** 结果类型 */
  type: SearchResultType
  /** 唯一标识 */
  id: string
  /** 显示标题 */
  title: string
  /** 显示描述 */
  description: string
  /** 跳转路由 */
  route: string
}

export interface UseSearchResult {
  /** 搜索关键词 */
  query: string
  /** 设置搜索关键词 */
  setQuery: (query: string) => void
  /** 搜索结果 */
  results: readonly SearchResultItem[]
  /** 是否正在搜索 */
  isSearching: boolean
  /** 清空搜索 */
  clear: () => void
}

/**
 * 全局搜索 Hook
 */
export function useSearch(): UseSearchResult {
  const [query, setQuery] = useState('')
  const { data: prdData, loading: prdLoading } = usePRDData()
  const { data: progressData, loading: progressLoading } = useProgressData()

  const isSearching = prdLoading || progressLoading

  // 执行搜索
  const results = useMemo<readonly SearchResultItem[]>(() => {
    if (!query.trim() || query.length < 2) return []

    const searchTerm = query.toLowerCase()
    const items: SearchResultItem[] = []

    // 搜索 PRD
    if (prdData?.items) {
      for (const item of prdData.items) {
        const matchId = item.id.toLowerCase().includes(searchTerm)
        const matchComponent = item.component.toLowerCase().includes(searchTerm)

        if (matchId || matchComponent) {
          items.push({
            type: 'prd',
            id: item.id,
            title: item.id,
            description: `${item.component} (${item.priority}) - ${item.passes ? '已完成' : '进行中'}`,
            route: `/prd?highlight=${item.id}`,
          })
        }
      }
    }

    // 搜索 Progress
    for (const entry of progressData) {
      const matchPrdId = entry.prdId.toLowerCase().includes(searchTerm)
      const matchWhat = entry.what.toLowerCase().includes(searchTerm)
      const matchComponent = entry.component.toLowerCase().includes(searchTerm)
      const matchCommit = entry.commitMessage?.toLowerCase().includes(searchTerm)

      if (matchPrdId || matchWhat || matchComponent || matchCommit) {
        items.push({
          type: 'progress',
          id: `progress-${entry.prdId}-${entry.datetime.getTime()}`,
          title: entry.prdId,
          description: entry.what,
          route: `/progress?highlight=${entry.prdId}`,
        })
      }
    }

    // 限制返回数量
    return items.slice(0, 20)
  }, [query, prdData, progressData])

  const clear = useCallback(() => {
    setQuery('')
  }, [])

  return {
    query,
    setQuery,
    results,
    isSearching,
    clear,
  }
}
