import { z } from 'zod'
import { PrioritySchema, TodoStatusSchema } from './enums'

/** ISO 8601 UTC 时间戳（SQLite TEXT 列的契约形态，Q4 定案） */
export const IsoDateTimeSchema = z.iso.datetime()

/** todo 实体（API 返回形态） */
export const TodoSchema = z.object({
  id: z.number().int(),
  title: z.string().min(1).max(200),
  description: z.string().nullable(),
  status: TodoStatusSchema,
  priority: PrioritySchema.nullable(),
  dueDate: z.iso.date().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.nullable(),
})
export type Todo = z.infer<typeof TodoSchema>

/** 新增 todo 输入 */
export const CreateTodoInputSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  priority: PrioritySchema.optional(),
  dueDate: z.iso.date().optional(),
})
export type CreateTodoInput = z.infer<typeof CreateTodoInputSchema>

/** 修改 todo 输入：全部字段可选，但至少给一个 */
export const UpdateTodoInputSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    status: TodoStatusSchema.optional(),
    priority: PrioritySchema.nullable().optional(),
    dueDate: z.iso.date().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少提供一个要修改的字段' })
export type UpdateTodoInput = z.infer<typeof UpdateTodoInputSchema>
