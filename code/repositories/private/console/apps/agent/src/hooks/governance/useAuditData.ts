/**
 * Audit 数据 Hook
 * 调用 AuditService.buildTrails/generateReport 获取审计链路数据
 */
import { useState, useEffect, useMemo } from 'react'
import { usePRDData } from './usePRDData'
import { useProgressData } from './useProgressData'
import type { AuditTrail, IntegrityReport } from '@ggbdpq/console-shared'
import { buildAuditTrails, type AuditBuildResult } from '@/server/governance/services/audit-service'
import type { GitCommit } from '@ggbdpq/console-shared'

export interface UseAuditDataResult {
  /** 审计链路列表 */
  trails: readonly AuditTrail[]
  /** 完整性报告 */
  report: IntegrityReport | null
  /** 警告信息 */
  warnings: readonly string[]
  /** 是否加载中 */
  loading: boolean
  /** 错误信息 */
  error: string | null
  /** 重新加载 */
  reload: () => void
}

/**
 * 模拟 Git Commits 数据
 * 实际应从 GitService 获取
 */
/**
 * 获取 Audit 数据的 Hook
 * 基于 PRD、Progress 和 Git Commits 构建审计链路
 */
export function useAuditData(): UseAuditDataResult {
  const { data: prdData, loading: prdLoading, error: prdError, reload: reloadPRD } = usePRDData()
  const {
    data: progressData,
    loading: progressLoading,
    error: progressError,
    reload: reloadProgress,
  } = useProgressData()
  const [gitCommits, setGitCommits] = useState<readonly GitCommit[]>([])

  useEffect(() => {
    fetch('/api/governance/git?limit=200')
      .then((r) => r.json())
      .then(
        (body: { commits: Array<{ sha: string; author: string; date: string; message: string }> }) => {
          setGitCommits(
            body.commits.map((c) => ({ ...c, date: new Date(c.date) })),
          )
        },
      )
      .catch(() => setGitCommits([]))
  }, [])

  const loading = prdLoading || progressLoading
  const error = prdError || progressError

  // 构建审计链路
  const auditResult = useMemo<AuditBuildResult | null>(() => {
    if (!prdData?.items || loading) return null

    try {
      return buildAuditTrails(prdData, progressData, gitCommits)
    } catch {
      return null
    }
  }, [prdData, progressData, gitCommits, loading])

  const trails = auditResult?.trails ?? []
  const warnings = auditResult?.warnings ?? []
  const report = auditResult?.report ?? null

  const reload = () => {
    reloadPRD()
    reloadProgress()
    fetch('/api/governance/git?limit=200')
      .then((r) => r.json())
      .then(
        (body: { commits: Array<{ sha: string; author: string; date: string; message: string }> }) => {
          setGitCommits(
            body.commits.map((c) => ({ ...c, date: new Date(c.date) })),
          )
        },
      )
      .catch(() => setGitCommits([]))
  }

  return {
    trails,
    report,
    warnings,
    loading,
    error,
    reload,
  }
}
