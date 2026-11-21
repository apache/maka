import { z } from 'zod'

/**
 * 对话请求（Q13 定案）：省略 conversationId 即新建会话；
 * 历史由后端从 messages 表自查，前端不重放。
 */
export const ChatRequestSchema = z.object({
  conversationId: z.number().int().positive().optional(),
  message: z.string().min(1).max(8000),
})
export type ChatRequest = z.infer<typeof ChatRequestSchema>

/** 写确认请求（Q15 定案：SSE 悬挂期间的独立确认端点） */
export const ConfirmRequestSchema = z.object({
  toolCallId: z.string().min(1),
  approved: z.boolean(),
})
export type ConfirmRequest = z.infer<typeof ConfirmRequestSchema>
