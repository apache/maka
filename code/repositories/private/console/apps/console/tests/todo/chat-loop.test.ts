import { describe, it, expect, afterEach } from 'vitest'
import { openDatabase } from '@/server/todo/db/database'
import {
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
} from '@/server/todo/db/repo-conversations'
import { createTodo, listTodos, updateTodo } from '@/server/todo/db/repo-todos'
import { handleChatStream, handleConfirm } from '@/server/todo/chat'
import { serializeError } from '@/server/todo/http'
import { ApprovalRegistry } from '@/server/todo/agent/approvals'
import type { LlmChunk, LlmClient, LlmStreamParams } from '@/server/todo/agent/llm'
import type { SseEvent } from '@ggbdpq/console-shared/todo'
import type { TodoDeps } from '@/server/todo/connection'

// —— 测试基座：进程内路由（Next route handler 等价物）。
// handleChatStream 返回标准 Response（SSE 可读流），confirm 走同一 ApprovalRegistry，
// 与原 Fastify 真网络形态行为一致。 ——

const cleaners: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleaners.length) await cleaners.pop()!()
})

interface ServerHandle {
  db: ReturnType<typeof openDatabase>
  base: string
}

async function startServer(
  llm: LlmClient,
  approvals: ApprovalRegistry = new ApprovalRegistry(),
): Promise<ServerHandle> {
  const db = openDatabase(':memory:')
  const deps: TodoDeps = { db, llm, approvals }
  cleaners.push(async () => {
    db.close()
  })

  /** fetch 等价物：按路径分发到 route handler 同款实现 */
  const request = (path: string, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    if (path === '/api/chat') {
      try {
        return Promise.resolve(handleChatStream(deps, body, init?.signal ?? undefined))
      } catch (err) {
        const { statusCode, body: envelope } = serializeError(err)
        return Promise.resolve(Response.json(envelope, { status: statusCode }))
      }
    }
    const confirm = path.match(/^\/api\/chat\/(\d+)\/confirm$/)
    if (confirm) return Promise.resolve(handleConfirm(deps, Number(confirm[1]), body))
    if (path === '/api/conversations' && (init?.method ?? 'GET') === 'GET') {
      return Promise.resolve(Response.json(listConversations(deps.db)))
    }
    const conv = path.match(/^\/api\/conversations\/(\d+)$/)
    if (conv && init?.method === 'DELETE') {
      const id = Number(conv[1])
      if (!getConversation(deps.db, id)) {
        return Promise.resolve(Response.json({ code: 'NOT_FOUND', message: `会话 ${id} 不存在` }, { status: 404 }))
      }
      if (!deleteConversation(deps.db, id)) {
        return Promise.resolve(Response.json({ code: 'NOT_FOUND', message: `会话 ${id} 不存在` }, { status: 404 }))
      }
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    const msgs = path.match(/^\/api\/conversations\/(\d+)\/messages$/)
    if (msgs && (init?.method ?? 'GET') === 'GET') {
      const id = Number(msgs[1])
      if (!getConversation(deps.db, id)) {
        return Promise.resolve(Response.json({ code: 'NOT_FOUND', message: `会话 ${id} 不存在` }, { status: 404 }))
      }
      return Promise.resolve(Response.json(listMessages(deps.db, id)))
    }
    return Promise.resolve(Response.json({ code: 'NOT_FOUND', message: '接口不存在' }, { status: 404 }))
  }

  activeRequest = request
  return { db, base: 'http://test.local' }
}

/** 当前服务器实例的路由（startServer 设置） */
let activeRequest: ((path: string, init?: RequestInit) => Promise<Response>) | null = null

/** fetch 等价物：接受完整 URL 或路径，分发到当前服务器的 route handler */
function request(pathOrUrl: string, init?: RequestInit): Promise<Response> {
  const path = pathOrUrl.startsWith('http') ? new URL(pathOrUrl).pathname : pathOrUrl
  return activeRequest!(path, init)
}

/** 脚本式 fake：第 i 次 streamChat 调用执行 scripts[i]（抛错的脚本用函数 throw 模拟） */
function fakeLlm(
  scripts: Array<() => Iterable<LlmChunk> | AsyncIterable<LlmChunk>>,
): LlmClient & { calls: LlmStreamParams[] } {
  const calls: LlmStreamParams[] = []
  let i = 0
  return {
    model: 'fake-model',
    calls,
    async *streamChat(params) {
      calls.push(params)
      const script = scripts[i++] ?? (() => [])
      yield* script()
    },
  }
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return request(new URL(url).pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 解析 SSE 流为事件异步迭代器（与前端将实现的解析器同构） */
async function* readSse(res: Response): AsyncGenerator<SseEvent> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))
      if (dataLine) yield JSON.parse(dataLine.slice(6)) as SseEvent
    }
  }
}

