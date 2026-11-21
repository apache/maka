import type { Db } from '../db/database'
import { listTodos } from '../db/repo-todos'

/** Q25 定案：注入最近 50 条未删 todo + 总数统计，超限明确告知模型截断 */
const CONTEXT_LIMIT = 50

function renderTodoLine(todo: {
  id: number
  title: string
  status: string
  priority: string | null
  dueDate: string | null
}): string {
  const parts = [`#${todo.id}`, `[${todo.status}]`, todo.title]
  if (todo.priority) parts.push(`优先级:${todo.priority}`)
  if (todo.dueDate) parts.push(`截止:${todo.dueDate}`)
  return `- ${parts.join(' ')}`
}

export function buildSystemPrompt(db: Db, model: string): string {
  const todos = listTodos(db)
  const total = todos.length
  const shown = todos.slice(0, CONTEXT_LIMIT)
  const truncated = total > CONTEXT_LIMIT

  const todoBlock = [
    `当前共有 ${total} 条 todo。`,
    truncated ? `（数量较多，以下仅展示最近 ${CONTEXT_LIMIT} 条，其余已截断；可用 todo_list 工具按条件查询）` : '',
    ...shown.map(renderTodoLine),
  ]
    .filter(Boolean)
    .join('\n')

  return [
    '你是嵌在一个 todo 清单应用里的智能体助手。',
    '你可以查看用户的 todo 数据，回答安排与进度方面的问题；也可以代替用户增删改 todo。',
    '',
    '## 数据（真实当前状态，以后端查询为准）',
    todoBlock,
    '',
    '## 行为规则',
    '1. 回答保持简洁，使用中文。',
    '2. 涉及写操作（新建/修改/删除/清理已完成）时你会调用工具，用户确认后才会真正执行。',
    '3. 用户拒绝或超时未确认时，操作不会执行——请自然地告知用户并继续对话，不要重复发起同一调用。',
    '4. 数据以工具查询结果为准，不要凭空编造 todo。',
    '5. 「今天到期」用 todo_list 的 dueWindow=today；「已逾期」用 dueWindow=overdue。不要自己根据当前时间推算日期。',
    '6. 「清理掉所有已完成的」调用 todo_clear_done（一张确认卡），不要对每条已完成项逐个 todo_delete。',
    '',
    `当前时间：${new Date().toISOString()}（模型：${model}）`,
  ].join('\n')
}
