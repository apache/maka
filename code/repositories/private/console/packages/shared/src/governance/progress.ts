/**
 * Progress（执行留痕）相关类型定义
 * 对应 progress.txt 文件结构
 */

import type { PRDPriority } from './prd'

/**
 * Progress 记录条目
 * 对应 progress.txt 中的单条记录
 */
export interface ProgressEntry {
  /** 记录时间 */
  readonly datetime: Date

  /** 关联的 PRD ID */
  readonly prdId: string

  /** 关联的组件 */
  readonly component: string

  /** 优先级 */
  readonly priority: PRDPriority

  /** 做了什么 */
  readonly what: string

  /** 为什么这样做 */
  readonly why: string

  /** typecheck 结果 */
  readonly typecheckResult: string

  /** git commit message */
  readonly commitMessage: string

  /** 下一条计划执行的 PRD */
  readonly next: string

  /** 原始文本内容 */
  readonly rawContent: string
}
