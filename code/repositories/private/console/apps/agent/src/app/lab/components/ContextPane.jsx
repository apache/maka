'use client'
// src/app/components/ContextPane.jsx —— Context 消息流（原 context-view.js 的 React 化）。
//
// 核心心智模型：context 是 agent 的唯一状态，循环做的事就是往里加消息。
// 卡片模型在 session-store 里（事件驱动追加；compaction 后全量 rebuild），
// 这里只负责渲染：卡片逐条飞入、tool_use↔tool_result 同色配对、
// 点击展开消息内部 JSON、「OpenAI 视角」看 wire 格式、上下文水位仪表盘。

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { motion } from 'motion/react'
import { getSettings } from '@ggbdpq/agent-lab-core/src/web-utils/settings.js'
import { pairColor } from '../utils/session-store.js'

/** 卡片模型 → 消息对象（与 agent.js 里 buildAssistantMessage 的结构一字不差） */
function cardToMessage(card) {
  if (card.kind === 'user') return { role: 'user', content: card.text }
  if (card.kind === 'assistant') {
    const content = []
    if (card.text) content.push({ type: 'text', text: card.text })
    for (const t of card.tools ?? []) {
      content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.args })
    }
    return { role: 'assistant', content }
  }
  if (card.kind === 'toolresult') {
    return { role: 'user', content: card.blocks.map(b => ({ type: 'tool_result', tool_use_id: b.id, content: b.result })) }
  }
  return { role: 'user', content: card.text }
}

const ROLE_LABEL = {
  system: 'system（独立字段）',
  user: 'user',
  assistant: 'assistant',
  toolresult: 'user · tool_result',
  summary: '已压缩（旧消息 → 摘要）',
}

/** 卡片底色按角色微调：一眼分清"谁说的" */
const KIND_CARD = {
  system: 'border-dashed border-line text-ink-faint',
  user: 'border-line-soft',
  assistant: 'border-line-soft',
  toolresult: 'border-line-soft',
  summary: 'border-purple/40',
}

function ResultBlock({ block, flash }) {
  const [collapsed, setCollapsed] = useState(
    block.result.length > 300 || block.result.split('\n').length > 8,
  )
  return (
    <div
      className={`pair-block mt-1.5 rounded-chip bg-lab-base p-2${flash ? ' pair-flash' : ''}`}
      style={{ '--pair': pairColor(block.id) }}
    >
      <div className="font-mono text-[11px]" style={{ color: 'var(--pair)' }}>↳ {block.name ?? block.id}</div>
      <pre
        className={`mt-1 cursor-pointer whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-ink-dim${collapsed ? ' clamp-pre' : ''}`}
        onClick={(e) => { e.stopPropagation(); setCollapsed(c => !c) }}
      >{block.result}</pre>
    </div>
  )
}

function ContextCard({ card, flash }) {
  const [showJson, setShowJson] = useState(false)
  const hasText = ['assistant', 'summary', 'system', 'user'].includes(card.kind)

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className={`cursor-pointer rounded-chip border bg-raised p-2.5 transition-colors hover:border-line ${KIND_CARD[card.kind] ?? 'border-line-soft'}`}
      onClick={() => setShowJson(v => !v)}
    >
      <span className="mb-1 block font-mono text-[10px] font-medium uppercase tracking-wider text-ink-faint">
        {ROLE_LABEL[card.kind]}
      </span>
      {hasText && (
        <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-dim">{card.text}</div>
      )}
      {card.kind === 'assistant' && card.tools?.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {card.tools.map(t => (
            <span
              key={t.id}
              className={`pair-chip rounded-chip px-1.5 py-0.5 font-mono text-[11px]${flash === t.id ? ' pair-flash' : ''}`}
              style={{ '--pair': pairColor(t.id) }}
            >{t.name}({JSON.stringify(t.args)})</span>
          ))}
        </div>
      )}
      {card.kind === 'toolresult' && card.blocks.map(b => (
        <ResultBlock key={b.id + b.name} block={b} flash={flash === b.id} />
      ))}
      {showJson && card.kind !== 'system' && (
        <pre className="mt-2 overflow-x-auto rounded-chip border border-line-soft bg-lab-base p-2.5 font-mono text-[11px] leading-relaxed text-ink-dim">
          {JSON.stringify(cardToMessage(card), null, 2)}
        </pre>
      )}
    </motion.div>
  )
}

export default function ContextPane({ store }) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const cardsRef = useRef(null)
  const stickRef = useRef(true)
  const rebuildIdRef = useRef(0)

  // 贴底滚动：用户没往上翻就一直跟着滚；翻上去读历史时就不再打扰
  useEffect(() => {
    const el = cardsRef.current
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = cardsRef.current
    if (!el) return
    // compaction 后回到顶部看摘要卡（rebuildId 变化 = 刚发生过全量重建）
    if (snap.rebuildId > rebuildIdRef.current && stickRef.current) el.scrollTop = 0
    else if (stickRef.current) el.scrollTop = el.scrollHeight
    rebuildIdRef.current = snap.rebuildId
  }, [snap.cards, snap.rebuildId])

  const context = store.getContext()
  const threshold = getSettings().compactThreshold
  const n = context?.messages.length ?? 0
  const chars = useMemo(
    () => JSON.stringify(context?.messages ?? []).length,
    [snap.contextVersion], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const pct = Math.min(100, (n / threshold) * 100)
  const wireText = useMemo(
    () => (snap.wireMode ? store.wireJson() : ''),
    [snap.wireMode, snap.contextVersion],
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-none items-center justify-between px-3 py-2">
        <span className="font-mono text-[11px] text-ink-faint">{snap.messageCount} messages</span>
        <button
          id="wire-toggle"
          className={`rounded-chip border px-2 py-1 font-mono text-[11px] transition-colors ${
            snap.wireMode
              ? 'border-lab-accent/45 bg-lab-accent-soft text-lab-accent'
              : 'border-line text-ink-dim hover:text-ink'
          }`}
          type="button"
          onClick={() => store.toggleWire()}
        >OpenAI 视角</button>
      </div>

      {/* 上下文水位（期6）：刻意不估 token——chars/4 对中文完全失真 */}
      <div
        className="flex-none px-3 pb-2.5"
        title="context 大小逼近压缩阈值的过程。不估 token——没有 tokenizer，chars/4 对中文完全失真"
      >
        <div className="flex items-center justify-between font-mono text-[11px] text-ink-faint">
          <span>context 水位</span>
          <span>{n} / {threshold} 条 · {chars} 字符</span>
        </div>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-overlay">
          <div
            className={`h-full rounded-full transition-[width] duration-300 ${
              pct >= 100 ? 'bg-red' : pct >= 80 ? 'bg-amber' : 'bg-lab-accent'
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 border-t border-line-soft">
        <div className="h-full overflow-y-auto p-3" ref={cardsRef} hidden={snap.wireMode}>
          <div className="flex flex-col gap-2">
            {snap.cards.map(card => (
              <ContextCard key={card.id} card={card} flash={snap.flash?.id} />
            ))}
          </div>
        </div>
        <pre className="h-full overflow-auto p-3 font-mono text-[11.5px] leading-relaxed text-ink-dim" hidden={!snap.wireMode}>{wireText}</pre>
      </div>
    </div>
  )
}
