import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowCounterClockwise,
  ArrowLineRight,
  Copy,
  DownloadSimple,
  MagnifyingGlass,
  PaperPlaneTilt,
  ShieldCheck,
  Sparkle,
  Stop,
  Warning,
} from '@phosphor-icons/react'
import {
  exportConversationJson,
  exportConversationText,
  filterChatItems,
  formatConfirmSummary,
  interpretChatKey,
  lastUserText,
} from '@ggbdpq/console-shared/todo'
import { cn } from '@ggbdpq/console-ui'
import { useChat, type ChatItem } from '@/lib/todo/chat/store'
import { ConversationHistory } from './ConversationHistory'

const ACTION_LABEL: Record<string, string> = {
  todo_create: '新建待办',
  todo_update: '修改待办',
  todo_delete: '删除待办',
  todo_clear_done: '清理已完成',
  todo_list: '查询列表',
}

function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  if (!text) return null
  return (
    <button
      type="button"
      title="复制"
      aria-label="复制消息"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1200)
        })
      }}
      className="rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-accent-foreground"
    >
      {copied ? '已复制' : <Copy size={13} />}
    </button>
  )
}

/** 确认卡片（铁律③：写操作过用户门禁） */
function ConfirmCard({ item, onConfirm }: { item: ChatItem; onConfirm: (approved: boolean) => void }) {
  const c = item.confirm!
  return (
    <div className="mt-2.5 rounded-lg border border-warning/40 bg-warning/10 px-3.5 py-3">
      <p className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
        <ShieldCheck size={16} weight="fill" className="shrink-0 text-warning" />
        请求执行「{ACTION_LABEL[c.action] ?? c.action}」，等你确认
      </p>
      <p className="mt-2 text-sm leading-6 text-foreground">{formatConfirmSummary(c.action, c.args)}</p>
      {c.outcome ? (
        <p
          className={cn('mt-2 text-xs', c.outcome.approved ? 'text-success' : 'text-muted-foreground')}
        >
          {c.outcome.summary}
        </p>
      ) : (
        <div className="mt-2.5 flex gap-2">
          <button
            onClick={() => onConfirm(true)}
            className="rounded-md bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 active:scale-[0.97]"
          >
            批准执行
          </button>
          <button
            onClick={() => onConfirm(false)}
            className="rounded-md border border-input bg-background px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-accent-foreground active:scale-[0.97]"
          >
            拒绝
          </button>
        </div>
      )}
    </div>
  )
}

function Bubble({ item, onConfirm }: { item: ChatItem; onConfirm: (k: string, ok: boolean) => void }) {
  if (item.role === 'user') {
    return (
      <div className="group flex justify-end gap-1.5">
        <CopyButton text={item.text} />
        <div className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-br-md bg-primary px-3.5 py-2 text-sm leading-relaxed text-primary-foreground">
          {item.text}
        </div>
      </div>
    )
  }

  const streaming = item.status === 'partial'
  return (
    <div className="group flex justify-start gap-2.5">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
        <Sparkle size={14} weight="fill" />
      </span>
      <div className="max-w-[85%] rounded-xl rounded-bl-md border border-border bg-card px-3.5 py-2 shadow-sm">
        <p
          className={cn(
            'whitespace-pre-wrap text-sm leading-relaxed',
            item.status === 'error' ? 'text-destructive' : 'text-foreground',
          )}
        >
          {item.text}
          {streaming && item.text && (
            <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse rounded bg-primary align-middle" />
          )}
        </p>
        {streaming && !item.text && (
          <span className="flex gap-1 py-1" aria-label="生成中">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="size-1.5 animate-bounce rounded-full bg-muted-foreground/40"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </span>
        )}
        {item.status === 'error' && !item.text && (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <Warning size={14} weight="fill" />
            生成失败，请重试
          </p>
        )}
        {item.confirm && <ConfirmCard item={item} onConfirm={(ok) => onConfirm(item.key, ok)} />}
      </div>
      <CopyButton text={item.text} />
    </div>
  )
}

