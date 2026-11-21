import { Bot, Database, Plus, Send, Trash2, User } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/features/ruoyi-ai/components/ui/button'
import { useChat } from '@/features/ruoyi-ai/stores/chat'
import { useKnowledge } from '@/features/ruoyi-ai/stores/knowledge'

export default function Chat() {
  const kbs = useKnowledge((s) => s.kbs)
  const sessions = useChat((s) => s.sessions)
  const activeId = useChat((s) => s.activeId)
  const sending = useChat((s) => s.sending)
  const create = useChat((s) => s.create)
  const select = useChat((s) => s.select)
  const remove = useChat((s) => s.remove)
  const send = useChat((s) => s.send)

  const [kbId, setKbId] = useState(kbs[0]?.id ?? '')
  const [draft, setDraft] = useState('')
  const bottom = useRef<HTMLDivElement>(null)

  const session = sessions.find((s) => s.id === activeId)
  const messages = session?.messages ?? []

  useEffect(() => {
    if (!kbId && kbs[0]) setKbId(kbs[0].id)
  }, [kbs, kbId])

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, sending])

  function submit() {
    if (!draft.trim() || sending) return
    const text = draft
    setDraft('')
    void send(text, kbId)
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r">
        <div className="flex h-12 items-center justify-between border-b px-3">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Bot className="size-4" /> RuoYi-AI
          </span>
          <Button variant="ghost" size="icon-sm" title="新对话" onClick={() => create(kbId)}>
            <Plus className="size-4" />
          </Button>
        </div>
        <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={
                'group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm ' +
                (s.id === activeId ? 'bg-accent' : 'hover:bg-accent/50')
              }
            >
              <button className="min-w-0 flex-1 truncate text-left" onClick={() => select(s.id)}>
                {s.title}
              </button>
              <button
                className="opacity-0 transition-opacity group-hover:opacity-100"
                title="删除会话"
                onClick={() => remove(s.id)}
              >
                <Trash2 className="size-3.5 text-muted-foreground" />
              </button>
            </div>
          ))}
          {sessions.length === 0 && <p className="p-2 text-xs text-muted-foreground">还没有对话</p>}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <span className="truncate text-sm font-medium">{session?.title ?? '新对话'}</span>
          <div className="ml-auto flex items-center gap-2">
            <Database className="size-3.5 text-muted-foreground" />
            <select
              value={kbId}
              onChange={(e) => setKbId(e.target.value)}
              className="h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none"
            >
              {kbs.map((kb) => (
                <option key={kb.id} value={kb.id}>
                  {kb.name}
                </option>
              ))}
            </select>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {messages.length === 0 && (
            <div className="mx-auto max-w-md space-y-3 py-16 text-center">
              <Bot className="mx-auto size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                问一句知识库里有的内容，比如「怎么启动 ruoyi 前端」。
                <br />
                回答只由检索到的分片拼成，没有命中就直说没有。
              </p>
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div className={'flex max-w-[80%] gap-2 ' + (m.role === 'user' ? 'flex-row-reverse' : '')}>
                <div
                  className={
                    'mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border ' +
                    (m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-card')
                  }
                >
                  {m.role === 'user' ? <User className="size-3.5" /> : <Bot className="size-3.5" />}
                </div>
                <div className="min-w-0 space-y-2">
                  <div
                    className={
                      'rounded-lg px-3 py-2 text-sm leading-6 whitespace-pre-wrap ' +
                      (m.role === 'user' ? 'bg-primary text-primary-foreground' : 'border bg-card')
                    }
                  >
                    {m.text}
                  </div>
                  {m.citations && m.citations.length > 0 && (
                    <div className="space-y-1">
                      {m.citations.map((c) => (
                        <div key={c.chunkId} className="rounded-md border bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
                          <span className="font-mono">#{c.chunkId.split('#')[1]}</span> · 相似度 {c.score.toFixed(3)} ·{' '}
                          {c.text.slice(0, 60)}
                          {c.text.length > 60 ? '…' : ''}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
          {sending && <p className="text-xs text-muted-foreground">检索中…</p>}
          <div ref={bottom} />
        </div>

        <div className="border-t p-3">
          <div className="rounded-xl border bg-card/40 p-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
              rows={2}
              placeholder="请输入内容"
              className="w-full resize-none bg-transparent px-2 py-1 text-sm outline-none"
            />
            <div className="flex items-center gap-2 px-1">
              <span className="rounded-md border px-2 py-0.5 text-[11px] text-muted-foreground">
                对话知识库 · {kbs.find((k) => k.id === kbId)?.name ?? '未选择'}
              </span>
              <Button className="ml-auto" size="sm" disabled={!draft.trim() || sending} onClick={submit}>
                <Send className="size-3.5" />
                发送
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
