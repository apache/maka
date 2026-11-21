/**
 * Compliance（合规性检查）相关类型定义
 */

import type { Iteration } from './iteration'

/**
 * 合规性规则类型字面量
 */
export type ComplianceRuleId =
  | 'one-prd-per-commit' // 一次一个 PRD
  | 'typecheck-gate' // typecheck 门禁
  | 'append-only-progress' // append-only progress
  | 'commit-convention' // commit 规范

/**
 * 规则严重性
 */
export type ComplianceSeverity = 'error' | 'warning' | 'info'

/**
 * 合规性规则定义
 */
export interface ComplianceRule {
  /** 规则 ID */
  readonly id: ComplianceRuleId

  /** 规则名称 */
  readonly name: string

  /** 规则描述 */
  readonly description: string

  /** 严重性 */
  readonly severity: ComplianceSeverity
}

/**
 * 合规性检查状态
 */
export type ComplianceStatus = 'passed' | 'failed' | 'unverifiable'

/**
 * 单个违规记录
 */
export interface ComplianceViolation {
  /** 违规消息 */
  readonly message: string

  /** 违规位置（可选） */
  readonly location?: string

  /** 建议修复方式（可选） */
  readonly suggestion?: string

  /** 关联的 Iteration（可选） */
  readonly iteration?: Iteration
}

/**
 * 合规性检查结果
 */
export interface ComplianceResult {
  /** 规则 */
  readonly rule: ComplianceRule

  /** 检查状态 */
  readonly status: ComplianceStatus

  /** 违规列表 */
  readonly violations: readonly ComplianceViolation[]

  /** 详细说明（可选） */
  readonly details?: string
}

/**
 * 合规性检查上下文
 */
export interface ComplianceContext {
  /** PRD 文档 */
  readonly prdDocument: import('./prd').PRDDocument

  /** Progress 记录列表 */
  readonly progressEntries: readonly import('./progress').ProgressEntry[]

  /** Git Commit 列表 */
  readonly gitCommits: readonly import('./git').GitCommit[]
}

/**
 * 合规性报告
 */
export interface ComplianceReport {
  /** 各规则检查结果 */
  readonly rules: readonly ComplianceResult[]

  /** 汇总统计 */
  readonly summary: {
    readonly passed: number
    readonly failed: number
    readonly unverifiable: number
  }
}
