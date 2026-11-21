/**
 * Spec 数据 Hook
 * 调用 SpecParserService.scanSpecs 获取 Spec 列表
 */
import { useState, useEffect } from 'react'
import type { SpecDocument, SpecCompleteness } from '@ggbdpq/console-shared'

export interface UseSpecDataResult {
  /** Spec 文档列表 */
  data: readonly SpecDocument[]
  /** 警告信息 */
  warnings: readonly string[]
  /** 是否加载中 */
  loading: boolean
  /** 错误信息 */
  error: string | null
  /** 重新加载 */
  reload: () => void
}

export function useSpecData(): UseSpecDataResult {
  const [data, setData] = useState<readonly SpecDocument[]>([])
  const [warnings, setWarnings] = useState<readonly string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadData = () => {
    setLoading(true)
    setError(null)
    fetch('/api/governance/specs')
      .then((r) => r.json())
      .then((body: { specs: SpecDocument[]; warnings: string[] }) => {
        setData(body.specs)
        setWarnings(body.warnings)
        setError(null)
      })
      .catch(() => {
        setData([])
        setWarnings([])
        setError('加载 Spec 数据失败')
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    loadData()
  }, [])

  return {
    data,
    warnings,
    loading,
    error,
    reload: loadData,
  }
}

/**
 * 检查 Spec 是否完整
 */
export function isSpecComplete(completeness: SpecCompleteness): boolean {
  return completeness.hasRequirements && completeness.hasDesign && completeness.hasTasks
}

/**
 * 获取缺失文件列表
 */
export function getMissingFiles(completeness: SpecCompleteness): string[] {
  const missing: string[] = []
  if (!completeness.hasRequirements) missing.push('requirements.md')
  if (!completeness.hasDesign) missing.push('design.md')
  if (!completeness.hasTasks) missing.push('tasks.md')
  return missing
}
