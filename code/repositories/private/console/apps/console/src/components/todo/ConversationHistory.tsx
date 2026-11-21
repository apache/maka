import { useEffect, useRef, useState } from 'react'
import { Check, Chats, ClockCounterClockwise, TrashSimple, X } from '@phosphor-icons/react'
import type { Conversation } from '@ggbdpq/console-shared/todo'
import { cn } from '@ggbdpq/console-ui'
import { useConversations, useDeleteConversation } from '@/lib/todo/api/conversations'
import { useChat } from '@/lib/todo/chat/store'

/** ISO → 刚刚 / N 分钟前 / N 小时前 / N 天前（超 7 天落绝对日期） */
function formatRelativeTime(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  if (min < 1440) return `${Math.floor(min / 60)} 小时前`
  if (min < 10080) return `${Math.floor(min / 1440)} 天前`
  return iso.slice(0, 10)
}

/** 单条会话行：当前会话高亮；hover 出删除，两步行内确认 */
function ConversationRow({
  conv,
  current,
  pendingDelete,
  busy,
  onSelect,
  onRequestDelete,
  onExecuteDelete,
  onCancelDelete,
}: {
  conv: Conversation
  current: boolean
  pendingDelete: boolean
  busy: boolean
  onSelect: () => void
  onRequestDelete: () => void
  onExecuteDelete: () => void
  onCancelDelete: () => void
}) {
  return (
    <li
      className={cn(
        'group flex items-center gap-2 rounded-md px-2.5 py-2 transition-colors',
        current ? 'bg-primary/10' : 'hover:bg-accent',
      )}
    >
      <button onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        {current && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
        <span className="min-w-0">
          <span
            className={cn('block truncate text-[13px]', current ? 'font-medium text-primary' : 'text-foreground')}
          >
            {conv.title}
          </span>
          <span className="block text-xs text-muted-foreground">
            {formatRelativeTime(conv.updatedAt)}
          </span>
        </span>
      </button>
      {pendingDelete ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          确认删除？
          <button
            onClick={onExecuteDelete}
            aria-label={`确认删除会话 ${conv.id}`}
            className="grid size-6 place-items-center rounded-sm text-destructive transition hover:bg-destructive/10 active:scale-[0.95]"
          >
            <Check size={14} weight="bold" />
          </button>
          <button
            onClick={onCancelDelete}
            aria-label="取消删除"
            className="grid size-6 place-items-center rounded-sm text-muted-foreground transition hover:bg-accent hover:text-accent-foreground active:scale-[0.95]"
          >
            <X size={14} />
          </button>
        </span>
      ) : (
        <button
          onClick={onRequestDelete}
          disabled={busy}
          aria-label={`删除会话 ${conv.id}`}
          className="grid size-7 shrink-0 place-items-center rounded-sm text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive active:scale-[0.95] group-hover:opacity-100 disabled:opacity-0"
        >
          <TrashSimple size={14} />
        </button>
      )}
    </li>
  )
}

/** header「历史」按钮 + 弹出会话列表（切换 / 删除当前会话则重置为新会话） */
export function ConversationHistory({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const { data, isLoading } = useConversations()
  const del = useDeleteConversation()
  const conversationId = useChat((s) => s.conversationId)
  const phase = useChat((s) => s.phase)
  const switchConversation = useChat((s) => s.switchConversation)
  const newConversation = useChat((s) => s.newConversation)
  const busy = phase === 'streaming'

  // 点击外部 / Escape 关闭；关层时重置行内删除确认
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false)
        setPendingDelete(null)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        setPendingDelete(null)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const conversations = data ?? []

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title="历史会话"
        aria-label="历史会话"
        aria-expanded={open}
        className="grid h-[30px] w-[30px] place-items-center rounded-md border border-input bg-background text-muted-foreground transition hover:bg-accent hover:text-accent-foreground active:scale-[0.97] disabled:opacity-40"
      >
        <ClockCounterClockwise size={14} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 w-80 rounded-lg border border-border bg-popover shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
            <span className="text-xs font-medium text-muted-foreground">历史会话</span>
            {conversations.length > 0 && (
              <span className="tnum rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {conversations.length}
              </span>
            )}
          </div>

          <ul className="flex max-h-[320px] flex-col gap-0.5 overflow-y-auto px-1.5 py-1.5">
            {isLoading &&
              [0, 1, 2].map((i) => <li key={i} className="h-11 animate-pulse rounded-md bg-muted" />)}
            {!isLoading && conversations.length === 0 && (
              <li className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
                <Chats size={22} />
                <span className="text-xs">暂无历史会话</span>
              </li>
            )}
            {conversations.map((conv) => (
              <ConversationRow
                key={conv.id}
                conv={conv}
                current={conv.id === conversationId}
                pendingDelete={pendingDelete === conv.id}
                busy={busy}
                onSelect={() => {
                  if (busy || conv.id === conversationId) {
                    setOpen(false)
                    return
                  }
                  switchConversation(conv.id)
                  setOpen(false)
                  setPendingDelete(null)
                }}
                onRequestDelete={() => setPendingDelete(conv.id)}
                onExecuteDelete={() =>
                  del.mutate(conv.id, {
                    onSuccess: () => {
                      setPendingDelete(null)
                      // 删除的是当前会话：面板重置为新会话空态
                      if (conv.id === conversationId) newConversation()
                    },
                  })
                }
                onCancelDelete={() => setPendingDelete(null)}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
