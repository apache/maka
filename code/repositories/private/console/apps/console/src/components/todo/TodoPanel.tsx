import { useState } from 'react'
import {
  CalendarBlank,
  Check,
  CheckCircle,
  Circle,
  CircleDashed,
  PencilSimple,
  Plus,
  TrashSimple,
  X,
} from '@phosphor-icons/react'
import type { Todo, TodoStatus } from '@ggbdpq/console-shared/todo'
import { cn } from '@ggbdpq/console-ui'
import { useCreateTodo, useDeleteTodo, useTodos, useUpdateTodo } from '@/lib/todo/api/todos'

/** 状态 → 图标与语义色（数据语义色，非装饰色） */
const STATUS_META: Record<TodoStatus, { label: string; cls: string; icon: typeof Circle }> = {
  todo: { label: '待办', cls: 'text-muted-foreground', icon: Circle },
  doing: { label: '进行中', cls: 'text-warning', icon: CircleDashed },
  done: { label: '已完成', cls: 'text-success', icon: CheckCircle },
}

const PRIORITY_LABEL: Record<string, string> = { low: '低', medium: '中', high: '高' }
const PRIORITY_CLS: Record<string, string> = {
  low: 'border-transparent bg-muted text-muted-foreground',
  medium: 'border-transparent bg-warning text-warning-foreground',
  high: 'border-transparent bg-destructive text-destructive-foreground',
}

const today = () => new Date().toISOString().slice(0, 10)

/** 骨架屏：与最终行布局同形（skill 4.5：不用文字 spinner） */
function RowSkeleton() {
  return (
    <li className="flex items-center gap-3 px-1 py-3">
      <div className="size-5 animate-pulse rounded-full bg-muted" />
      <div className="h-4 flex-1 animate-pulse rounded bg-muted" style={{ maxWidth: '55%' }} />
    </li>
  )
}

/** 行内编辑表单：标题 + 优先级 + 截止日期 */
function EditRow({
  todo,
  onSave,
  onCancel,
}: {
  todo: Todo
  onSave: (v: {
    title: string
    priority: 'low' | 'medium' | 'high' | null
    dueDate: string | null
  }) => void
  onCancel: () => void
}) {
  type PrioValue = '' | 'low' | 'medium' | 'high'
  const [title, setTitle] = useState(todo.title)
  const [priority, setPriority] = useState<PrioValue>(todo.priority ?? '')
  const [dueDate, setDueDate] = useState(todo.dueDate ?? '')

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (title.trim()) {
          onSave({
            title: title.trim(),
            priority: priority === '' ? null : priority,
            dueDate: dueDate || null,
          })
        }
      }}
      className="w-full py-1"
    >
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="标题"
          aria-label="待办标题"
          className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
        />
        <button
          type="submit"
          aria-label="保存"
          className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground transition hover:bg-primary/90 active:scale-90"
        >
          <Check size={15} weight="bold" />
        </button>
        <button
          type="button"
          onClick={onCancel}
          aria-label="取消"
          className="grid size-8 shrink-0 place-items-center rounded-md border border-input text-muted-foreground transition hover:bg-accent hover:text-accent-foreground active:scale-90"
        >
          <X size={15} />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <label className="sr-only" htmlFor={`prio-${todo.id}`}>
          优先级
        </label>
        <select
          id={`prio-${todo.id}`}
          value={priority}
          onChange={(e) => setPriority(e.target.value as PrioValue)}
          className="rounded-md border border-input bg-transparent px-2 py-1.5 text-xs text-foreground outline-none focus:border-ring"
        >
          <option value="">无优先级</option>
          <option value="low">低</option>
          <option value="medium">中</option>
          <option value="high">高</option>
        </select>
        <label className="sr-only" htmlFor={`due-${todo.id}`}>
          截止日期
        </label>
        <input
          id={`due-${todo.id}`}
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          className="rounded-md border border-input bg-transparent px-2 py-1.5 text-xs text-foreground outline-none focus:border-ring"
        />
      </div>
    </form>
  )
}

