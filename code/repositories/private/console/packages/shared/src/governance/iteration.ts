/**
 * Iteration（执行周期）相关类型定义
 * 一个 Iteration = 完成一个 PRD_Item 的完整周期
 */

import type { PRDItem } from './prd'
import type { ProgressEntry } from './progress'
import type { GitCommit } from './git'

/**
 * Iteration 模型
 * 一个 Iteration = 完成一个 PRD_Item 的完整周期
 */
export interface Iteration {
  /** 关联的 PRD 条目 */
  readonly prdItem: PRDItem

  /** 关联的 Progress 记录 */
  readonly progressEntry: ProgressEntry | null

  /** 关联的 Git Commit */
  readonly gitCommit: GitCommit | null

  /** Iteration 是否有效（包含完整的 5 个步骤） */
  readonly isValid: boolean

  /** 无效原因（如果 isValid 为 false） */
  readonly invalidReason?: string
}

/**
 * Iteration 步骤状态
 */
export interface IterationSteps {
  /** 选择 PRD */
  select: boolean
  /** 实现功能 */
  implement: boolean
  /** TypeCheck 通过 */
  typecheck: boolean
  /** 记录 Progress */
  progress: boolean
  /** Git Commit */
  commit: boolean
}

/**
 * Iteration 记录（用于 UI 展示）
 */
export interface IterationRecord {
  /** PRD ID */
  prdId: string
  /** 组件名称 */
  component: string
  /** 优先级 */
  priority: string
  /** 开始时间 */
  startTime: Date | null
  /** 结束时间 */
  endTime: Date | null
  /** 步骤状态 */
  steps: IterationSteps
  /** 是否有效 */
  isValid: boolean
  /** Commit Hash */
  commitHash: string | null
  /** 备注 */
  notes: string
}
