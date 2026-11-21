import OpenAI from 'openai'
import type { Env } from '@ggbdpq/console-shared/todo'

/** 与供应商无关的消息形态（事件日志可完整重建，铁律①） */
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string }

/** LLM 流式分片（对 OpenAI 兼容流的一层薄抽象，测试用 fake 实现同接口） */
export interface LlmChunk {
  text?: string
  toolCalls?: Array<{ index: number; id?: string; name?: string; argsDelta?: string }>
  usage?: { prompt: number | null; completion: number | null } | null
  finishReason?: string | null
}

export interface LlmStreamParams {
  messages: ChatMessage[]
  withTools: boolean
  signal?: AbortSignal
}

export interface LlmClient {
  readonly model: string
  streamChat(params: LlmStreamParams): AsyncIterable<LlmChunk>
}

function toOpenAiMessages(messages: ChatMessage[]) {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant' as const,
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      }
    }
    if (m.role === 'tool') {
      return { role: 'tool' as const, tool_call_id: m.toolCallId, content: m.content }
    }
    return { role: m.role, content: m.content }
  })
}

/** DeepSeek 直连实现（OpenAI 兼容协议；Q15 流水线第 5 步） */
export function createDeepSeekClient(env: Env): LlmClient {
  const client = new OpenAI({ apiKey: env.DEEPSEEK_API_KEY, baseURL: env.DEEPSEEK_BASE_URL })
  return {
    model: env.DEEPSEEK_MODEL,
    async *streamChat(params: LlmStreamParams) {
      const stream = await client.chat.completions.create(
        {
          model: env.DEEPSEEK_MODEL,
          messages: toOpenAiMessages(params.messages),
          stream: true,
          stream_options: { include_usage: true },
          ...(params.withTools
            ? {
                tools: [
                  {
                    type: 'function' as const,
                    function: {
                      name: 'todo_list',
                      description:
                        '查询当前 todo 列表（可按状态、关键词、截止日期窗口过滤；逾期与今日到期必须用 dueWindow，不要自己算日期）',
                      parameters: {
                        type: 'object',
                        properties: {
                          status: { type: 'string', enum: ['todo', 'doing', 'done'] },
                          keyword: { type: 'string' },
                          dueWindow: {
                            type: 'string',
                            enum: ['today', 'overdue'],
                            description: 'today=截止日期等于今天；overdue=截止日期早于今天且未完成',
                          },
                        },
                      },
                    },
                  },
                  {
                    type: 'function' as const,
                    function: {
                      name: 'todo_create',
                      description: '新建一条 todo（写操作，需要用户确认）',
                      parameters: {
                        type: 'object',
                        properties: {
                          title: { type: 'string' },
                          description: { type: 'string' },
                          priority: { type: 'string', enum: ['low', 'medium', 'high'] },
                          dueDate: { type: 'string', description: 'YYYY-MM-DD' },
                        },
                        required: ['title'],
                      },
                    },
                  },
                  {
                    type: 'function' as const,
                    function: {
                      name: 'todo_update',
                      description: '修改一条 todo（写操作，需要用户确认）',
                      parameters: {
                        type: 'object',
                        properties: {
                          id: { type: 'number' },
                          title: { type: 'string' },
                          description: { type: 'string' },
                          status: { type: 'string', enum: ['todo', 'doing', 'done'] },
                          priority: { type: 'string', enum: ['low', 'medium', 'high'] },
                          dueDate: { type: 'string' },
                        },
                        required: ['id'],
                      },
                    },
                  },
                  {
                    type: 'function' as const,
                    function: {
                      name: 'todo_delete',
                      description: '软删除一条 todo（写操作，需要用户确认）',
                      parameters: {
                        type: 'object',
                        properties: { id: { type: 'number' } },
                        required: ['id'],
                      },
                    },
                  },
                  {
                    type: 'function' as const,
                    function: {
                      name: 'todo_clear_done',
                      description: '一张确认卡，批量软删所有已完成 todo（写操作，需要用户确认）',
                      parameters: { type: 'object', properties: {} },
                    },
                  },
                ],
              }
            : {}),
        },
        { signal: params.signal },
      )

      for await (const completion of stream) {
        const choice = completion.choices?.[0]
        const delta = choice?.delta as
          | {
              content?: string | null
              tool_calls?: Array<{
                index: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
            }
          | undefined
        yield {
          text: delta?.content ?? undefined,
          toolCalls: delta?.tool_calls?.map((tc) => ({
            index: tc.index,
            id: tc.id,
            name: tc.function?.name,
            argsDelta: tc.function?.arguments,
          })),
          usage: completion.usage
            ? {
                prompt: completion.usage.prompt_tokens ?? null,
                completion: completion.usage.completion_tokens ?? null,
              }
            : undefined,
          finishReason: choice?.finish_reason ?? undefined,
        }
      }
    },
  }
}
