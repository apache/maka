/**
 * Compliance 数据 Hook
 * 调用 ComplianceCheckerService.checkAllRules 获取合规检查结果
 */
import { useState, useEffect } from 'react'
import type { ComplianceResult, ComplianceStatus, ComplianceRule } from '@ggbdpq/console-shared'

export interface UseComplianceDataResult {
  /** 合规检查结果列表 */
  data: readonly ComplianceResult[]
  /** 是否加载中 */
  loading: boolean
  /** 错误信息 */
  error: string | null
  /** 重新加载 */
  reload: () => void
}

// 模拟规则定义
const rules: Record<string, ComplianceRule> = {
  'one-prd-per-commit': {
    id: 'one-prd-per-commit',
    name: '单 PRD 提交',
    description: '每次提交只能包含一个 PRD 的变更',
    severity: 'error',
  },
  'typecheck-gate': {
    id: 'typecheck-gate',
    name: 'TypeCheck 门禁',
    description: '提交前必须通过 pnpm typecheck',
    severity: 'error',
  },
  'append-only-progress': {
    id: 'append-only-progress',
    name: 'Progress 只追加',
    description: 'progress.txt 只允许追加，不允许修改或删除',
    severity: 'error',
  },
  'commit-convention': {
    id: 'commit-convention',
    name: '提交规范',
    description: '提交信息必须使用中文 subject',
    severity: 'error',
  },
}

// 模拟合规检查结果
const mockComplianceResults: ComplianceResult[] = [
  {
    rule: rules['one-prd-per-commit']!,
    status: 'passed' as ComplianceStatus,
    details: '所有提交都遵循单 PRD 原则',
    violations: [],
  },
  {
    rule: rules['typecheck-gate']!,
    status: 'passed' as ComplianceStatus,
    details: '所有提交前都通过了 typecheck',
    violations: [],
  },
  {
    rule: rules['append-only-progress']!,
    status: 'passed' as ComplianceStatus,
    details: 'progress.txt 只有追加操作',
    violations: [],
  },
  {
    rule: rules['commit-convention']!,
    status: 'passed' as ComplianceStatus,
    details: '所有提交都使用中文 subject',
    violations: [],
  },
]

/**
 * 获取 Compliance 数据的 Hook
 */
export function useComplianceData(): UseComplianceDataResult {
  const [data, setData] = useState<readonly ComplianceResult[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadData = () => {
    setLoading(true)
    setError(null)

    // 模拟异步加载
    setTimeout(() => {
      try {
        setData(mockComplianceResults)
        setError(null)
      } catch {
        setData([])
        setError('加载合规检查数据失败')
      }
      setLoading(false)
    }, 100)
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