/** 收集事件直到终止事件（done/error）；onEvent 在每个事件到达时回调（用于中途 confirm） */
async function collect(
  res: Response,
  onEvent?: (e: SseEvent) => void,
): Promise<SseEvent[]> {
  const events: SseEvent[] = []
  try {
    for await (const e of readSse(res)) {
      events.push(e)
      onEvent?.(e)
      if (e.type === 'done' || e.type === 'error') break
    }
  } catch {
    // 读取端主动 abort 等：已收集部分即返回
  }
  return events
}

const types = (events: SseEvent[]) => events.map((e) => e.type)

// —— 场景组 ——

describe('chat 回路：纯文本', () => {
  it('meta → delta×2 → done；assistant 消息与 usage 落库', async () => {
    const llm = fakeLlm([
      () => [
        { text: '你好' },
        { text: '！' },
        { finishReason: 'stop', usage: { prompt: 10, completion: 5 } },
      ],
    ])
    const { db, base } = await startServer(llm)

    const res = await postJson(`${base}/api/chat`, { message: '打个招呼' })
    const events = await collect(res)

    expect(types(events)).toEqual(['meta', 'delta', 'delta', 'done'])
    expect(events[1]).toMatchObject({ type: 'delta', text: '你好' })
    const done = events[3]
    expect(done.type === 'done' && done.usage).toEqual({ prompt: 10, completion: 5 })

    // 铁律①：事件日志可重建 —— user + assistant 两条消息入库
    const rows = listMessages(db, (events[0] as { conversationId: number }).conversationId)
    expect(rows.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(rows[1].content).toBe('你好！')
  })

  it('首条消息自动建会话，标题截断为前 20 字', async () => {
    const llm = fakeLlm([() => [{ text: 'ok' }, { finishReason: 'stop' }]])
    const { base } = await startServer(llm)
    const res = await postJson(`${base}/api/chat`, { message: 'x'.repeat(30) })
    const events = await collect(res)
    const meta = events[0]
    expect(meta.type === 'meta' && meta.conversationId).toBeGreaterThan(0)

    const convs = (await (await request(`${base}/api/conversations`)).json()) as Array<{
      title: string
    }>
    expect(convs[0].title).toBe('x'.repeat(20) + '…')
  })

  it('携带不存在的 conversationId 返回 404 错误封套', async () => {
    const { base } = await startServer(fakeLlm([]))
    const res = await postJson(`${base}/api/chat`, { conversationId: 999, message: 'hi' })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('message 缺失返回 400 VALIDATION_ERROR', async () => {
    const { base } = await startServer(fakeLlm([]))
    const res = await postJson(`${base}/api/chat`, {})
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})

describe('chat 回路：工具确认（铁律③）', () => {
  // 轮1：流式分片吐出 tool_call（args 跨 chunk 分片）；轮2：收尾
  const toolRound = () => [
    { text: '好的，我来创建。' },
    { toolCalls: [{ index: 0, id: 'call_1', name: 'todo_create', argsDelta: '{"tit' }] },
    { toolCalls: [{ index: 0, argsDelta: 'le":"买牛奶"}' }] },
    { finishReason: 'tool_calls' },
  ]

  it('确认后执行：tool_confirm → confirm API → tool_result(confirmed) → 二轮 → done；DB 真实写入', async () => {
    const llm = fakeLlm([toolRound, () => [{ text: '已创建「买牛奶」' }, { finishReason: 'stop' }]])
    const { db, base } = await startServer(llm)

    const res = await postJson(`${base}/api/chat`, { message: '帮我记一条买牛奶' })
    const events = await collect(res, (e) => {
      if (e.type === 'tool_confirm') {
        // 前端确认卡片等价行为：独立 POST resolve 挂起的 wait()
        void postJson(`${base}/api/chat/${e.messageId}/confirm`, {
          toolCallId: e.toolCallId,
          approved: true,
        })
      }
    })

    expect(types(events)).toEqual([
      'meta', 'delta', 'tool_confirm', 'tool_result', 'delta', 'done',
    ])
    const confirm = events.find((e) => e.type === 'tool_confirm')!
    expect(confirm).toMatchObject({ toolCallId: 'call_1', action: 'todo_create', args: { title: '买牛奶' } })
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({
      toolCallId: 'call_1',
      approved: true,
      status: 'confirmed',
    })

    // 副作用真实发生
    expect(listTodos(db).map((t) => t.title)).toEqual(['买牛奶'])

    // 二轮模型输入包含 tool 回执（铁律①）
    const round2 = llm.calls[1].messages
    expect(round2.at(-2)).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'call_1' }] })
    expect(round2.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call_1' })

    // 事件日志：user → assistant(toolCalls) → tool → assistant(收尾)
    const conv = (events[0] as { conversationId: number }).conversationId
    expect(listMessages(db, conv).map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
  })

  it('拒绝后不执行：tool_result(rejected)，DB 无写入，模型收到 skipped 回执', async () => {
    const llm = fakeLlm([toolRound, () => [{ text: '好的，已取消' }, { finishReason: 'stop' }]])
    const { db, base } = await startServer(llm)

    const res = await postJson(`${base}/api/chat`, { message: '帮我记一条' })
    const events = await collect(res, (e) => {
      if (e.type === 'tool_confirm') {
        void postJson(`${base}/api/chat/${e.messageId}/confirm`, {
          toolCallId: e.toolCallId,
          approved: false,
        })
      }
    })

    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({
      approved: false,
      status: 'rejected',
      summary: '用户拒绝了该操作',
    })
    expect(listTodos(db)).toHaveLength(0)
    // 模型收到 skipped 结果而非数据
    const round2 = JSON.parse(llm.calls[1].messages.at(-1)!.content as string)
    expect(round2).toEqual({ skipped: true, reason: 'rejected' })
  })

  it('确认超时（Q21）：不猝死，timeout 作为 tool 结果回给模型并文本收尾', async () => {
    const llm = fakeLlm([toolRound, () => [{ text: '等太久，先不建了' }, { finishReason: 'stop' }]])
    const { db, base } = await startServer(llm, new ApprovalRegistry(80)) // 注入 80ms 短超时

    const res = await postJson(`${base}/api/chat`, { message: '帮我记一条' })
    const events = await collect(res) // 不调用 confirm，等超时

    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({
      approved: false,
      status: 'timeout',
      summary: '等待确认超时，操作未执行',
    })
    expect(types(events).at(-1)).toBe('done') // 不因超时而 error
    expect(listTodos(db)).toHaveLength(0)
  })

  it('confirm 打错目标（已 resolve/不存在）返回 404 CONFIRM_MISMATCH', async () => {
    const { base } = await startServer(fakeLlm([]))
    const res = await postJson(`${base}/api/chat/1/confirm`, { toolCallId: 'nope', approved: true })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: 'CONFIRM_MISMATCH' })
  })
})

describe('会话管理端点', () => {
  it('DELETE 存在的会话：204 无 body；列表不含该 id，messages 端点 404', async () => {
    const llm = fakeLlm([() => [{ text: 'ok' }, { finishReason: 'stop' }]])
    const { base } = await startServer(llm)
    const res = await postJson(`${base}/api/chat`, { message: '打个招呼' })
    const events = await collect(res)
    const convId = (events[0] as { conversationId: number }).conversationId

    const del = await request(`${base}/api/conversations/${convId}`, { method: 'DELETE' })
    expect(del.status).toBe(204)
    expect(await del.text()).toBe('')

    const list = (await (await request(`${base}/api/conversations`)).json()) as Array<{ id: number }>
    expect(list.map((c) => c.id)).not.toContain(convId)
    const messages = await request(`${base}/api/conversations/${convId}/messages`)
    expect(messages.status).toBe(404)
    expect(await messages.json()).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('DELETE 不存在的 id 返回 404 错误封套', async () => {
    const { base } = await startServer(fakeLlm([]))
    const res = await request(`${base}/api/conversations/999`, { method: 'DELETE' })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('删除会话 A 不误伤会话 B：B 的消息完整，列表排序保持 updated_at DESC', async () => {
    const llm = fakeLlm([
      () => [{ text: 'A' }, { finishReason: 'stop' }],
      () => [{ text: 'B' }, { finishReason: 'stop' }],
    ])
    const { db, base } = await startServer(llm)

    const resA = await postJson(`${base}/api/chat`, { message: '会话A' })
    const eventsA = await collect(resA)
    const idA = (eventsA[0] as { conversationId: number }).conversationId
    const resB = await postJson(`${base}/api/chat`, { message: '会话B' })
    const eventsB = await collect(resB)
    const idB = (eventsB[0] as { conversationId: number }).conversationId

    const del = await request(`${base}/api/conversations/${idA}`, { method: 'DELETE' })
    expect(del.status).toBe(204)

    const rows = listMessages(db, idB)
    expect(rows.map((m) => m.role)).toEqual(['user', 'assistant']) // B 完整
    const list = (await (await request(`${base}/api/conversations`)).json()) as Array<{ id: number }>
    expect(list.map((c) => c.id)).toEqual([idB]) // 仅剩 B
  })

  it('删除后携带 stale conversationId 调 chat 返回 404（不可复用）', async () => {
    const llm = fakeLlm([() => [{ text: 'ok' }, { finishReason: 'stop' }]])
    const { base } = await startServer(llm)
    const res = await postJson(`${base}/api/chat`, { message: '先建会话' })
    const events = await collect(res)
    const convId = (events[0] as { conversationId: number }).conversationId

    await request(`${base}/api/conversations/${convId}`, { method: 'DELETE' })

    const again = await postJson(`${base}/api/chat`, { conversationId: convId, message: '再聊' })
    expect(again.status).toBe(404)
    expect(await again.json()).toMatchObject({ code: 'NOT_FOUND' })
  })
})


describe('chat 回路：容错', () => {
  it('LLM 上游抛错 → error 事件（INTERNAL_ERROR），对话可继续', async () => {
    const llm = fakeLlm([
      () => {
        throw new Error('upstream down')
      },
    ])
    const { base } = await startServer(llm)

    const res = await postJson(`${base}/api/chat`, { message: 'hi' })
    const events = await collect(res)

    expect(types(events)).toEqual(['meta', 'error'])
    expect(events[1]).toMatchObject({ type: 'error', code: 'INTERNAL_ERROR', message: 'upstream down' })
  })

  it('工具参数不合法：Zod 失败作为 tool 结果回给模型，不外抛', async () => {
    const llm = fakeLlm([
      () => [
        { toolCalls: [{ index: 0, id: 'call_bad', name: 'todo_create', argsDelta: '{"priority":"urgent"}' }] },
        { finishReason: 'tool_calls' },
      ],
      () => [{ text: '参数不合法，我重新问' }, { finishReason: 'stop' }],
    ])
    const { db, base } = await startServer(llm)

    const res = await postJson(`${base}/api/chat`, { message: '建一条' })
    const events = await collect(res, (e) => {
      if (e.type === 'tool_confirm') {
        void postJson(`${base}/api/chat/${e.messageId}/confirm`, { toolCallId: e.toolCallId, approved: true })
      }
    })

    expect(types(events).at(-1)).toBe('done')
    expect(listTodos(db)).toHaveLength(0) // 非法参数未写入
    const round2 = JSON.parse(llm.calls[1].messages.at(-1)!.content as string)
    expect(round2.error).toBeTruthy() // 模型收到错误说明
  })

  it('客户端断线（Q22）：中止上游、已生成内容以 finishReason=aborted 落库', async () => {
    const llm = fakeLlm([
      // 慢吐 5 片（30ms/片），给测试留断线窗口
      async function* () {
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 30))
          yield { text: `片段${i}；` }
        }
        yield { finishReason: 'stop' }
      },
    ])
    const { db, base } = await startServer(llm)

    const controller = new AbortController()
    const res = await request(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '写篇长文' }),
      signal: controller.signal,
    })

    let conversationId = 0
    for await (const e of readSse(res)) {
      if (e.type === 'meta') {
        conversationId = e.conversationId
        break
      }
    }
    controller.abort() // 客户端断开

    await new Promise((r) => setTimeout(r, 400)) // 等服务端 flush

    const rows = listMessages(db, conversationId)
    expect(rows[0].role).toBe('user')
    const partial = rows.at(-1)!
    expect(partial.role).toBe('assistant')
    expect(partial.content).toContain('片段') // 已生成部分被保留
    expect((partial.rawJson as { finishReason: string }).finishReason).toBe('aborted')
  })
})

