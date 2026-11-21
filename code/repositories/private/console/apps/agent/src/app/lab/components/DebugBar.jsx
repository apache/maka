'use client'
// src/app/components/DebugBar.jsx —— 调试控制条（原 debugbar.js 的 React 化）。
//
// [继续] [单步] [暂停] | 断点 chips | [速度] | 状态（含扣住事件的下一步预览）
// 断点/慢放配置存在 store（跨回合持久）；每轮新 EventPump 经 store.setPump 注入。
// 快捷键：F10 单步、F8 继续。

import { useEffect, useSyncExternalStore } from 'react'
import { motion } from 'motion/react'
import { PlayIcon, SkipForwardIcon, PauseIcon } from '@phosphor-icons/react'
import { BREAKPOINT_TYPES } from '@ggbdpq/agent-lab-core/src/web-utils/pump.js'

const BP_LABELS = {
  tool_call: 'tool_call（每次工具调用前停）',
  tool_result: 'tool_result（每次工具结果后停）',
  turn_end: 'turn_end（每轮结束停）',
  compact_end: 'compact_end（每次压缩后停，先看摘要再放行）',
  round_start: '轮边界（新循环开始前停）',
}

const CTRL_BTN =
  'flex items-center gap-1.5 rounded-chip border border-line bg-raised px-2.5 py-1 ' +
  'font-mono text-[11px] text-ink-dim transition-colors hover:border-ink-faint hover:text-ink ' +
  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-ink-dim'

/** 扣住事件的下一步预览文案（它还没进终端/地图/Context，这就是断点的价值） */
function preview(ev) {
  const src = ev.src ? `[${ev.src.file} · ${ev.fn}] ` : ''
  switch (ev.type) {
    case 'assistant_text': return `${src}assistant_text "${String(ev.delta).slice(0, 24)}…"`
    case 'tool_call': return `${src}tool_call ${ev.name}(${JSON.stringify(ev.args).slice(0, 48)}…)`
    case 'tool_result': return `${src}tool_result ${ev.name}`
    case 'turn_end': return `${src}turn_end(${ev.stopReason})`
    case 'compact_start': return `${src}compact_start（${ev.count} 条消息，开始压缩）`
    case 'compact_end': return ev.failed
      ? `${src}compact_end（压缩失败，保留原消息）`
      : `${src}compact_end（-${ev.removed} 条 → 摘要 + ${ev.kept} 条，摘要 "${String(ev.summary).slice(0, 24)}…"）`
    default: return `${src}${ev.type}`
  }
}

export default function DebugBar({ store }) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)

  const act = (kind) => {
    if (!snap.running || !store.pump) return
    if (kind === 'play') store.pump.play()
    else if (kind === 'pause') store.pump.pause()
    else if (kind === 'step') store.pump.step()
  }

  // 快捷键（F10 在部分浏览器会唤起菜单键，preventDefault 掉）
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'F10') { e.preventDefault(); act('step') }
      else if (e.key === 'F8') { e.preventDefault(); act('play') }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  return (
    <div className="flex flex-none flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-line-soft bg-raised px-3 py-2">
      <div className="flex items-center gap-1.5">
        <button className={CTRL_BTN} type="button" disabled={!snap.running} onClick={() => act('play')}>
          <PlayIcon size={12} weight="fill" className="text-lab-accent" /> 继续
          <kbd className="rounded bg-overlay px-1 py-px text-[10px] text-ink-faint">F8</kbd>
        </button>
        <button className={CTRL_BTN} type="button" disabled={!snap.running} onClick={() => act('step')}>
          <SkipForwardIcon size={12} weight="fill" /> 单步
          <kbd className="rounded bg-overlay px-1 py-px text-[10px] text-ink-faint">F10</kbd>
        </button>
        <button className={CTRL_BTN} type="button" disabled={!snap.running} onClick={() => act('pause')}>
          <PauseIcon size={12} weight="fill" /> 暂停
        </button>
      </div>

      <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />

      <span className="text-[11px] text-ink-faint">断点</span>
      {BREAKPOINT_TYPES.map(type => {
        const on = snap.bpSet.has(type)
        return (
          <button
            key={type}
            className={`flex items-center gap-1.5 rounded-chip border px-2 py-1 font-mono text-[11px] transition-colors ${
              on
                ? 'border-lab-accent/45 bg-lab-accent-soft text-lab-accent'
                : 'border-line bg-raised text-ink-faint hover:border-ink-faint hover:text-ink-dim'
            }`}
            type="button"
            title={BP_LABELS[type]}
            onClick={() => store.toggleBreakpoint(type)}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${on ? 'bg-lab-accent' : 'bg-ink-faint/60'}`} />
            {type}
          </button>
        )
      })}

      <button
        className={`${CTRL_BTN} flex-none`}
        type="button"
        onClick={() => store.toggleSlowMo()}
      >速度：{snap.slowMo ? '慢放' : '全速'}</button>

      {snap.held ? (
        <motion.span
          initial={{ opacity: 0, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          className="ml-auto flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-amber"
        >
          <span className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-amber" />
          <span className="truncate" title={`下一步：${preview(snap.held.ev)}`}>
            {snap.held.reason} · 下一步：{preview(snap.held.ev)}
          </span>
        </motion.span>
      ) : (
        <span className="ml-auto min-w-0 truncate font-mono text-[11px] text-ink-faint">{snap.status}</span>
      )}
    </div>
  )
}
