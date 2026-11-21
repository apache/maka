'use client'
// src/app/App.jsx —— 布局外壳：顶栏（品牌 + 数据流地图 + 状态 + 设置）、
// 左终端（核心 Tui 挂载 + 调试条）、右三 tab（Context / 沙盒文件 / 源码）。
//
// 装配关系：App 创建 session-store 与核心 Tui，调 core 的 main({ tui, store,
// openSource })；此后事件流由 cli.js 驱动，组件从 store 快照渲染。
//
// 视觉：终端实验室（暗色锁定，单一绿 accent）。动效全部有动机：
// 页签滑块指示位置变化、卡片入场表示新消息追加、运行点脉冲表示进行中。

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { MotionConfig, motion } from 'motion/react'
import { GearSixIcon, ArrowCounterClockwiseIcon } from '@phosphor-icons/react'
import { main } from '@ggbdpq/agent-lab-core/src/cli.js'
import { getSettings } from '@ggbdpq/agent-lab-core/src/web-utils/settings.js'
import * as vfs from '@ggbdpq/agent-lab-core/src/web-utils/vfs.js'
import { createSessionStore } from './utils/session-store.js'
import TerminalHost from './components/TerminalHost.jsx'
import DebugBar from './components/DebugBar.jsx'
import FlowMap from './components/FlowMap.jsx'
import ContextPane from './components/ContextPane.jsx'
import FilesPane from './components/FilesPane.jsx'
import SourcePane, { NODE_FN_HINTS } from './components/SourcePane.jsx'
import TourPane from './components/TourPane.jsx'
import SettingsDialog from './components/SettingsDialog.jsx'

const TABS = [
  { key: 'context', label: 'Context' },
  { key: 'files', label: '沙盒文件' },
  { key: 'source', label: '源码' },
  { key: 'tour', label: '走读' },
]

/** 顶栏右侧的运行状态芯片：空闲 / 运行中（脉冲）/ 断点扣住 */
function StatusChip({ store }) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const state = snap.held ? 'held' : snap.running ? 'run' : 'idle'
  const label = snap.held
    ? `断点扣住：${snap.held.ev.type}`
    : snap.running ? snap.status : '空闲'
  return (
    <span className="flex min-w-0 items-center gap-1.5 rounded-chip border border-line bg-raised px-2.5 py-1 font-mono text-[11px] text-ink-dim">
      <span className={
        state === 'held' ? 'h-1.5 w-1.5 flex-none rounded-full bg-amber'
        : state === 'run' ? 'h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-lab-accent'
        : 'h-1.5 w-1.5 flex-none rounded-full bg-ink-faint'
      } />
      <span className="truncate">{label}</span>
    </span>
  )
}