describe('chat 回路：todo_clear_done 一张确认卡', () => {
  it('确认后批量软删已完成项，未完成项保留', async () => {
    const llm = fakeLlm([
      () => [
        { text: '我来清理已完成的。' },
        { toolCalls: [{ index: 0, id: 'call_clear', name: 'todo_clear_done', argsDelta: '{}' }] },
        { finishReason: 'tool_calls' },
      ],
      () => [{ text: '已清理完成项。' }, { finishReason: 'stop' }],
    ])
    const { db, base } = await startServer(llm)
    const keep = createTodo(db, { title: '还要做' })
    const done = createTodo(db, { title: '已经做完' })
    updateTodo(db, done.id, { status: 'done' })

    const res = await postJson(`${base}/api/chat`, { message: '清理掉所有已完成的' })
    const events = await collect(res, (e) => {
      if (e.type === 'tool_confirm') {
        void postJson(`${base}/api/chat/${e.messageId}/confirm`, {
          toolCallId: e.toolCallId,
          approved: true,
        })
      }
    })

    const confirms = events.filter((e) => e.type === 'tool_confirm')
    expect(confirms).toHaveLength(1)
    expect(confirms[0]).toMatchObject({ action: 'todo_clear_done', args: {} })
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({
      approved: true,
      status: 'confirmed',
    })
    expect(listTodos(db).map((t) => t.id)).toEqual([keep.id])
  })
})
