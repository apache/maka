/**
 * Audit（审计链路）相关类型定义
 * PRD -> Progress -> Git Commit 的完整追溯
 */

import type { PRDItem } from './prd'
import type { ProgressEntry } from './progress'
import type { GitCommit } from './git'

/**
 * 链路完整性状态
 */
export type AuditIntegrity = 'complete' | 'partial' | 'broken'

/**
 * 审计链路
 * PRD -> Progress -> Git Commit 的完整追溯
 */
export interface AuditTrail {
  /** 关联的 PRD 条目 */
  readonly prdItem: PRDItem

  /** 关联的 Progress 记录列表 */
  readonly progressEntries: readonly ProgressEntry[]

  /** 关联的 Git Commit 列表 */
  readonly gitCommits: readonly GitCommit[]

  /** 链路完整性 */
  readonly integrity: AuditIntegrity

  /** 完整性问题描述（如果 integrity 不是 complete） */
  readonly integrityIssues?: readonly string[]
}

/**
 * 链路完整性报告
 */
export interface IntegrityReport {
  /** 总 PRD 数 */
  readonly totalPRDs: number

  /** 完整链路数 */
  readonly completeTrails: number

  /** 部分链路数 */
  readonly partialTrails: number

  /** 断裂链路数 */
  readonly brokenTrails: number

  /** 完整率 */
  readonly completionRate: string
}

/**
 * 审计上下文
 */
export interface AuditContext {
  /** PRD 文档 */
  readonly prdDocument: import('./prd').PRDDocument

  /** Progress 记录列表 */
  readonly progressEntries: readonly ProgressEntry[]

  /** Git Commit 列表 */
  readonly gitCommits: readonly GitCommit[]
}
