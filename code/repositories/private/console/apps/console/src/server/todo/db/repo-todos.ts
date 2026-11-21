import type { Db } from './database'
import type { Todo, TodoStatus } from '@ggbdpq/console-shared/todo'

interface TodoRow {
  id: number
  title: string
  description: string | null
  status: string
  priority: string | null
  due_date: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  deleted_at: string | null
}

function toEntity(row: TodoRow): Todo {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as Todo['status'],
    priority: (row.priority as Todo['priority']) ?? null,
    dueDate: row.due_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

const BASE_COLUMNS = `
  id, title, description, status, priority, due_date,
  created_at, updated_at, completed_at, deleted_at
`

export interface TodoPatch {
  title?: string
  description?: string | null
  status?: TodoStatus
  priority?: string | null
  dueDate?: string | null
}

export function listTodos(db: Db): Todo[] {
  const rows = db
    .prepare(`SELECT ${BASE_COLUMNS} FROM todos WHERE deleted_at IS NULL ORDER BY id DESC`)
    .all() as unknown as TodoRow[]
  return rows.map(toEntity)
}

export function getTodoById(db: Db, id: number): Todo | null {
  const row = db
    .prepare(`SELECT ${BASE_COLUMNS} FROM todos WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as unknown as TodoRow | undefined
  return row ? toEntity(row) : null
}

export function createTodo(
  db: Db,
  input: { title: string; description?: string; priority?: string; dueDate?: string },
): Todo {
  const now = new Date().toISOString()
  const result = db
    .prepare(
      `INSERT INTO todos (title, description, status, priority, due_date, created_at, updated_at)
       VALUES (?, ?, 'todo', ?, ?, ?, ?)`,
    )
    .run(input.title, input.description ?? null, input.priority ?? null, input.dueDate ?? null, now, now)
  return getTodoById(db, Number(result.lastInsertRowid))!
}

export function updateTodo(db: Db, id: number, patch: TodoPatch): Todo | null {
  const current = getTodoById(db, id)
  if (!current) return null

  const next = {
    title: patch.title ?? current.title,
    description: patch.description !== undefined ? patch.description : current.description,
    status: patch.status ?? current.status,
    priority: patch.priority !== undefined ? patch.priority : current.priority,
    dueDate: patch.dueDate !== undefined ? patch.dueDate : current.dueDate,
  }
  // completed_at 语义：进入 done 打时间戳，离开 done 清空
  const completedAt =
    next.status === 'done'
      ? (current.completedAt ?? new Date().toISOString())
      : null

  db.prepare(
    `UPDATE todos
     SET title = ?, description = ?, status = ?, priority = ?, due_date = ?,
         completed_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    next.title,
    next.description ?? null,
    next.status,
    next.priority ?? null,
    next.dueDate ?? null,
    completedAt,
    new Date().toISOString(),
    id,
  )
  return getTodoById(db, id)
}

/** 软删除（Q19 定案：数据安全网，查询永远过滤 deleted_at IS NULL） */
export function softDeleteTodo(db: Db, id: number): boolean {
  const result = db
    .prepare('UPDATE todos SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(new Date().toISOString(), new Date().toISOString(), id)
  return result.changes > 0
}

/** 批量软删已完成项；未完成与已软删的不动 */
export function softDeleteDoneTodos(db: Db): { count: number; ids: number[] } {
  const rows = db
    .prepare(`SELECT id FROM todos WHERE status = 'done' AND deleted_at IS NULL`)
    .all() as unknown as Array<{ id: number }>
  const ids: number[] = []
  for (const row of rows) {
    if (softDeleteTodo(db, row.id)) ids.push(row.id)
  }
  return { count: ids.length, ids }
}
