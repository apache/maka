import { z } from 'zod'
import { IsoDateTimeSchema } from './todo'

/** 会话实体 */
export const ConversationSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})
export type Conversation = z.infer<typeof ConversationSchema>

/**
 * assistant 消息的事件溯源载荷（raw_json 列，Q20 定案）
 * —— Model-visible means logged：凡到达模型的内容必须可从日志重建
 */
export const AssistantPayloadSchema = z.object({
  model: z.string(),
  usage: z
    .object({ prompt: z.number().nullable(), completion: z.number().nullable() })
    .nullable(),
  finishReason: z.string().nullable(),
  toolCalls: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        args: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
})
export type AssistantPayload = z.infer<typeof AssistantPayloadSchema>

/** tool 消息的事件溯源载荷（raw_json 列） */
export const ToolPayloadSchema = z.object({
  toolCallId: z.string(),
  approved: z.boolean(),
  status: z.enum(['confirmed', 'rejected', 'timeout']),
  action: z.string(),
  result: z.unknown(),
})
export type ToolPayload = z.infer<typeof ToolPayloadSchema>

/** 消息实体（API 返回形态；content 对 tool 消息为结果摘要文本） */
export const MessageSchema = z.object({
  id: z.number().int(),
  conversationId: z.number().int(),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  rawJson: z.union([AssistantPayloadSchema, ToolPayloadSchema]).nullable(),
  createdAt: IsoDateTimeSchema,
})
export type Message = z.infer<typeof MessageSchema>