export function TodoPanel() {
  const { data: todos = [], isLoading, error } = useTodos()
  const createTodo = useCreateTodo()
  const updateTodo = useUpdateTodo()
  const deleteTodo = useDeleteTodo()
  const [title, setTitle] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  /** 行内两步删除确认（Vercel：破坏性操作须确认或可撤销；模式与 ConversationHistory 一致） */
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    createTodo.mutate({ title: title.trim() }, { onSuccess: () => setTitle('') })
  }

  const cycleStatus = (t: Todo) => {
    const next: TodoStatus = t.status === 'todo' ? 'doing' : t.status === 'doing' ? 'done' : 'todo'
    updateTodo.mutate({ id: t.id, status: next })
  }

  const counts = {
    todo: todos.filter((t) => t.status === 'todo').length,
    doing: todos.filter((t) => t.status === 'doing').length,
    done: todos.filter((t) => t.status === 'done').length,
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">我的清单</h1>
        <p className="tnum mt-1 text-[13px] text-muted-foreground">
          {counts.todo} 待办 · {counts.doing} 进行 · {counts.done} 完成
        </p>
      </header>

      <form onSubmit={submit} className="mb-2 flex gap-2">
        <label htmlFor="new-todo" className="sr-only">
          新待办标题
        </label>
        <input
          id="new-todo"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="添加一条待办…"
          className="flex-1 rounded-md border border-input bg-transparent px-3.5 py-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20"
        />
        <button
          type="submit"
          disabled={!title.trim() || createTodo.isPending}
          className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100"
        >
          <Plus size={16} weight="bold" />
          添加
        </button>
      </form>

      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          加载失败（{error instanceof Error ? error.message : '未知错误'}）
        </p>
      )}

      <ul className="mt-2 min-h-0 flex-1 divide-y divide-border overflow-y-auto">
        {isLoading && (
          <>
            <RowSkeleton />
            <RowSkeleton />
            <RowSkeleton />
          </>
        )}
        {todos.map((t) => {
          const meta = STATUS_META[t.status]
          const StatusIcon = t.status === 'done' ? CheckCircle : meta.icon
          const overdue = t.dueDate != null && t.dueDate < today() && t.status !== 'done'

          if (editingId === t.id) {
            return (
              <li key={t.id} className="px-1 py-2">
                <EditRow
                  todo={t}
                  onCancel={() => setEditingId(null)}
                  onSave={(v) => {
                    updateTodo.mutate({ id: t.id, ...v })
                    setEditingId(null)
                  }}
                />
              </li>
            )
          }

          return (
            <li key={t.id} className="group flex items-center gap-3 px-1 py-3">
              <button
                onClick={() => cycleStatus(t)}
                title={`${meta.label}（点击切换）`}
                aria-label={`切换状态，当前${meta.label}`}
                className={cn('shrink-0 transition-transform hover:scale-110 active:scale-90', meta.cls)}
              >
                <StatusIcon
                  size={22}
                  weight={t.status === 'done' ? 'fill' : 'regular'}
                  className={t.status === 'doing' ? 'animate-[spin_6s_linear_infinite]' : undefined}
                />
              </button>

              <span className="tnum shrink-0 text-xs text-muted-foreground" title="编号（可在对话中引用，如「把 3 号改为已完成」）">
                #{t.id}
              </span>
              <span
                className={cn(
                  'flex-1 truncate text-sm',
                  t.status === 'done' ? 'text-muted-foreground line-through' : 'text-foreground',
                )}
              >
                {t.title}
                {t.priority && (
                  <span
                    className={cn(
                      'ml-2 rounded-full border px-1.5 py-px text-[11px] leading-4',
                      PRIORITY_CLS[t.priority] ?? PRIORITY_CLS.low,
                    )}
                  >
                    {PRIORITY_LABEL[t.priority] ?? t.priority}
                  </span>
                )}
                {t.dueDate && (
                  <span
                    className={cn(
                      'ml-2 inline-flex items-center gap-0.5 text-[11px]',
                      overdue ? 'text-destructive' : 'text-muted-foreground',
                    )}
                  >
                    <CalendarBlank size={11} />
                    {t.dueDate}
                    {overdue && '（逾期）'}
                  </span>
                )}
              </span>

              {pendingDeleteId === t.id ? (
                <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  确认删除？
                  <button
                    onClick={() => {
                      setPendingDeleteId(null)
                      deleteTodo.mutate(t.id)
                    }}
                    aria-label={`确认删除「${t.title}」`}
                    className="grid size-6 place-items-center rounded-sm text-destructive transition hover:bg-destructive/10 active:scale-[0.95]"
                  >
                    <Check size={14} weight="bold" />
                  </button>
                  <button
                    onClick={() => setPendingDeleteId(null)}
                    aria-label="取消删除"
                    className="grid size-6 place-items-center rounded-sm text-muted-foreground transition hover:bg-accent hover:text-accent-foreground active:scale-[0.95]"
                  >
                    <X size={14} />
                  </button>
                </span>
              ) : (
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  <button
                    onClick={() => {
                      setEditingId(t.id)
                      setPendingDeleteId(null)
                    }}
                    title="编辑"
                    aria-label={`编辑「${t.title}」`}
                    className="rounded-sm p-1.5 text-muted-foreground transition hover:bg-accent hover:text-accent-foreground active:scale-90"
                  >
                    <PencilSimple size={16} />
                  </button>
                  <button
                    onClick={() => setPendingDeleteId(t.id)}
                    title="删除"
                    aria-label={`删除「${t.title}」`}
                    className="rounded-sm p-1.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive active:scale-90"
                  >
                    <TrashSimple size={16} />
                  </button>
                </div>
              )}
            </li>
          )
        })}
        {!isLoading && todos.length === 0 && (
          <li className="py-16 text-center">
            <CircleDashed size={32} className="mx-auto text-muted-foreground/60" />
            <p className="mt-3 text-sm text-muted-foreground">清单还是空的</p>
            <p className="mt-1 text-[13px] text-muted-foreground">
              左上方手动添加，或让智能体帮你记一笔
            </p>
          </li>
        )}
      </ul>
    </section>
  )
}
