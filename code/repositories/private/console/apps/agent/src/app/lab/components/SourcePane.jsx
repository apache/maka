'use client'
// src/app/components/SourcePane.jsx —— 源码联动视图（原 source-view.js 的 React 化，期5）。
//
// 把"类断点调试"补成完整闭环：真调试器 = 断点 + 源码。
//   - 点终端里任意 [文件 · 函数] 标签 → 打开对应源码，高亮那个函数并滚动到位
//   - 点顶部地图的模块节点 → 打开该文件（定位到它的核心函数）
//   - 「跟随执行」开关：断点扣住事件时自动跳到 yield 它的函数——
//     F10 单步一下，源码高亮换一处，就是 Step Over 的感觉
//
// 源码文本用 Vite 的 import.meta.glob('?raw') 构建期收进包里——
// 不再运行时 fetch，dev/build/file:// 都能看（期5 的"必须 http 服务"限制消失）。

import { useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react'
import { motion } from 'motion/react'
import { locate } from '@ggbdpq/agent-lab-core/src/web-utils/source-locate.js'

/** 构建期收进来的源码：路径 → () => Promise<text>。
 *  相对路径视角 = 本文件（web/src/app/components/）：核心 5 文件在仓库根 src/，其余在同仓 web/ 下 */
const REL_ROOT = '@ggbdpq/agent-lab-core/'
const RAW = import.meta.glob(
  ['@ggbdpq/agent-lab-core/*.js', './utils/*.js', '../**/*.jsx'],
  { query: '?raw', import: 'default' },
)

/** glob 相对 key → 展示路径（下拉与文件头显示用） */
function displayPath(p) {
  if (p.startsWith(REL_ROOT)) return 'src/' + p.slice(REL_ROOT.length)
  if (p.startsWith('../')) return 'web/src/' + p.slice(3)
  if (p.startsWith('./')) return 'web/src/app/components/' + p.slice(2)
  return p
}

/** 下拉可浏览的模块（顺序即阅读顺序，与 README 源码导读一致） */
const ORDER = [
  '@ggbdpq/agent-lab-core/cli.js', '@ggbdpq/agent-lab-core/agent.js', '@ggbdpq/agent-lab-core/llm.js',
  '@ggbdpq/agent-lab-core/tools.js', '@ggbdpq/agent-lab-core/tui.js',
  './utils/vfs.js', './utils/diff.js', './utils/pump.js',
  './utils/source-locate.js', './utils/settings.js', './utils/session-store.js',
  '../main.jsx', '../App.jsx',
  './TerminalHost.jsx', './DebugBar.jsx',
  './FlowMap.jsx', './ContextPane.jsx',
  './FilesPane.jsx', './SourcePane.jsx',
  './SettingsDialog.jsx',
]

/** 地图节点点击时的定位提示：模块 → 最能代表它的函数 */
export const NODE_FN_HINTS = {
  'agent.js': 'runAgent',
  'llm.js': 'stream',
  'cli.js': 'main',
  'tools.js': 'builtinTools',
  'tui.js': 'Tui',
}

/** src 标签里的个别名字是概念名而非真实函数，映射到真身 */
const FN_ALIASES = {
  'tui.js': { prompt: 'onPrompt' },
}

/** 'agent.js' 这类短名 → glob 全路径（src 标签和地图用的都是短名） */
function resolvePath(file) {
  if (RAW[file]) return file
  const hit = Object.keys(RAW).find(k => k.endsWith(`/${file}`))
  return hit ?? null
}

export default function SourcePane({ store, apiRef }) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [view, setView] = useState(null) // {path, text, range, fn, error}
  const cache = useRef(new Map())
  const bodyRef = useRef(null)
  const fnHeadRef = useRef(null)

  async function show(file, fn = null, lines = null) {
    const path = resolvePath(file)
    if (!path) return
    try {
      let text = cache.current.get(path)
      if (text === undefined) {
        text = await RAW[path]()
        cache.current.set(path, text)
      }
      // lines：1-based 闭区间 [a, b]（走读关卡指定的源码段），优先于函数定位
      const alias = FN_ALIASES[file]
      const target = (fn && alias && alias[fn]) || fn
      const range = lines
        ? { startLine: lines[0] - 1, endLine: lines[1] - 1 }
        : target ? locate(text, target) : null
      setView({ path, text, range, fn: lines ? null : target })
    } catch {
      setView({ path, text: '', range: null, fn, error: true })
    }
  }

  useImperativeHandle(apiRef, () => ({ show }))

  // 渲染后滚动到函数开头（留 60px 余量看上一行）
  useEffect(() => {
    if (!bodyRef.current) return
    if (fnHeadRef.current) bodyRef.current.scrollTop = fnHeadRef.current.offsetTop - 60
    else bodyRef.current.scrollTop = 0
  }, [view])

  const lines = view?.text ? view.text.split('\n') : []

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-none items-center justify-between gap-2 border-b border-line-soft px-3 py-2">
        <select
          className="min-w-0 flex-1 rounded-chip border border-line bg-raised px-2 py-1 font-mono text-[12px] text-ink outline-none"
          value={view?.path ?? ''}
          onChange={e => show(e.target.value)}
        >
          {!view && <option value="">选择文件…</option>}
          {ORDER.filter(p => RAW[p]).map(p => (
            <option key={p} value={p}>{displayPath(p)}</option>
          ))}
        </select>
        <label
          className="flex flex-none cursor-pointer select-none items-center gap-1.5 text-[11px] text-ink-faint transition-colors hover:text-ink-dim"
          title="断点扣住事件时，自动打开并高亮 yield 这个事件的函数"
        >
          <input
            type="checkbox"
            className="size-3.5 accent-lab-accent"
            checked={snap.follow}
            onChange={e => store.setFollow(e.target.checked)}
          />
          跟随执行
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-auto font-mono text-[12.5px] leading-relaxed" ref={bodyRef}>
        {!view && <div className="m-auto px-6 py-16 text-center text-[12px] leading-relaxed text-ink-faint">点终端里的 [文件 · 函数] 标签，<br />或顶部地图的模块节点</div>}
        {view?.error && <div className="m-auto px-6 py-16 text-center text-[12px] text-ink-faint">无法加载 {view.path} 的源码</div>}
        {view && !view.error && (
          <motion.div
            key={`${view.path}:${view.fn ?? ''}`}
            initial={{ opacity: 0.35 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.12 }}
          >
            <div className="sticky top-0 z-10 border-b border-line-soft bg-surface/95 px-3 py-1.5 text-[11px] text-ink-faint backdrop-blur-sm">
              {displayPath(view.path)}
              {view.range
                ? ` · ${view.fn}（${view.range.startLine + 1}-${view.range.endLine + 1} 行）`
                : view.fn ? ` ·（未找到 ${view.fn}，展示整个文件）` : ''}
            </div>
            {lines.map((line, i) => {
              const inFn = view.range && i >= view.range.startLine && i <= view.range.endLine
              const isHead = view.range && i === view.range.startLine
              return (
                <div
                  key={i}
                  ref={isHead ? fnHeadRef : null}
                  className={`flex border-l-2 ${
                    isHead ? 'border-lab-accent bg-lab-accent/10'
                    : inFn ? 'border-lab-accent/45 bg-lab-accent/5'
                    : 'border-transparent'
                  }`}
                >
                  <span className="w-10 flex-none select-none pr-3 text-right text-ink-faint">{i + 1}</span>
                  <span className="src-code min-w-0 flex-1 whitespace-pre">{line || ' '}</span>
                </div>
              )
            })}
          </motion.div>
        )}
      </div>
    </div>
  )
}
