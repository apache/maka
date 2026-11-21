/**
 * @config-agent/shared
 * Shared types and schemas for Config Orchestrator Agent
 */

import { z } from 'zod'

export const VERSION = '0.1.0' as const

// ============================================================================
// Target Types - 支持的目标编辑器类型
// ============================================================================

/**
 * 支持的编辑器目标类型
 */
export const TargetTypeSchema = z.enum(['vscode', 'cursor'])
export type TargetType = z.infer<typeof TargetTypeSchema>

/**
 * 目标配置文件类型
 */
export const ConfigFileTypeSchema = z.enum(['settings', 'keybindings', 'snippets'])
export type ConfigFileType = z.infer<typeof ConfigFileTypeSchema>

/**
 * 目标定义 - 标识一个配置目标（哪个编辑器的哪种配置）
 */
export const TargetSchema = z.object({
  /** 编辑器类型 */
  type: TargetTypeSchema,
  /** 配置文件类型 */
  fileType: ConfigFileTypeSchema,
  /** 配置文件路径（运行时解析） */
  path: z.string().optional(),
})
export type Target = z.infer<typeof TargetSchema>

// ============================================================================
// PatchStep Types - 描述单次配置修改操作
// ============================================================================

/**
 * Patch 操作类型
 */
export const PatchOpSchema = z.enum(['set', 'delete'])
export type PatchOp = z.infer<typeof PatchOpSchema>

/**
 * 单次 Patch 操作步骤
 * 使用 dot-notation 路径标识要修改的配置键
 */
export const PatchStepSchema = z.object({
  /** 操作目标 */
  target: TargetSchema,
  /** 操作类型：set 设置值，delete 删除键 */
  op: PatchOpSchema,
  /** 配置键路径，使用 dot-notation (如 "editor.fontSize") */
  path: z.string(),
  /** set 操作的新值 */
  value: z.unknown().optional(),
  /** 旧值（用于 diff 展示） */
  oldValue: z.unknown().optional(),
  /** 是否为高风险操作（需要用户确认） */
  highRisk: z.boolean().default(false),
})
export type PatchStep = z.infer<typeof PatchStepSchema>

// ============================================================================
// Plan Types - 描述一次执行计划
// ============================================================================

/**
 * 计划摘要 - 统计变更数量
 */
export const PlanSummarySchema = z.object({
  /** 变更的配置项数量 */
  changed: z.number().int().nonnegative(),
  /** 删除的配置项数量 */
  deleted: z.number().int().nonnegative(),
  /** 高风险操作数量 */
  highRisk: z.number().int().nonnegative(),
})
export type PlanSummary = z.infer<typeof PlanSummarySchema>

/**
 * 执行计划 - 包含所有要执行的步骤
 */
export const PlanSchema = z.object({
  /** 计划涉及的目标列表 */
  targets: z.array(TargetSchema),
  /** 执行步骤列表（稳定排序） */
  steps: z.array(PatchStepSchema),
  /** 计划摘要 */
  summary: PlanSummarySchema,
  /** 计划生成时间 */
  createdAt: z.string().datetime(),
})
export type Plan = z.infer<typeof PlanSchema>

// ============================================================================
// RunRecord Types - 描述一次执行记录
// ============================================================================

/**
 * 执行模式
 */
export const RunModeSchema = z.enum(['dry-run', 'apply'])
export type RunMode = z.infer<typeof RunModeSchema>

/**
 * 执行结果
 */
export const RunResultSchema = z.enum(['pending', 'success', 'error', 'rolled-back'])
export type RunResult = z.infer<typeof RunResultSchema>

/**
 * 时间线事件类型
 */
export const TimelineEventTypeSchema = z.enum([
  'scan',      // 扫描配置文件
  'plan',      // 生成执行计划
  'backup',    // 备份原始文件
  'patch',     // 执行 patch 操作
  'validate',  // 验证写入结果
  'done',      // 执行完成
  'error',     // 执行出错
  'rollback',  // 执行回滚
])
export type TimelineEventType = z.infer<typeof TimelineEventTypeSchema>

/**
 * 时间线事件
 */
export const TimelineEventSchema = z.object({
  /** 事件类型 */
  type: TimelineEventTypeSchema,
  /** 事件时间 */
  timestamp: z.string().datetime(),
  /** 事件描述 */
  message: z.string(),
  /** 事件详情（可选） */
  details: z.record(z.string(), z.unknown()).optional(),
})
export type TimelineEvent = z.infer<typeof TimelineEventSchema>

/**
 * 执行记录 - 完整描述一次 dry-run 或 apply 操作
 */
export const RunRecordSchema = z.object({
  /** 唯一标识符 */
  id: z.string().uuid(),
  /** 执行模式 */
  mode: RunModeSchema,
  /** 执行结果 */
  result: RunResultSchema,
  /** 执行计划 */
  plan: PlanSchema,
  /** 时间线（操作记录） */
  timeline: z.array(TimelineEventSchema),
  /** 错误信息（如果有） */
  error: z.string().optional(),
  /** 创建时间 */
  createdAt: z.string().datetime(),
  /** 完成时间 */
  completedAt: z.string().datetime().optional(),
})
export type RunRecord = z.infer<typeof RunRecordSchema>

// ============================================================================
// Run Index Types - 用于列表展示的简化记录
// ============================================================================

/**
 * Run 索引项 - 用于列表展示
 */
export const RunIndexItemSchema = z.object({
  /** 唯一标识符 */
  id: z.string().uuid(),
  /** 执行模式 */
  mode: RunModeSchema,
  /** 执行结果 */
  result: RunResultSchema,
  /** 涉及的目标 */
  targets: z.array(TargetSchema),
  /** 创建时间 */
  createdAt: z.string().datetime(),
  /** 完成时间 */
  completedAt: z.string().datetime().optional(),
})
export type RunIndexItem = z.infer<typeof RunIndexItemSchema>

// ============================================================================
// Profile Config Types - 主配置源类型
// ============================================================================

/**
 * Profile 配置 - 定义一套配置规则
 */
export const ProfileConfigSchema = z.object({
  /** Profile 名称 */
  name: z.string(),
  /** 受管范围（dot-notation 前缀列表） */
  managedScopes: z.array(z.string()),
  /** 目标配置（flat dot-keys） */
  settings: z.record(z.string(), z.unknown()),
})
export type ProfileConfig = z.infer<typeof ProfileConfigSchema>

// ============================================================================
// API Request/Response Types
// ============================================================================

/**
 * Dry-run / Apply 请求参数
 */
export const ExecuteRequestSchema = z.object({
  /** 使用的 profile 名称 */
  profile: z.string(),
  /** 目标编辑器列表 */
  targets: z.array(TargetTypeSchema),
})
export type ExecuteRequest = z.infer<typeof ExecuteRequestSchema>

/**
 * Rollback 请求参数
 */
export const RollbackRequestSchema = z.object({
  /** 要回滚的 run ID */
  runId: z.string().uuid(),
})
export type RollbackRequest = z.infer<typeof RollbackRequestSchema>

/**
 * 通用 API 错误响应
 */
export const ApiErrorSchema = z.object({
  /** 错误码 */
  code: z.string(),
  /** 错误信息 */
  message: z.string(),
  /** 详细信息（可选） */
  details: z.record(z.string(), z.unknown()).optional(),
})
export type ApiError = z.infer<typeof ApiErrorSchema>

// ============================================================================
// Re-export Zod for convenience
// ============================================================================

export { z }
