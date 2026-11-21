/**
 * PRD（Product Requirement Document）相关类型定义
 * 对应 prd.json 文件结构
 */

/**
 * PRD 优先级
 */
export type PRDPriority = 'P0' | 'P1' | 'P2'

/**
 * 单个 PRD 条目
 */
export interface PRDItem {
  /** 唯一标识符，如 "PRD-00" */
  readonly id: string

  /** 所属组件/模块 */
  readonly component: string

  /** 优先级 */
  readonly priority: PRDPriority

  /** 实现步骤列表 */
  readonly steps: readonly string[]

  /** 是否通过（boolean，非数字） */
  readonly passes: boolean
}

/**
 * PRD 统计信息
 * 直接读取，不进行二次计算
 */
export interface PRDStatistics {
  /** 总数 */
  readonly total: number

  /** 通过数 */
  readonly passing: number

  /** 未通过数 */
  readonly failing: number

  /** 完成百分比（字符串格式，如 "75%"） */
  readonly completion: string

  /** 阻塞原因（空字符串表示未阻塞） */
  readonly blocked_reason: string
}

/**
 * PRD 文档结构
 * 对应 prd.json 文件
 */
export interface PRDDocument {
  /** PRD 条目列表 */
  readonly items: readonly PRDItem[]

  /** 统计信息 */
  readonly statistics: PRDStatistics
}
