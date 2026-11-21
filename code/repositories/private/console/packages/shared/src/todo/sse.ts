import { z } from 'zod'
import { ToolActionSchema } from './enums'

/**
 * SSE 六类事件（Q14 定案 + 实现期精化），与前端四态映射：
 * meta → loading；delta/tool_confirm/tool_result → partial；done → done；error → error。
 * 前后端共用此 discriminated union，流式协议漂移在编译期归零。
 */
export const SseEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('meta'),
    conversationId: z.number().int(),
    userMessageId: z.number().int(),
    model: z.string(),
  }),
  z.object({
    type: z.literal('delta'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('tool_confirm'),
    messageId: z.number().int(),
    toolCallId: z.string(),
    action: ToolActionSchema,
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('tool_result'),
    toolCallId: z.string(),
    approved: z.boolean(),
    status: z.enum(['confirmed', 'rejected', 'timeout']),
    summary: z.string(),
  }),
  z.object({
    type: z.literal('done'),
    messageId: z.number().int(),
    usage: z
      .object({ prompt: z.number().nullable(), completion: z.number().nullable() })
      .nullable(),
  }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
  }),
])
export type SseEvent = z.infer<typeof SseEventSchema>

/** 把事件序列化为一帧 SSE 文本（data 为单行 JSON） */
export function encodeSseEvent(event: SseEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}
