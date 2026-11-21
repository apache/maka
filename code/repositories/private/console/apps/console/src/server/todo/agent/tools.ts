import {
  TodoClearDoneArgsSchema,
  TodoCreateArgsSchema,
  TodoDeleteArgsSchema,
  TodoListArgsSchema,
  TodoUpdateArgsSchema,
  localCalendarDate,
  matchesDueWindow,
  type ToolAction,
} from '@ggbdpq/console-shared/todo'
import type { Db } from '../db/database'
import {
  createTodo,
  getTodoById,
  listTodos,
  softDeleteDoneTodos,
  softDeleteTodo,
  updateTodo,
} from '../db/repo-todos'

/** 写操作清单（§6 工具集）：读直执，写必须过确认（Q1-B 定案） */
const NEEDS_APPROVAL: Record<ToolAction, boolean> = {
  todo_list: false,
  todo_create: true,
  todo_update: true,
  todo_delete: true,
  todo_clear_done: true,
}

export function toolNeedsApproval(action: string): boolean {
  return NEEDS_APPROVAL[action as ToolAction] ?? false
}

/**
 * 执行工具。模型输出的 args 在执行前用 contracts 的 Zod schema 校验——
 * 模型输出不可信是工程前提（§6 边界）。
 * 返回值会作为 tool 消息内容回给模型，因此必须是可 JSON 序列化的结果对象。
 */
export function executeTool(
  db: Db,
  action: string,
  rawArgs: Record<string, unknown>,
  today = localCalendarDate(),
): unknown {
  switch (action) {
    case 'todo_list': {
      const args = TodoListArgsSchema.parse(rawArgs)
      const todos = listTodos(db).filter((t) => {
        if (args.status && t.status !== args.status) return false
        if (args.keyword && !t.title.includes(args.keyword)) return false
        if (args.dueWindow && !matchesDueWindow(t, args.dueWindow, today)) return false
        return true
      })
      return { count: todos.length, todos }
    }
    case 'todo_create': {
      const args = TodoCreateArgsSchema.parse(rawArgs)
      const todo = createTodo(db, args)
      return { created: true, todo }
    }
    case 'todo_update': {
      const args = TodoUpdateArgsSchema.parse(rawArgs)
      const { id, ...patch } = args
      const todo = updateTodo(db, id, patch)
      if (!todo) return { updated: false, error: `todo ${id} 不存在` }
      return { updated: true, todo }
    }
    case 'todo_delete': {
      const args = TodoDeleteArgsSchema.parse(rawArgs)
      const ok = softDeleteTodo(db, args.id)
      return ok ? { deleted: true, id: args.id } : { deleted: false, error: `todo ${args.id} 不存在` }
    }
    case 'todo_clear_done': {
      TodoClearDoneArgsSchema.parse(rawArgs)
      const { count, ids } = softDeleteDoneTodos(db)
      return { deleted: true, count, ids }
    }
    default:
      return { error: `未知工具：${action}` }
  }
}

/** 摘要一条工具结果给 tool 消息的 content（人类可读，raw 结果存 raw_json） */
export function summarizeToolResult(action: string, result: unknown): string {
  const r = result as Record<string, unknown>
  switch (action) {
    case 'todo_list':
      return `查询到 ${r.count} 条 todo`
    case 'todo_create':
      return r.created ? `已创建 todo #${(r.todo as { id: number }).id}` : '创建失败'
    case 'todo_update':
      return r.updated ? `已更新 todo #${(r.todo as { id: number }).id}` : `更新失败：${r.error}`
    case 'todo_delete':
      return r.deleted ? `已删除 todo #${r.id}` : `删除失败：${r.error}`
    case 'todo_clear_done':
      return `已清理 ${r.count} 条已完成待办`
    default:
      return JSON.stringify(result)
  }
}

/** 供路由层校验 id 是否存在（语义化 404 用） */
export { getTodoById }
