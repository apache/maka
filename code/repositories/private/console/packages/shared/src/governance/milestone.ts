/**
 * Milestone（里程碑）相关类型定义
 * 多个 PRD_Item 的聚合视图
 */

import type { PRDItem } from './prd'

/**
 * Milestone 分组规则
 */
export type MilestoneGroupBy = 'priority' | 'component' | 'custom'

/**
 * Milestone 聚合统计
 */
export interface MilestoneStatistics {
  /** 总数 */
  readonly total: number

  /** 已完成数 */
  readonly completed: number

  /** 完成百分比 */
  readonly completion: string
}

/**
 * Milestone 模型
 * 多个 PRD_Item 的聚合视图
 */
export interface Milestone {
  /** Milestone 名称 */
  readonly name: string

  /** 分组规则 */
  readonly groupBy: MilestoneGroupBy

  /** 包含的 PRD 条目 */
  readonly prdItems: readonly PRDItem[]

  /** 聚合统计 */
  readonly statistics: MilestoneStatistics
}
