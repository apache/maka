import { create } from 'zustand'
import { getState, setState } from '@/features/ruoyi-ai/lib/db'
import { composeAnswer } from '@/features/ruoyi-ai/lib/domain/answer'
import { retrieve } from '@/features/ruoyi-ai/lib/domain/retrieve'
import type { Message, Session } from '@/features/ruoyi-ai/lib/domain/types'
import { uid } from '@/features/ruoyi-ai/lib/format'
import { embedderFor, getIndex, useKnowledge } from './knowledge'

interface ChatState {
  sessions: Session[]
  activeId: string | null
  ready: boolean
  sending: boolean
  init: () => Promise<void>
  create: (kbId: string) => string
  select: (id: string) => void
  remove: (id: string) => void
  send: (text: string, kbId: string) => Promise<void>
}

function persist(sessions: Session[]) {
  return setState('chat', sessions)
}

export const useChat = create<ChatState>()((set, get) => ({
  sessions: [],
  activeId: null,
  ready: false,
  sending: false,

  init: async () => {
    if (get().ready) return
    const saved = await getState<Session[]>('chat')
    set({ sessions: saved ?? [], activeId: saved?.[0]?.id ?? null, ready: true })
  },

  create: (kbId) => {
    const session: Session = {
      id: uid('s'),
      title: '新对话',
      kbId,
      messages: [],
      updatedAt: Date.now(),
    }
    set({ sessions: [session, ...get().sessions], activeId: session.id })
    return session.id
  },

  select: (id) => set({ activeId: id }),

  remove: (id) => {
    const sessions = get().sessions.filter((s) => s.id !== id)
    set({ sessions, activeId: get().activeId === id ? (sessions[0]?.id ?? null) : get().activeId })
    void persist(sessions)
  },

  send: async (text, kbId) => {
    const raw = text.trim()
    if (!raw || get().sending) return

    let session = get().sessions.find((s) => s.id === get().activeId)
    if (!session) {
      const id = get().create(kbId)
      session = get().sessions.find((s) => s.id === id)!
    }
    const target = session

    const userMsg: Message = { id: uid('m'), role: 'user', text: raw, at: Date.now() }
    const withUser: Session = {
      ...target,
      title: target.messages.length === 0 ? raw.slice(0, 20) : target.title,
      messages: [...target.messages, userMsg],
      updatedAt: Date.now(),
    }
    set({ sending: true, sessions: [withUser, ...get().sessions.filter((s) => s.id !== target.id)] })

    let reply: Message
    try {
      const kb = useKnowledge.getState().kbs.find((k) => k.id === kbId)
      const names = Object.fromEntries(useKnowledge.getState().assets.map((a) => [a.id, a.name]))
      const hits = kb
        ? await retrieve(raw, {
            kbId: kb.id,
            topK: kb.topK,
            embedder: embedderFor(kb.embeddingModel),
            index: getIndex(),
          })
        : []
      const answer = composeAnswer(hits, { names })
      reply = { id: uid('m'), role: 'assistant', text: answer.text, citations: answer.citations, at: Date.now() }
    } catch (error) {
      reply = {
        id: uid('m'),
        role: 'assistant',
        text: `检索失败：${error instanceof Error ? error.message : '未知错误'}`,
        at: Date.now(),
      }
    }

    const final = { ...withUser, messages: [...withUser.messages, reply], updatedAt: Date.now() }
    const sessions = [final, ...get().sessions.filter((s) => s.id !== final.id)]
    set({ sessions, sending: false })
    await persist(sessions)
  },
}))
