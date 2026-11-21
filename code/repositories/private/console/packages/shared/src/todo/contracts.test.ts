import { describe, expect, it } from 'vitest'
import {
  ChatRequestSchema,
  ConfirmRequestSchema,
  CreateTodoInputSchema,
  EnvSchema,
  ErrorEnvelopeSchema,
  SseEventSchema,
  TodoClearDoneArgsSchema,
  TodoListArgsSchema,
  TodoSchema,
  ToolActionSchema,
  UpdateTodoInputSchema,
  encodeSseEvent,
  exportConversationJson,
  exportConversationText,
  filterChatItems,
  formatConfirmSummary,
  interpretChatKey,
  lastUserText,
  matchesDueWindow,
} from './index'

const validTodo = {
  id: 1,
  title: '写周报',
  description: null,
  status: 'todo',
  priority: 'high',
  dueDate: null,
  createdAt: '2026-08-15T08:00:00.000Z',
  updatedAt: '2026-08-15T08:00:00.000Z',
  completedAt: null,
}

describe('todo schemas', () => {
  it('接受合法 todo', () => {
    expect(TodoSchema.parse(validTodo)).toBeTruthy()
  })

  it('拒绝非法状态与非法时间戳', () => {
    expect(TodoSchema.safeParse({ ...validTodo, status: 'archived' }).success).toBe(false)
    expect(TodoSchema.safeParse({ ...validTodo, createdAt: '昨天' }).success).toBe(false)
  })

  it('新增输入：title 必填且非空', () => {
    expect(CreateTodoInputSchema.safeParse({ title: '' }).success).toBe(false)
    expect(CreateTodoInputSchema.parse({ title: 'a', priority: 'low' })).toBeTruthy()
  })

  it('修改输入：空 patch 被拒绝', () => {
    expect(UpdateTodoInputSchema.safeParse({}).success).toBe(false)
    expect(UpdateTodoInputSchema.parse({ status: 'done' })).toBeTruthy()
  })
})

describe('chat schemas', () => {
  it('省略 conversationId 即新会话', () => {
    expect(ChatRequestSchema.parse({ message: '帮我看看今天做什么' })).toBeTruthy()
  })

  it('空消息被拒绝', () => {
    expect(ChatRequestSchema.safeParse({ message: '' }).success).toBe(false)
  })

  it('确认请求必带 toolCallId 与布尔 approved', () => {
    expect(ConfirmRequestSchema.safeParse({ toolCallId: 'call_1', approved: 'yes' }).success).toBe(false)
    expect(ConfirmRequestSchema.parse({ toolCallId: 'call_1', approved: true })).toBeTruthy()
  })
})

describe('sse events', () => {
  it('六类事件均可解析', () => {
    const events = [
      { type: 'meta', conversationId: 1, userMessageId: 3, model: 'deepseek-chat' },
      { type: 'delta', text: '你好' },
      { type: 'tool_confirm', messageId: 2, toolCallId: 'call_1', action: 'todo_delete', args: { id: 3 } },
      { type: 'tool_result', toolCallId: 'call_1', approved: true, status: 'confirmed', summary: '已删除 todo #3' },
      { type: 'done', messageId: 2, usage: { prompt: 100, completion: 20 } },
      { type: 'error', code: 'LLM_ERROR', message: '上游超时' },
    ]
    for (const e of events) expect(SseEventSchema.parse(e)).toBeTruthy()
  })

  it('未知事件类型被拒绝（协议漂移在解析期归零）', () => {
    expect(SseEventSchema.safeParse({ type: 'heartbeat' }).success).toBe(false)
  })

  it('encodeSseEvent 输出标准 SSE 帧', () => {
    const frame = encodeSseEvent({ type: 'delta', text: 'hi' })
    expect(frame).toBe('event: delta\ndata: {"type":"delta","text":"hi"}\n\n')
  })
})

