const PRIORITY_LABEL: Record<string, string> = { low: '低', medium: '中', high: '高' }
const STATUS_LABEL: Record<string, string> = { todo: '待办', doing: '进行中', done: '已完成' }

/** 确认卡人类可读摘要（不把 JSON 甩给用户） */
export function formatConfirmSummary(action: string, args: Record<string, unknown>): string {
  switch (action) {
    case 'todo_create': {
      const parts = [`新建待办：${String(args.title ?? '')}`]
      if (typeof args.priority === 'string' && PRIORITY_LABEL[args.priority]) {
        parts.push(`优先级${PRIORITY_LABEL[args.priority]}`)
      }
      if (typeof args.dueDate === 'string' && args.dueDate) {
        parts.push(`截止 ${args.dueDate}`)
      }
      return parts.join(' / ')
    }
    case 'todo_update': {
      const id = args.id
      const changes: string[] = []
      if (typeof args.title === 'string') changes.push(`标题改为「${args.title}」`)
      if (typeof args.status === 'string') {
        changes.push(`状态改为${STATUS_LABEL[args.status] ?? args.status}`)
      }
      if (typeof args.priority === 'string') {
        changes.push(`优先级改为${PRIORITY_LABEL[args.priority] ?? args.priority}`)
      }
      if (args.dueDate === null) changes.push('清空截止日期')
      else if (typeof args.dueDate === 'string') changes.push(`截止日期改为 ${args.dueDate}`)
      const head = `修改待办 #${id}`
      return changes.length ? `${head}：${changes.join('，')}` : head
    }
    case 'todo_delete':
      return `删除待办 #${args.id}`
    case 'todo_clear_done':
      return '清理所有已完成待办'
    default:
      return action
  }
}
