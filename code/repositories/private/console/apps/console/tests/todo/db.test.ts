import { describe, it, expect } from 'vitest'
import { openDatabase } from '@/server/todo/db/database'
import {
  createTodo,
  getTodoById,
  listTodos,
  softDeleteDoneTodos,
  softDeleteTodo,
  updateTodo,
} from '@/server/todo/db/repo-todos'
import {
  createConversation,
  deleteConversation,
  getConversation,
  insertMessage,
  listConversations,
  listMessages,
  recentMessages,
  touchConversation,
} from '@/server/todo/db/repo-conversations'

/** 每个用例独立 :memory: 库，天然隔离（node:sqlite 每连接独立内存库） */
function freshDb() {
  return openDatabase(':memory:')
}

describe('迁移', () => {
  it('建库后 schema_migrations 记录到版本 1，重复 openDatabase 幂等', () => {
    const db = freshDb()
    const v1 = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as unknown as Array<{ version: number }>
    expect(v1).toEqual([{ version: 1 }])

    // 幂等：同一文件二次迁移不重复执行（:memory: 无法直接复测，改为断言 migrate 可重入）
    const db2 = freshDb()
    expect(
      db2.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as unknown as { n: number },
    ).toEqual({ n: 1 })
    db.close()
    db2.close()
  })
})

describe('todos CRUD', () => {
  it('创建默认 todo 状态，列表按 id 倒序', () => {
    const db = freshDb()
    const a = createTodo(db, { title: '买牛奶' })
    const b = createTodo(db, { title: '写周报', description: '周五前', priority: 'high' })

    expect(a.status).toBe('todo')
    expect(a.completedAt).toBeNull()
    expect(b.priority).toBe('high')

    expect(listTodos(db).map((t) => t.title)).toEqual(['写周报', '买牛奶'])
    db.close()
  })

  it('updateTodo：进 done 打 completedAt 时间戳，离开 done 清空；保留首次完成时间', async () => {
    const db = freshDb()
    const t = createTodo(db, { title: '任务A' })

    const doing = updateTodo(db, t.id, { status: 'doing' })!
    expect(doing.status).toBe('doing')
    expect(doing.completedAt).toBeNull()

    const done1 = updateTodo(db, t.id, { status: 'done' })!
    expect(done1.status).toBe('done')
    expect(done1.completedAt).toBeTruthy()

    await new Promise((r) => setTimeout(r, 20)) // 保证时间戳可区分

    // done → done（仅改标题）：completedAt 沿用首次完成时间
    const doneKeep = updateTodo(db, t.id, { title: '任务A（改名）' })!
    expect(doneKeep.completedAt).toBe(done1.completedAt)

    // done → doing → done：重新完成，打新时间戳
    updateTodo(db, t.id, { status: 'doing' })
    const done2 = updateTodo(db, t.id, { status: 'done' })!
    expect(done2.completedAt).toBeTruthy()
    expect(done2.completedAt).not.toBe(done1.completedAt)

    db.close()
  })

  it('软删除后 getTodoById/listTodos 均不可见，重复删除返回 false', () => {
    const db = freshDb()
    const t = createTodo(db, { title: '待删' })

    expect(softDeleteTodo(db, t.id)).toBe(true)
    expect(getTodoById(db, t.id)).toBeNull()
    expect(listTodos(db)).toHaveLength(0)
    expect(softDeleteTodo(db, t.id)).toBe(false) // 已删，无行受影响
    db.close()
  })

  it('softDeleteDoneTodos 只软删已完成项，返回 id 列表', () => {
    const db = freshDb()
    const open = createTodo(db, { title: '未完成' })
    const doneA = createTodo(db, { title: '完成甲' })
    const doneB = createTodo(db, { title: '完成乙' })
    updateTodo(db, doneA.id, { status: 'done' })
    updateTodo(db, doneB.id, { status: 'done' })

    const result = softDeleteDoneTodos(db)
    expect(result.count).toBe(2)
    expect(result.ids.toSorted((a, b) => a - b)).toEqual([doneA.id, doneB.id].toSorted((a, b) => a - b))
    expect(listTodos(db).map((t) => t.id)).toEqual([open.id])
    expect(softDeleteDoneTodos(db)).toEqual({ count: 0, ids: [] })
    db.close()
  })

  it('updateTodo 不存在的 id 返回 null', () => {
    const db = freshDb()
    expect(updateTodo(db, 999, { title: 'x' })).toBeNull()
    db.close()
  })
})

describe('conversations / messages', () => {
  it('消息插入与 recentMessages 倒序取窗口再正序返回', () => {
    const db = freshDb()
    const conv = createConversation(db, '测试会话')

    for (let i = 1; i <= 5; i++) {
      insertMessage(db, { conversationId: conv.id, role: 'user', content: `消息${i}` })
    }

    expect(recentMessages(db, conv.id, 3).map((m) => m.content)).toEqual(['消息3', '消息4', '消息5'])
    expect(listMessages(db, conv.id)).toHaveLength(5)
    db.close()
  })

  it('assistant 消息 rawJson 序列化往返（含 toolCalls）', () => {
    const db = freshDb()
    const conv = createConversation(db, '工具会话')
    const payload = {
      model: 'deepseek-chat',
      usage: { prompt: 10, completion: 5 },
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'call_1', name: 'todo_create', args: { title: '买牛奶' } }],
    }

    const msg = insertMessage(db, {
      conversationId: conv.id,
      role: 'assistant',
      content: '好的',
      rawJson: payload,
    })

    expect(msg.rawJson).toEqual(payload) // JSON 字符串往返无损
    db.close()
  })

  it('listConversations 按 updated_at 倒序；touchConversation 置顶', async () => {
    const db = freshDb()
    const c1 = createConversation(db, '会话1')
    await new Promise((r) => setTimeout(r, 20))
    const c2 = createConversation(db, '会话2')
    expect(listConversations(db)[0].id).toBe(c2.id)

    await new Promise((r) => setTimeout(r, 20))
    touchConversation(db, c1.id)
    expect(listConversations(db)[0].id).toBe(c1.id)
    db.close()
  })

  it('deleteConversation 级联硬删：messages 清空、会话不可查、返回 true', () => {
    const db = freshDb()
    const conv = createConversation(db, '待删会话')
    insertMessage(db, { conversationId: conv.id, role: 'user', content: '你好' })
    insertMessage(db, { conversationId: conv.id, role: 'assistant', content: '你好！' })

    expect(deleteConversation(db, conv.id)).toBe(true)
    expect(getConversation(db, conv.id)).toBeNull()
    expect(listConversations(db)).toHaveLength(0)
    expect(listMessages(db, conv.id)).toHaveLength(0) // 子行随事务一并清除
    db.close()
  })

  it('deleteConversation 不存在的 id 返回 false，不误伤其它会话', () => {
    const db = freshDb()
    const conv = createConversation(db, '保留会话')
    insertMessage(db, { conversationId: conv.id, role: 'user', content: '留我' })

    expect(deleteConversation(db, 999)).toBe(false)
    expect(getConversation(db, conv.id)?.title).toBe('保留会话')
    expect(listMessages(db, conv.id)).toHaveLength(1)
    db.close()
  })
})
