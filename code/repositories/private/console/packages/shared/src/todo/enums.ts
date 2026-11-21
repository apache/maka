import { z } from 'zod'

/** todo 状态：三态间自由转移（含重开 done→todo） */
export const TodoStatusSchema = z.enum(['todo', 'doing', 'done'])
export type TodoStatus = z.infer<typeof TodoStatusSchema>

/** 优先级 */
export const PrioritySchema = z.enum(['low', 'medium', 'high'])
export type Priority = z.infer<typeof PrioritySchema>

/** 消息角色；tool 角色为写确认回路预留（Q1-B / Q6 定案） */
export const MessageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool'])
export type MessageRole = z.infer<typeof MessageRoleSchema>

/** 智能体工具动作名 */
export const ToolActionSchema = z.enum([
  'todo_list',
  'todo_create',
  'todo_update',
  'todo_delete',
  'todo_clear_done',
])
export type ToolAction = z.infer<typeof ToolActionSchema>

/** 写确认的终态：用户确认 / 用户拒绝 / 超时（120s） */
export const ApprovalStatusSchema = z.enum(['confirmed', 'rejected', 'timeout'])
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>

/** 统一错误码（错误 envelope 用） */
export const ErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'DB_ERROR',
  'LLM_ERROR',
  'CONFIRM_MISMATCH',
  'INTERNAL_ERROR',
])
export type ErrorCode = z.infer<typeof ErrorCodeSchema>
