import { z } from 'zod'
import { PrioritySchema, TodoStatusSchema } from './enums'

/**
 * 工具参数 schema（§6 工具集）。
 * 服务端在执行前用这些 schema 校验模型输出的 args——模型输出不可信是工程前提。
 */

export const DueWindowSchema = z.enum(['today', 'overdue'])
export type DueWindow = z.infer<typeof DueWindowSchema>

export const TodoListArgsSchema = z.object({
  status: TodoStatusSchema.optional(),
  keyword: z.string().max(100).optional(),
  dueWindow: DueWindowSchema.optional(),
})
export type TodoListArgs = z.infer<typeof TodoListArgsSchema>

export const TodoCreateArgsSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  priority: PrioritySchema.optional(),
  dueDate: z.iso.date().optional(),
})
export type TodoCreateArgs = z.infer<typeof TodoCreateArgsSchema>

export const TodoUpdateArgsSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: TodoStatusSchema.optional(),
  priority: PrioritySchema.nullable().optional(),
  dueDate: z.iso.date().nullable().optional(),
})
export type TodoUpdateArgs = z.infer<typeof TodoUpdateArgsSchema>

export const TodoDeleteArgsSchema = z.object({
  id: z.number().int().positive(),
})
export type TodoDeleteArgs = z.infer<typeof TodoDeleteArgsSchema>

export const TodoClearDoneArgsSchema = z.object({})
export type TodoClearDoneArgs = z.infer<typeof TodoClearDoneArgsSchema>
