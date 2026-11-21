import { describe, expect, it } from 'vitest'
import { openDatabase } from '@/server/todo/db/database'
import { createTodo, listTodos, updateTodo } from '@/server/todo/db/repo-todos'
import { executeTool, summarizeToolResult, toolNeedsApproval } from '@/server/todo/agent/tools'

function freshDb() {
  return openDatabase(':memory:')
}

describe('toolNeedsApproval', () => {
  it('todo_clear_done 是写操作，必须过确认', () => {
    expect(toolNeedsApproval('todo_list')).toBe(false)
    expect(toolNeedsApproval('todo_clear_done')).toBe(true)
  })
})

describe('executeTool todo_list dueWindow', () => {
  const today = '2099-01-01'

  it('today 只返回截止日期等于注入日历日的条目', () => {
    const db = freshDb()
    createTodo(db, { title: '今天到期', dueDate: '2099-01-01' })
    createTodo(db, { title: '明天到期', dueDate: '2099-01-02' })
    const result = executeTool(db, 'todo_list', { dueWindow: 'today' }, today) as {
      count: number
      todos: Array<{ title: string }>
    }
    expect(result.count).toBe(1)
    expect(result.todos.map((t) => t.title)).toEqual(['今天到期'])
    db.close()
  })

  it('overdue 排除已完成与无截止日期', () => {
    const db = freshDb()
    createTodo(db, { title: '逾期未做', dueDate: '2098-12-31' })
    const done = createTodo(db, { title: '逾期但已完成', dueDate: '2098-12-01' })
    updateTodo(db, done.id, { status: 'done' })
    createTodo(db, { title: '没有截止日期' })
    const result = executeTool(db, 'todo_list', { dueWindow: 'overdue' }, today) as {
      count: number
      todos: Array<{ title: string }>
    }
    expect(result.todos.map((t) => t.title)).toEqual(['逾期未做'])
    db.close()
  })
})

describe('executeTool todo_clear_done', () => {
  it('一张调用软删全部已完成项', () => {
    const db = freshDb()
    createTodo(db, { title: '还要做' })
    const a = createTodo(db, { title: '完成甲' })
    const b = createTodo(db, { title: '完成乙' })
    updateTodo(db, a.id, { status: 'done' })
    updateTodo(db, b.id, { status: 'done' })

    const result = executeTool(db, 'todo_clear_done', {}) as { deleted: true; count: number; ids: number[] }
    expect(result.deleted).toBe(true)
    expect(result.count).toBe(2)
    expect(listTodos(db).map((t) => t.title)).toEqual(['还要做'])
    expect(summarizeToolResult('todo_clear_done', result)).toBe('已清理 2 条已完成待办')
    db.close()
  })
})
