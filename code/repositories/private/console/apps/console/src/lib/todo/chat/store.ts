import { create } from 'zustand'
import type { Message, ToolAction } from '@ggbdpq/console-shared/todo'
import { streamChat } from './sse'

/** 单条消息的 UI 态：流式中(partial) / 等确认(waiting_confirm) / 定稿(done) / 失败(error) */
export interface ChatItem {
  key: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  status: 'partial' | 'waiting_confirm' | 'done' | 'error'
  /** 等待用户确认的写操作（tool_confirm 事件挂载，tool_result 事件定稿） */
  confirm?: {
    messageId: number
    toolCallId: string
    action: ToolAction
    args: Record<string, unknown>
    outcome?: { approved: boolean; status: string; summary: string }
  }
}

type Phase = 'idle' | 'streaming' | 'error'

interface ChatState {
  conversationId: number | null
  items: ChatItem[]
  phase: Phase
  errorMessage: string
  /** 发送消息并驱动整个流（七步流水线的前端半场） */
  send: (text: string) => Promise<void>
  /** 停止当前生成；已输出文字保留，不当网络错误 */
  stop: () => void
  /** 确认卡片回调：独立 POST resolve 服务端挂起的 wait() */
  confirm: (itemKey: string, approved: boolean) => Promise<void>
  /** 载入会话历史；不传 id 则从 localStorage 取（铁律①：事件日志可重建 UI） */
  loadHistory: (conversationId?: number) => Promise<void>
  /** 切换到历史会话（流式/等待确认期间拒绝，UI 层另禁用为双保险） */
  switchConversation: (id: number) => void
  newConversation: () => void
}

const HISTORY_KEY = 'agent-todo.conversationId'
let seq = 0
const nextKey = () => `local-${++seq}`
let currentAbort: AbortController | null = null

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function keepGeneratedIdle(assistantKey: string) {
  return (s: ChatState) => ({
    phase: 'idle' as const,
    errorMessage: '',
    items: s.items.map((i) =>
      i.key === assistantKey && i.status === 'partial' ? { ...i, status: 'done' as const } : i,
    ),
  })
}

function storedConversationId(): number | null {
  // SSR/预渲染环境无 localStorage（Next build 会执行模块级初始化）
  if (typeof window === 'undefined') return null
  const v = localStorage.getItem(HISTORY_KEY)
  return v ? Number(v) : null
}

/** 服务端消息 → UI 条目（历史回放） */
function fromMessage(m: Message): ChatItem[] {
  if (m.role === 'assistant') {
    const calls = m.rawJson && 'toolCalls' in m.rawJson ? m.rawJson.toolCalls ?? [] : []
    if (calls.length && !m.content.trim()) return [] // 纯工具调用的 assistant 轮不单独展示
    return [{ key: `srv-${m.id}`, role: 'assistant', text: m.content, status: 'done' }]
  }
  if (m.role === 'tool') {
    const r = m.rawJson && 'toolCallId' in m.rawJson ? m.rawJson : null
    return [
      {
        key: `srv-${m.id}`,
        role: 'tool',
        text: r?.result ? JSON.stringify(r.result) : m.content,
        status: 'done',
        confirm: r
          ? {
              messageId: m.id,
              toolCallId: r.toolCallId,
              action: r.action as ToolAction,
              args: {},
              outcome: { approved: r.approved, status: r.status, summary: m.content },
            }
          : undefined,
      },
    ]
  }
  return [{ key: `srv-${m.id}`, role: 'user', text: m.content, status: 'done' }]
}