describe('env schema', () => {
  it('缺 API key 时报错并给出字段提示', () => {
    const result = EnvSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('model 与 baseURL 有默认值', () => {
    const env = EnvSchema.parse({ DEEPSEEK_API_KEY: 'sk-test', PORT: '3000' })
    expect(env.DEEPSEEK_MODEL).toBe('deepseek-chat')
    expect(env.DEEPSEEK_BASE_URL).toBe('https://api.deepseek.com')
    expect(env.PORT).toBe(3000)
  })
})

describe('error envelope', () => {
  it('接受合法 envelope，拒绝未知错误码', () => {
    expect(ErrorEnvelopeSchema.parse({ code: 'NOT_FOUND', message: 'x' })).toBeTruthy()
    expect(ErrorEnvelopeSchema.safeParse({ code: 'WOOPS', message: 'x' }).success).toBe(false)
  })
})

describe('todo_list dueWindow / todo_clear_done schemas', () => {
  it('dueWindow 只接受 today 与 overdue', () => {
    expect(TodoListArgsSchema.parse({ dueWindow: 'today' })).toEqual({ dueWindow: 'today' })
    expect(TodoListArgsSchema.parse({ dueWindow: 'overdue' })).toEqual({ dueWindow: 'overdue' })
    expect(TodoListArgsSchema.safeParse({ dueWindow: 'week' }).success).toBe(false)
  })

  it('todo_clear_done 接受空对象', () => {
    expect(TodoClearDoneArgsSchema.parse({})).toEqual({})
  })

  it('ToolAction 含 todo_clear_done，SSE 确认事件可解析', () => {
    expect(ToolActionSchema.parse('todo_clear_done')).toBe('todo_clear_done')
    expect(
      SseEventSchema.parse({
        type: 'tool_confirm',
        messageId: 2,
        toolCallId: 'call_c',
        action: 'todo_clear_done',
        args: {},
      }),
    ).toBeTruthy()
  })
})

describe('matchesDueWindow', () => {
  const today = '2026-08-18'

  it('today 只匹配截止日期等于今天的条目', () => {
    expect(matchesDueWindow({ dueDate: '2026-08-18', status: 'todo' }, 'today', today)).toBe(true)
    expect(matchesDueWindow({ dueDate: '2026-08-19', status: 'todo' }, 'today', today)).toBe(false)
    expect(matchesDueWindow({ dueDate: null, status: 'todo' }, 'today', today)).toBe(false)
  })

  it('overdue 要求有截止日期、早于今天、且未完成', () => {
    expect(matchesDueWindow({ dueDate: '2026-08-17', status: 'todo' }, 'overdue', today)).toBe(true)
    expect(matchesDueWindow({ dueDate: '2026-08-17', status: 'doing' }, 'overdue', today)).toBe(true)
    expect(matchesDueWindow({ dueDate: '2026-08-17', status: 'done' }, 'overdue', today)).toBe(false)
    expect(matchesDueWindow({ dueDate: '2026-08-18', status: 'todo' }, 'overdue', today)).toBe(false)
    expect(matchesDueWindow({ dueDate: null, status: 'todo' }, 'overdue', today)).toBe(false)
  })
})

describe('formatConfirmSummary', () => {
  it('新建：标题 + 可选优先级与截止日期', () => {
    expect(formatConfirmSummary('todo_create', { title: '买牛奶' })).toBe('新建待办：买牛奶')
    expect(
      formatConfirmSummary('todo_create', { title: '买牛奶', priority: 'high', dueDate: '2026-08-19' }),
    ).toBe('新建待办：买牛奶 / 优先级高 / 截止 2026-08-19')
  })

  it('修改：编号 + 变更字段', () => {
    expect(formatConfirmSummary('todo_update', { id: 3, status: 'done' })).toBe(
      '修改待办 #3：状态改为已完成',
    )
  })

  it('删除与批量清理', () => {
    expect(formatConfirmSummary('todo_delete', { id: 3 })).toBe('删除待办 #3')
    expect(formatConfirmSummary('todo_clear_done', {})).toBe('清理所有已完成待办')
  })
})

describe('exportConversation / filterChatItems / lastUserText', () => {
  const items = [
    { role: 'user', text: '记一条买牛奶' },
    { role: 'assistant', text: '好的，已记下买牛奶' },
  ]

  it('导出 txt 带角色前缀', () => {
    expect(exportConversationText(items)).toBe('用户：记一条买牛奶\n\n助手：好的，已记下买牛奶')
  })

  it('导出 json 含会话 id 与消息', () => {
    expect(JSON.parse(exportConversationJson(items, 7))).toEqual({
      conversationId: 7,
      messages: items,
    })
  })

  it('空查询不过滤；按文本包含匹配', () => {
    expect(filterChatItems(items, '')).toEqual(items)
    expect(filterChatItems(items, '牛奶').map((i) => i.role)).toEqual(['user', 'assistant'])
    expect(filterChatItems(items, '周报')).toEqual([])
  })

  it('取最近一条用户消息', () => {
    expect(lastUserText(items)).toBe('记一条买牛奶')
    expect(lastUserText([{ role: 'assistant', text: 'hi' }])).toBeNull()
  })
})

describe('interpretChatKey', () => {
  it('Esc：等确认时拒绝，流式中停止', () => {
    expect(
      interpretChatKey({ key: 'Escape', ctrlKey: false, metaKey: false }, { inputEmpty: false, streaming: true, waitingConfirm: true }),
    ).toBe('reject-confirm')
    expect(
      interpretChatKey({ key: 'Escape', ctrlKey: false, metaKey: false }, { inputEmpty: false, streaming: true, waitingConfirm: false }),
    ).toBe('stop')
  })

  it('空输入框 ArrowUp 回填上一条用户消息', () => {
    expect(
      interpretChatKey({ key: 'ArrowUp', ctrlKey: false, metaKey: false }, { inputEmpty: true, streaming: false, waitingConfirm: false }),
    ).toBe('fill-last-user')
    expect(
      interpretChatKey({ key: 'ArrowUp', ctrlKey: false, metaKey: false }, { inputEmpty: false, streaming: false, waitingConfirm: false }),
    ).toBeNull()
  })

  it('Ctrl/Cmd+F 打开会话内搜索', () => {
    expect(interpretChatKey({ key: 'f', ctrlKey: true, metaKey: false }, { inputEmpty: true, streaming: false, waitingConfirm: false })).toBe(
      'search',
    )
    expect(interpretChatKey({ key: 'f', ctrlKey: false, metaKey: true }, { inputEmpty: true, streaming: false, waitingConfirm: false })).toBe(
      'search',
    )
  })
})