export default function App() {
  const storeRef = useRef(null)
  if (!storeRef.current) storeRef.current = createSessionStore()
  const store = storeRef.current

  const [tui, setTui] = useState(null)
  const [tab, setTab] = useState('context')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const sourceApi = useRef(null)

  // 核心 main() 只装配一次（tui 就绪后）；openSource = 源码联动的统一入口
  useEffect(() => {
    if (!tui) return
    const openSource = (file, fn) => {
      sourceApi.current?.show(file, fn)
      setTab('source')
    }
    main({ tui, store, openSource })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tui])

  const openSourceByNode = (file) => {
    sourceApi.current?.show(file, NODE_FN_HINTS[file] ?? null)
    setTab('source')
  }

  const resetSandbox = () => {
    vfs.resetSandbox()
    store.bumpVfs()
    tui?.printNotice('沙盒已重置为预置项目（对话历史保留）')
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-screen flex-col">
        <header className="flex h-[92px] flex-none items-center gap-4 border-b border-line bg-surface px-4">
          <div className="flex flex-none flex-col leading-tight">
            <h1 className="font-mono text-[15px] font-bold tracking-tight text-ink">实验室</h1>
            <span className="text-[11px] text-ink-faint">nano agent 执行实验室</span>
          </div>
          <div className="h-8 w-px flex-none bg-line" aria-hidden="true" />
          <FlowMap store={store} onNodeClick={openSourceByNode} />
          <StatusChip store={store} />
          <button
            className="flex flex-none items-center gap-1.5 rounded-chip border border-line bg-raised px-3 py-1.5 text-xs text-ink-dim transition-colors hover:border-ink-faint hover:text-ink"
            type="button"
            onClick={() => setSettingsOpen(true)}
          ><GearSixIcon size={14} /> 设置</button>
        </header>

        <main className="grid min-h-0 flex-1 gap-3 p-3 lg:grid-cols-[57fr_43fr]">
          <section
            className="flex min-h-0 flex-col overflow-hidden rounded-panel border border-line bg-surface"
            aria-label="终端"
          >
            <div className="flex flex-none items-center justify-between border-b border-line-soft px-4 py-2">
              <span className="font-mono text-[11px] font-medium uppercase tracking-wider text-ink-faint">terminal · 事件流</span>
              <span className="text-[11px] text-ink-faint">行首 [文件 · 函数] 可点击直达源码</span>
            </div>
            <TerminalHost onTui={setTui} />
            {/* 调试条挂在终端输出区与输入行之间（tui.midSlot 插槽，期3 原位置） */}
            {tui && createPortal(<DebugBar store={store} />, tui.midSlot)}
          </section>

          <aside
            className="flex min-h-0 flex-col overflow-hidden rounded-panel border border-line bg-surface"
            aria-label="Context 与沙盒"
          >
            <div className="flex flex-none items-center justify-between gap-2 border-b border-line-soft px-3 py-2">
              <div className="flex items-center gap-1">
                {TABS.map(t => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTab(t.key)}
                    className={`relative isolate rounded-chip px-3 py-1.5 text-xs font-medium transition-colors ${
                      tab === t.key ? 'text-lab-accent' : 'text-ink-dim hover:text-ink'
                    }`}
                  >
                    {tab === t.key && (
                      <motion.span
                        layoutId="tab-pill"
                        className="absolute inset-0 -z-10 rounded-chip bg-lab-accent-soft"
                        transition={{ type: 'spring', stiffness: 480, damping: 38 }}
                        aria-hidden="true"
                      />
                    )}
                    {t.label}
                  </button>
                ))}
              </div>
              <button
                className="flex flex-none items-center gap-1.5 rounded-chip px-2.5 py-1.5 text-xs text-ink-faint transition-colors hover:text-ink"
                type="button"
                onClick={resetSandbox}
                title="把沙盒文件恢复为预置项目（对话历史保留）"
              ><ArrowCounterClockwiseIcon size={13} /> 重置沙盒</button>
            </div>

            <div className="relative min-h-0 flex-1">
              <div id="context-pane" className="h-full" hidden={tab !== 'context'}><ContextPane store={store} /></div>
              <div id="files-pane" className="h-full" hidden={tab !== 'files'}><FilesPane store={store} /></div>
              <div id="source-pane" className="h-full" hidden={tab !== 'source'}><SourcePane store={store} apiRef={sourceApi} /></div>
              <div id="tour-pane" className="h-full" hidden={tab !== 'tour'}>
                <TourPane
                  store={store}
                  tui={tui}
                  onShowSource={(file, lines) => {
                    sourceApi.current?.show(file, null, lines)
                    setTab('source')
                  }}
                />
              </div>
            </div>

            <p className="flex-none border-t border-line-soft px-3 py-2 text-[11px] leading-relaxed text-ink-faint">
              点终端 [文件 · 函数] 或地图模块直达源码；「走读」按关带你读 agent/llm/tools，可实跑印证；「沙盒文件」看 agent 每次修改的 diff
            </p>
          </aside>
        </main>
      </div>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </MotionConfig>
  )
}