export const useChat = create<ChatState>((set, get) => ({
  conversationId: storedConversationId(),
  items: [],
  phase: 'idle',
  errorMessage: '',

  send: async (text) => {
    const { phase, conversationId } = get()
    if (phase === 'streaming' || !text.trim()) return

    const userKey = nextKey()
    const assistantKey = nextKey()
    set((s) => ({
      phase: 'streaming',
      errorMessage: '',
      items: [
        ...s.items,
        { key: userKey, role: 'user', text, status: 'done' },
        { key: assistantKey, role: 'assistant', text: '', status: 'partial' },
      ],
    }))

    const ac = new AbortController()
    currentAbort = ac

    try {
      for await (const e of streamChat(
        { conversationId: conversationId ?? undefined, message: text },
        ac.signal,
      )) {
        switch (e.type) {
          case 'meta':
            localStorage.setItem(HISTORY_KEY, String(e.conversationId))
            set({ conversationId: e.conversationId })
            break
          case 'delta':
            set((s) => ({
              items: s.items.map((i) => (i.key === assistantKey ? { ...i, text: i.text + e.text } : i)),
            }))
            break
          case 'tool_confirm':
            set((s) => ({
              items: s.items.map((i) =>
                i.key === assistantKey
                  ? {
                      ...i,
                      status: 'waiting_confirm',
                      confirm: {
                        messageId: e.messageId,
                        toolCallId: e.toolCallId,
                        action: e.action,
                        args: e.args,
                      },
                    }
                  : i,
              ),
            }))
            break
          case 'tool_result':
            set((s) => ({
              items: s.items.map((i) =>
                i.confirm && i.confirm.toolCallId === e.toolCallId
                  ? {
                      ...i,
                      status: 'partial', // 工具定稿后模型继续生成
                      confirm: {
                        ...i.confirm,
                        outcome: { approved: e.approved, status: e.status, summary: e.summary },
                      },
                    }
                  : i,
              ),
            }))
            break
          case 'done':
            currentAbort = null
            set((s) => ({
              phase: 'idle',
              items: s.items.map((i) =>
                i.key === assistantKey && i.status !== 'done' ? { ...i, status: 'done' } : i,
              ),
            }))
            return
          case 'error':
            currentAbort = null
            set((s) => ({
              phase: 'error',
              errorMessage: e.message,
              items: s.items.map((i) =>
                i.key === assistantKey ? { ...i, status: 'error' } : i,
              ),
            }))
            return
        }
      }
      if (ac.signal.aborted) {
        currentAbort = null
        set(keepGeneratedIdle(assistantKey))
        return
      }
      // 流意外终止（服务端关闭）且未收到 done
      set((s) => ({ phase: 'error', errorMessage: '连接中断', items: s.items.map((i) => (i.key === assistantKey ? { ...i, status: 'error' } : i)) }))
    } catch (err) {
      currentAbort = null
      if (ac.signal.aborted || isAbortError(err)) {
        set(keepGeneratedIdle(assistantKey))
        return
      }
      set((s) => ({
        phase: 'error',
        errorMessage: err instanceof Error ? err.message : '网络错误',
        items: s.items.map((i) => (i.key === assistantKey ? { ...i, status: 'error' } : i)),
      }))
    }
  },

  stop: () => {
    const pending = get().items.some((i) => i.status === 'waiting_confirm' && !i.confirm?.outcome)
    if (get().phase !== 'streaming' || pending) return
    currentAbort?.abort()
  },

  confirm: async (itemKey, approved) => {
    const item = get().items.find((i) => i.key === itemKey)
    if (!item?.confirm || item.confirm.outcome) return
    // 乐观置灰按钮；真实结果由 tool_result 事件回填
    await fetch(`/api/todo/chat/${item.confirm.messageId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallId: item.confirm.toolCallId, approved }),
    }).catch(() => {
      set((s) => ({
        items: s.items.map((i) =>
          i.key === itemKey && i.confirm
            ? { ...i, confirm: { ...i.confirm, outcome: { approved: false, status: 'rejected', summary: '确认请求发送失败' } } }
            : i,
        ),
      }))
    })
  },

  loadHistory: async (conversationId) => {
    const id = conversationId ?? storedConversationId()
    if (!id) return
    try {
      const res = await fetch(`/api/todo/conversations/${id}/messages`)
      // 竞态防御：请求返回期间用户可能又切走了会话（含 404 清态分支也不应波及新会话）
      if (get().conversationId !== id) return
      if (!res.ok) {
        localStorage.removeItem(HISTORY_KEY)
        set({ conversationId: null, items: [] })
        return
      }
      const messages = (await res.json()) as Message[]
      set({ conversationId: id, items: messages.flatMap(fromMessage) })
    } catch {
      // 服务端未启动等情况：保持空列表，不阻塞 UI
    }
  },

  switchConversation: (id) => {
    if (get().phase === 'streaming') return
    localStorage.setItem(HISTORY_KEY, String(id))
    set({ conversationId: id, items: [], phase: 'idle', errorMessage: '' })
    void get().loadHistory(id)
  },

  newConversation: () => {
    localStorage.removeItem(HISTORY_KEY)
    set({ conversationId: null, items: [], phase: 'idle', errorMessage: '' })
  },
}))
