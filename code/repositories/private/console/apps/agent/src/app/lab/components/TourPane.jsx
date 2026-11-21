'use client'
// src/app/components/TourPane.jsx —— 走读模式（期8）：关卡制带你读 agent/llm。
//
// 关卡数据在 tour-data.js（纯数据 + 教学文案，scripts/tour-test.mjs 校验行号）。
// 每关 = 源码行区间 + 讲解 + 可选「运行到这」：
//   挂上关卡声明的断点 → 自动把演示任务填进终端回车——扣住时本卡亮起，
//   讲解与实跑互相印证（零改动核心文件：经 tui.input 设值 + dispatch Enter）。
// watch：没有对应断点的关卡，给"去哪里看"的观察指引。

import { useState, useSyncExternalStore } from 'react'
import { motion } from 'motion/react'
import { PlayIcon, CodeIcon, ArrowLeftIcon, ArrowRightIcon } from '@phosphor-icons/react'
import { TOUR_SECTIONS, DEMO_TASK } from '@ggbdpq/agent-lab-core/src/tour-data'
import { getSettings } from '@ggbdpq/agent-lab-core/src/web-utils/settings.js'

/** 讲解段落：`code` 片段渲染成 code 样式（静态文案 split 渲染，无 HTML 注入） */
function Teach({ text }) {
  const parts = text.split(/`([^`]+)`/)
  return (
    <p className="text-[12.5px] leading-relaxed text-ink-dim">
      {parts.map((p, i) => (i % 2
        ? <code key={i} className="rounded bg-lab-base px-1 py-px font-mono text-[11.5px] text-ink">{p}</code>
        : <span key={i}>{p}</span>))}
    </p>
  )
}

export default function TourPane({ store, tui, onShowSource }) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [secId, setSecId] = useState(TOUR_SECTIONS[0].id)
  const [idx, setIdx] = useState(0)
  const [msg, setMsg] = useState('')

  const section = TOUR_SECTIONS.find(s => s.id === secId)
  const step = section.steps[idx]

  // 扣住联动：被扣事件类型 === 本关声明的断点 → "程序正停在这"
  const heldHere = Boolean(step.runTo && snap.held && snap.held.ev.type === step.runTo.bp)
  const canRun = Boolean(step.runTo && !snap.running && tui)

  const goto = (n) => { setIdx(n); setMsg('') }

  /** 运行到这：挂断点 + 经终端入口自动发任务（input 在 busy 时 disabled，天然防重入） */
  const runHere = () => {
    if (!canRun) return
    if (!getSettings().apiKey) {
      setMsg('先在右上角 ⚙ 设置里填好 API Key，再运行到这')
      return
    }
    setMsg('')
    if (!snap.bpSet.has(step.runTo.bp)) store.toggleBreakpoint(step.runTo.bp)
    tui.input.value = step.runTo.task ?? DEMO_TASK
    tui.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  }

  return (
    <div className="flex h-full flex-col">
      {/* 篇切换 + 关卡进度点 */}
      <div className="flex flex-none flex-wrap items-center gap-2 px-3 pt-3">
        {TOUR_SECTIONS.map(s => (
          <button
            key={s.id}
            type="button"
            onClick={() => { setSecId(s.id); goto(0) }}
            className={`rounded-chip border px-2.5 py-1 text-xs font-medium transition-colors ${
              s.id === secId
                ? 'border-lab-accent/45 bg-lab-accent-soft text-lab-accent'
                : 'border-line bg-raised text-ink-dim hover:border-ink-faint hover:text-ink'
            }`}
          >{s.title}</button>
        ))}
        <span className="ml-auto flex items-center gap-1.5" aria-label="关卡进度">
          {section.steps.map((st, i) => (
            <button
              key={st.id}
              type="button"
              title={`${i + 1}. ${st.title}`}
              onClick={() => goto(i)}
              className={`h-1.5 rounded-full transition-all ${
                i === idx ? 'w-4 bg-lab-accent' : 'w-1.5 bg-line hover:bg-ink-faint'
              }`}
            />
          ))}
        </span>
      </div>
      <p className="flex-none px-3 pt-1.5 text-[11px] text-ink-faint">{section.subtitle}</p>

      {/* 当前关卡卡 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <motion.div
          key={step.id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className={`flex flex-col gap-3 rounded-panel border bg-raised p-4 transition-colors ${
            heldHere ? 'border-lab-accent/60' : 'border-line'
          }`}
        >
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[11px] text-lab-accent">{step.id.toUpperCase()}</span>
            <h3 className="text-[13.5px] font-semibold text-ink">{step.title}</h3>
            <span className="ml-auto flex-none font-mono text-[11px] text-ink-faint">{idx + 1} / {section.steps.length}</span>
          </div>

          {step.teach.map((t, i) => <Teach key={i} text={t} />)}

          {/* 源码段：跳到源码 tab 并高亮这个行区间 */}
          <button
            type="button"
            onClick={() => onShowSource(section.file, step.lines)}
            className="flex w-fit items-center gap-1.5 rounded-chip border border-line bg-lab-base px-2.5 py-1 font-mono text-[11.5px] text-ink-dim transition-colors hover:border-lab-accent/45 hover:text-lab-accent"
          ><CodeIcon size={12} /> {section.file} · {step.lines[0]}-{step.lines[1]} 行</button>

          {/* 运行到这（有断点映射的关卡） */}
          {step.runTo && (
            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                disabled={!canRun}
                onClick={runHere}
                className="flex w-fit items-center gap-1.5 rounded-chip border border-lab-accent/45 bg-lab-accent-soft px-3 py-1.5 text-xs font-medium text-lab-accent transition-colors hover:bg-lab-accent/15 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <PlayIcon size={12} weight="fill" />
                运行到这
                <span className="font-mono text-[10.5px] opacity-70">挂 {step.runTo.bp} 断点 → 自动发演示任务</span>
              </button>
              {step.runTo.hint && <p className="text-[11px] leading-relaxed text-amber">※ {step.runTo.hint}</p>}
              {msg && <p className="text-[11px] text-red">{msg}</p>}
              {snap.running && <p className="text-[11px] text-ink-faint">回合进行中，等它结束（或点停止）再运行到这</p>}
            </div>
          )}

          {/* 观察指引（无断点映射的关卡） */}
          {step.watch && (
            <p className="rounded-chip border-l-2 border-line bg-lab-base px-3 py-2 text-[12px] leading-relaxed text-ink-dim">
              看哪里：{step.watch}
            </p>
          )}

          {/* 扣住联动：讲解 ↔ 实跑在此对上 */}
          {heldHere && (
            <p className="flex items-center gap-1.5 rounded-chip border border-lab-accent/45 bg-lab-accent-soft px-3 py-2 font-mono text-[11.5px] text-lab-accent">
              <span className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-lab-accent" />
              程序正停在这：{snap.held.reason} · [{snap.held.ev.src?.file} · {snap.held.ev.src?.fn}]
              —— 按 F8 继续，或点下一关
            </p>
          )}
        </motion.div>
      </div>

      {/* 上一关 / 下一关 */}
      <div className="flex flex-none items-center justify-between border-t border-line-soft px-3 py-2">
        <button
          type="button"
          disabled={idx === 0}
          onClick={() => goto(idx - 1)}
          className="flex items-center gap-1 rounded-chip px-2 py-1 text-xs text-ink-dim transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        ><ArrowLeftIcon size={12} /> 上一关</button>
        <button
          type="button"
          disabled={idx === section.steps.length - 1}
          onClick={() => goto(idx + 1)}
          className="flex items-center gap-1 rounded-chip px-2 py-1 text-xs text-ink-dim transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >下一关 <ArrowRightIcon size={12} /></button>
      </div>
    </div>
  )
}