export function ChatPanel({ onClose }: { onClose: () => void }) {
  const { items, phase, errorMessage, send, stop, confirm, loadHistory, newConversation, conversationId } =
    useChat()
  const [input, setInput] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const qc = useQueryClient()
  const bottomRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [items])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text || phase === 'streaming') return
    setInput('')
    void send(text)
  }

  /** 智能体改完数据后刷新左侧清单 */
  useEffect(() => {
    const last = items.at(-1)
    if (last?.confirm?.outcome?.approved) void qc.invalidateQueries({ queryKey: ['todos'] })
  }, [items, qc])

  /** 流式结束（done/error 落定）后刷新会话列表：新会话入列 + updated_at 重排序 */
  const prevPhase = useRef(phase)
  useEffect(() => {
    if (prevPhase.current === 'streaming' && phase !== 'streaming') {
      void qc.invalidateQueries({ queryKey: ['conversations'] })
    }
    prevPhase.current = phase
  }, [phase, qc])

  const busy = phase === 'streaming'
  const waitingConfirm = items.some((i) => i.status === 'waiting_confirm' && !i.confirm?.outcome)
  const canStop = busy && !waitingConfirm
  const visibleItems = filterChatItems(items, searchQuery)

  const exportPayload = items.map((item) => ({ role: item.role, text: item.text }))

  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    const action = interpretChatKey(
      { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey },
      {
        inputEmpty: input.length === 0,
        streaming: canStop,
        waitingConfirm,
      },
    )
    if (!action) return
    if (action === 'search') {
      e.preventDefault()
      setSearchOpen(true)
      queueMicrotask(() => searchRef.current?.focus())
      return
    }
    if (action === 'fill-last-user') {
      if ((e.target as HTMLElement).id !== 'chat-input') return
      e.preventDefault()
      const last = lastUserText(items)
      if (last) setInput(last)
      return
    }
    if (action === 'reject-confirm') {
      e.preventDefault()
      const pending = items.find((i) => i.status === 'waiting_confirm' && !i.confirm?.outcome)
      if (pending) void confirm(pending.key, false)
      return
    }
    if (action === 'stop') {
      e.preventDefault()
      stop()
    }
  }

  return (
    <section
      ref={panelRef}
      onKeyDown={onPanelKeyDown}
      className="flex h-full min-h-[60vh] flex-col overflow-hidden rounded-xl border border-border bg-muted/50 lg:min-h-0"
    >
      <header className="flex items-center justify-between border-b border-border bg-card/60 px-4 py-3 backdrop-blur">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <span className="grid size-6 place-items-center rounded-full bg-primary text-primary-foreground">
            <Sparkle size={12} weight="fill" />
          </span>
          智能体助手
          <span className="tnum text-xs font-normal text-muted-foreground">
            {conversationId ? `会话 #${conversationId}` : '新会话'}
          </span>
        </h2>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            title="搜索本会话"
            aria-label="搜索本会话"
            onClick={() => {
              setSearchOpen((open) => {
                const next = !open
                if (!next) setSearchQuery('')
                else queueMicrotask(() => searchRef.current?.focus())
                return next
              })
            }}
            className="grid h-[30px] w-[30px] place-items-center rounded-md border border-input bg-background text-muted-foreground transition hover:bg-accent hover:text-accent-foreground active:scale-[0.97]"
          >
            <MagnifyingGlass size={14} />
          </button>
          <button
            type="button"
            title="导出为 txt"
            aria-label="导出为 txt"
            disabled={items.length === 0}
            onClick={() =>
              downloadFile(
                `conversation-${conversationId ?? 'new'}.txt`,
                exportConversationText(exportPayload),
                'text/plain;charset=utf-8',
              )
            }
            className="grid h-[30px] w-[30px] place-items-center rounded-md border border-input bg-background text-muted-foreground transition hover:bg-accent hover:text-accent-foreground active:scale-[0.97] disabled:opacity-40"
          >
            <DownloadSimple size={14} />
          </button>
          <button
            type="button"
            title="导出为 json"
            aria-label="导出为 json"
            disabled={items.length === 0}
            onClick={() =>
              downloadFile(
                `conversation-${conversationId ?? 'new'}.json`,
                exportConversationJson(exportPayload, conversationId),
                'application/json;charset=utf-8',
              )
            }
            className="rounded-md border border-input bg-background px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition hover:bg-accent hover:text-accent-foreground active:scale-[0.97] disabled:opacity-40"
          >
            JSON
          </button>
          <ConversationHistory disabled={busy} />
          <button
            onClick={newConversation}
            disabled={busy}
            className="flex items-center gap-1 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-accent-foreground active:scale-[0.97] disabled:opacity-40"
          >
            <ArrowCounterClockwise size={13} />
            新对话
          </button>
          <button
            onClick={onClose}
            title="收起面板"
            aria-label="收起智能体面板"
            className="grid h-[30px] w-[30px] place-items-center rounded-md border border-input bg-background text-muted-foreground transition hover:bg-accent hover:text-accent-foreground active:scale-[0.97]"
          >
            <ArrowLineRight size={14} />
          </button>
        </div>
      </header>

      {searchOpen ? (
        <div className="border-b border-border bg-card px-4 py-2">
          <label htmlFor="chat-search" className="sr-only">
            搜索当前会话
          </label>
          <input
            id="chat-search"
            ref={searchRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索当前会话（不劫持浏览器查找）"
            className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20"
          />
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 py-4">
        {items.length === 0 && (
          <div className="mt-14 text-center">
            <span className="mx-auto grid size-11 place-items-center rounded-full bg-card shadow-sm ring-1 ring-border">
              <Sparkle size={20} className="text-primary" />
            </span>
            <p className="mt-3 text-sm text-muted-foreground">对智能体说点什么</p>
            <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
              记一条：明天下午买牛奶
              <br />
              把 3 号改为已完成
              <br />
              清理掉所有已完成的
            </p>
            <p className="mt-3 text-xs text-muted-foreground/80">
              支持查询、新建、修改、删除、清理已完成；写操作会先请你确认
            </p>
          </div>
        )}
        {items.length > 0 && visibleItems.length === 0 ? (
          <p className="pt-8 text-center text-sm text-muted-foreground">当前会话没有匹配的消息</p>
        ) : (
          visibleItems.map((item) => (
            <Bubble key={item.key} item={item} onConfirm={(k, ok) => void confirm(k, ok)} />
          ))
        )}
        {phase === 'error' && errorMessage && (
          <p role="alert" className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <Warning size={14} weight="fill" className="shrink-0" />
            {errorMessage}
          </p>
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={submit} className="flex gap-2 border-t border-border bg-card/60 p-3">
        <label htmlFor="chat-input" className="sr-only">
          消息内容
        </label>
        <input
          id="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? '智能体回复中…' : '输入消息，Enter 发送'}
          disabled={busy}
          className="flex-1 rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20 disabled:bg-muted disabled:text-muted-foreground"
        />
        {canStop ? (
          <button
            type="button"
            onClick={stop}
            aria-label="停止生成"
            className="grid h-[38px] w-[42px] shrink-0 place-items-center rounded-md bg-foreground text-background shadow-sm transition hover:bg-foreground/90 active:scale-[0.95]"
          >
            <Stop size={16} weight="fill" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={busy || !input.trim()}
            aria-label="发送"
            className="grid h-[38px] w-[42px] shrink-0 place-items-center rounded-md bg-primary text-primary-foreground shadow-sm transition hover:bg-primary/90 active:scale-[0.95] disabled:opacity-40"
          >
            <PaperPlaneTilt size={16} weight="fill" />
          </button>
        )}
      </form>
    </section>
  )
}
