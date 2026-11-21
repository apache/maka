import type { DueWindow } from './tools'

/** 本地日历日 YYYY-MM-DD；测试可注入 now，避免依赖墙钟 */
export function localCalendarDate(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function matchesDueWindow(
  todo: { dueDate: string | null; status: string },
  window: DueWindow,
  today: string,
): boolean {
  if (window === 'today') return todo.dueDate === today
  if (!todo.dueDate || todo.status === 'done') return false
  return todo.dueDate < today
}
