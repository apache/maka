/**
 * PRD 数据 Hook
 * 调用 PRDParserService.parse 获取 PRD 数据
 */
import { useState, useEffect } from 'react'
import type { PRDDocument } from '@ggbdpq/console-shared'
import { parsePRDContent, type PRDParseResult } from '@/server/governance/services/prd-parser'

export interface UsePRDDataResult {
  /** PRD 文档数据 */
  data: PRDDocument | null
  /** 是否加载中 */
  loading: boolean
  /** 错误信息 */
  error: string | null
  /** 重新加载 */
  reload: () => void
}

/**
 * 获取 PRD 数据的 Hook
 * 注意：此 Hook 使用模拟数据，实际应从文件系统读取
 */
export function usePRDData(): UsePRDDataResult {
  const [data, setData] = useState<PRDDocument | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadData = () => {
    setLoading(true)
    setError(null)
    fetch('/api/governance/prd')
      .then((r) => r.json())
      .then((body: { document: PRDDocument | null; sources: Array<{ ok: boolean; error?: string }> }) => {
        setData(body.document)
        const bad = body.sources.filter((x) => !x.ok)
        setError(bad.length ? `${bad.length} 个 PRD 文件解析失败` : null)
      })
      .catch(() => {
        setData(null)
        setError('加载 PRD 数据失败')
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
