// src/utils/session-store.js
// React 外壳的唯一状态源（纯 JS，无 DOM，不 import React）。
//
// 期1-期6 三个视图各自维护 DOM（map / context-view / debugbar）；期7 组件化后
// 改为单向数据流：cli.js（核心拼装层）把事件交给 store，store 更新状态并广播，
// React 组件用 useSyncExternalStore 从快照渲染。
//
// 这里聚合并移植了原三个视图的事件逻辑（卡片模型 / 地图数据包 / 调试状态），
// 语义与期6 完全一致——包括 compaction 的 rebuild 与"事件驱动视图的边界"。
//
// 快照语义：内部状态随便改，commit() 后 getSnapshot() 返回新对象；
// useSyncExternalStore 靠对象身份变化触发重渲染。

import { contextToOpenAIMessages } from '@ggbdpq/agent-lab-core/src/llm.js'

/** 配对色板：同一个 tool_call 的 chip 和 result block 拿到同一种颜色 */
const PAIR_COLORS = ['#58a6ff', '#d29922', '#3fb950', '#bc8cff', '#39c5cf', '#f85149']

export function pairColor(id) {
  let h = 0
  const s = String(id)
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return PAIR_COLORS[h % PAIR_COLORS.length]
}

/** 地图数据包配色：按"内容是什么"着色，与终端/Context 视图的语义色一致 */
const PACKET_COLORS = {
  user: '#e6edf3',   // 用户文本
  text: '#58a6ff',   // assistant 文本 delta
  tool: '#d29922',   // tool_call
  result: '#3fb950', // tool_result
  turn: '#8b949e',   // turn_end 回程
  compact: '#a371f7', // compaction：agent→llm 的总结请求与摘要回程（紫）
}

/** 地图节点与边（与原 map.js 一致：tui→cli→agent 主干 + agent 右伸两条环边） */
export const MAP_NODES = [
  { id: 'tui.js', cx: 58, cy: 40 },
  { id: 'cli.js', cx: 190, cy: 40 },
  { id: 'agent.js', cx: 330, cy: 40 },
  { id: 'llm.js', cx: 496, cy: 24 },
  { id: 'tools.js', cx: 496, cy: 78 },
]

export const MAP_EDGES = {
  'tui-cli': 'M 96 40 L 152 40',
  'cli-agent': 'M 228 40 L 292 40',
  'agent-llm': 'M 368 34 L 458 27',
  'agent-tools': 'M 368 46 L 458 75',
}

let packetSeq = 0
let cardSeq = 0
const nextCardId = () => ++cardSeq

export function createSessionStore() {
  const listeners = new Set()

  // s 是可变内部状态；commit() 生成新快照广播出去
  const s = {
    // Context 卡片模型（ContextPane 渲染）
    cards: [],           // {kind, ...} kind: system|user|assistant|toolresult|summary
    messageCount: 0,     // 卡片数 = 消息数（system 独立字段不计入）
    pending: null,       // 流式中的 assistant 卡片（消息在流结束才 push）
    turnIndex: 0,        // 用户轮次（tool_result 分组边界）
    resultCard: null,    // 同轮连续 tool_result 并进一张卡
    contextVersion: 0,   // wire 视角 / 仪表盘的刷新时机（只在消息真正进 context 时 +1）
    wireMode: false,
    flash: null,         // {id, seq} 配对闪烁（650ms 自动熄灭）
    // 地图（FlowMap 渲染）
    mapActive: null,
    packets: [],         // {id, edge, reverse, color}（600ms 自清除）
    lastTextPulse: 0,    // assistant_text 包节流（delta 到达频率远高于动画时长）
    // 调试条（DebugBar 渲染）
    running: false,
    status: '空闲',
    held: null,          // {ev, reason} 被扣住的事件与原因
    bpSet: new Set(),    // 断点集合（跨回合持久）
    slowMo: false,
    // 跟随执行（SourcePane 的开关，cli.js 断点扣住时读取）
    follow: false,
    // 沙盒文件版本（tool_result / reset 后 +1，FilesPane 重渲染）
    vfsVersion: 0,
    rebuildId: 0, // compaction 全量重建计数（ContextPane 据此回到顶部看摘要卡）
  }

  let snapshot = { ...s }
  let context = null // 权威 context（startContext 注入；wire 视角与仪表盘直接读它）

  function commit() {
    snapshot = { ...s }
    for (const fn of listeners) fn()
  }

  // ===== 订阅（useSyncExternalStore 协议） =====

  function subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  const getSnapshot = () => snapshot
  const getContext = () => context

  // ===== Context 卡片（原 ContextView 的事件逻辑，去 DOM 化） =====

  /** 开场：注入权威 context，渲染 system 置顶卡（systemPrompt 是独立字段不占 messages 位） */
  function startContext(ctx) {
    context = ctx
    s.cards = [{ id: nextCardId(), kind: 'system', text: ctx.systemPrompt }]
    s.messageCount = 0
    commit()
  }

  /** 用户提交输入：新开一轮（turnIndex 推进，tool_result 分组从此重新计数） */
  function pushUser(text) {
    s.turnIndex++
    s.resultCard = null
    finalizePending()
    s.cards = [...s.cards, { id: nextCardId(), kind: 'user', text }]
    s.messageCount++
    s.contextVersion++
    commit()
  }

  function beginAssistantIfNeeded() {
    if (s.pending) return
    const card = { id: nextCardId(), kind: 'assistant', streaming: true, text: '', tools: [] }
    s.cards = [...s.cards, card]
    s.pending = card
    s.messageCount++
  }

  function finalizePending() {
    if (!s.pending) return
    s.pending.streaming = false
    s.pending = null
    s.cards = [...s.cards]
  }

  function addToolChip(ev) {
    s.pending.tools.push({ id: ev.id, name: ev.name, args: ev.args })
    s.cards = [...s.cards]
  }

  function addToolResult(ev) {
    // 同轮连续结果 → 同一张卡（一条 user message 的多个 tool_result block）
    if (!(s.resultCard && s.resultCard.turn === s.turnIndex)) {
      const card = { id: nextCardId(), kind: 'toolresult', turn: s.turnIndex, blocks: [] }
      s.cards = [...s.cards, card]
      s.resultCard = card
      s.messageCount++
    }
    s.resultCard.blocks.push({ id: ev.id, name: ev.name, result: ev.result })
    s.cards = [...s.cards]
    setFlash(ev.id)
  }

  /** 配对闪烁：结果块 + 对应的 tool_use chip 同亮一下（650ms） */
  let flashSeq = 0
  function setFlash(id) {
    const seq = ++flashSeq
    s.flash = { id, seq }
    setTimeout(() => {
      if (s.flash && s.flash.seq === seq) {
        s.flash = null
        commit()
      }
    }, 650)
  }

  /**
   * compact_end 后从 context.messages 全量重建卡片流（期6）。
   * context.messages 被原地替换——增量拼卡片的状态全部作废。
   * 这是事件驱动视图的边界：数组被"替换"而非"追加"时，rebuild 比追状态可靠。
   */
  function rebuild() {
    s.pending = null
    s.resultCard = null
    const cards = [{ id: nextCardId(), kind: 'system', text: context.systemPrompt }]
    for (const msg of context.messages) {
      if (typeof msg.content === 'string' && msg.content.startsWith('[context summary]')) {
        cards.push({ id: nextCardId(), kind: 'summary', text: msg.content })
        continue
      }
      if (typeof msg.content === 'string') {
        cards.push({ id: nextCardId(), kind: msg.role === 'user' ? 'user' : 'assistant', text: msg.content })
      } else if (msg.role === 'assistant') {
        cards.push({
          id: nextCardId(),
          kind: 'assistant',
          text: msg.content.filter(b => b.type === 'text').map(b => b.text).join(''),
          tools: msg.content.filter(b => b.type === 'tool_use')
            .map(b => ({ id: b.id, name: b.name, args: b.input })),
        })
      } else {
        cards.push({
          id: nextCardId(),
          kind: 'toolresult',
          blocks: msg.content.filter(b => b.type === 'tool_result')
            .map(b => ({ id: b.tool_use_id, name: null, result: b.content })),
        })
      }
    }
    s.cards = cards
    s.messageCount = context.messages.length
    s.rebuildId++
  }

  function contextEvent(ev) {
    if (ev.type === 'assistant_text') {
      beginAssistantIfNeeded()
      s.pending.text += ev.delta
      s.cards = [...s.cards]
    } else if (ev.type === 'tool_call') {
      beginAssistantIfNeeded()
      addToolChip(ev)
    } else if (ev.type === 'tool_result') {
      finalizePending() // 结果回来时 assistant 消息已 push，卡片定格
      addToolResult(ev)
      s.contextVersion++ // context.messages 变了（结果即将 push），wire 同步
    } else if (ev.type === 'turn_end') {
      finalizePending()
      s.contextVersion++
    } else if (ev.type === 'compact_start') {
      finalizePending() // 压缩开始前把流式中的卡片定格
    } else if (ev.type === 'compact_end') {
      rebuild()
      s.contextVersion++
    }
  }

  // ===== 地图（原 MapView 的事件逻辑，去 DOM 化） =====

  function setMapActive(id) {
    s.mapActive = id
  }

  /** 沿边发射一个数据包（600ms 后自清除；SVG 动画由组件渲染） */
  function pulse(edge, reverse, color) {
    const id = ++packetSeq
    s.packets = [...s.packets, { id, edge, reverse, color }]
    setTimeout(() => {
      s.packets = s.packets.filter(p => p.id !== id)
      commit()
    }, 600)
  }

  /** 用户提交输入：白包 tui→cli→agent 两跳（第二跳延迟半秒，模拟进入循环） */
  function userPrompt() {
    setMapActive('tui.js')
    pulse('tui-cli', false, PACKET_COLORS.user)
    commit()
    setTimeout(() => {
      setMapActive('cli.js')
      pulse('cli-agent', false, PACKET_COLORS.user)
      commit()
    }, 300)
    setTimeout(() => {
      setMapActive('agent.js')
      commit()
    }, 620)
  }

  function mapEvent(ev) {
    if (ev.type === 'assistant_text') {
      setMapActive('llm.js')
      // delta 到达频率远高于动画时长，节流到 ~8 包/秒
      const now = performance.now()
      if (now - s.lastTextPulse > 120) {
        s.lastTextPulse = now
        pulse('agent-llm', true, PACKET_COLORS.text)
      }
    } else if (ev.type === 'tool_call') {
      // 决策从 llm 回到 agent，紧接着派发给工具执行
      setMapActive('llm.js')
      pulse('agent-llm', true, PACKET_COLORS.tool)
      setTimeout(() => {
        setMapActive('tools.js')
        pulse('agent-tools', false, PACKET_COLORS.tool)
        commit()
      }, 260)
    } else if (ev.type === 'tool_result') {
      if (ev.src && ev.src.file === 'tools.js') {
        setMapActive('tools.js')
        pulse('agent-tools', true, PACKET_COLORS.result)
      } else {
        // src 是 agent.js：not found / abort 补位结果，没进过 tools
        setMapActive('agent.js')
      }
    } else if (ev.type === 'turn_end') {
      // 回程：agent → cli → tui
      setMapActive('agent.js')
      pulse('cli-agent', true, PACKET_COLORS.turn)
      setTimeout(() => pulse('tui-cli', true, PACKET_COLORS.turn), 260)
    } else if (ev.type === 'compact_start') {
      // 压缩：agent 把旧消息发给 llm 总结（紫色请求包）
      setMapActive('llm.js')
      pulse('agent-llm', false, PACKET_COLORS.compact)
    } else if (ev.type === 'compact_end') {
      // 摘要回来，context 被替换（紫色回程包）
      setMapActive('agent.js')
      pulse('agent-llm', true, PACKET_COLORS.compact)
    }
  }

  // ===== 对外：cli.js 每个事件调用一次 =====

  function handleEvent(ev) {
    mapEvent(ev)
    contextEvent(ev)
    commit()
  }

  // ===== 调试条状态 =====

  function setRunning(v) {
    s.running = v
    if (!v) s.status = '空闲'
  }

  function setStatus(text) { s.status = text }

  function setHeld(ev, reason) {
    s.held = { ev, reason }
  }

  function clearHeld() { s.held = null }

  function toggleBreakpoint(type) {
    const next = new Set(s.bpSet)
    if (next.has(type)) next.delete(type)
    else next.add(type)
    s.bpSet = next
    if (store.pump) store.pump.breakpoints = new Set(next) // 运行中实时生效
    commit()
  }

  function toggleSlowMo() {
    s.slowMo = !s.slowMo
    if (store.pump) store.pump.slowMo = s.slowMo
    commit()
  }

  function toggleWire() {
    s.wireMode = !s.wireMode
    commit()
  }

  function setFollow(v) {
    s.follow = v
    commit()
  }

  /** 每轮 turn 注入新油门：断点/慢放配置从调试状态带过去（跨回合持久） */
  function setPump(pump) {
    store.pump = pump
    if (pump) {
      pump.breakpoints = new Set(s.bpSet)
      pump.slowMo = s.slowMo
    }
  }

  function bumpVfs() {
    s.vfsVersion++
    commit()
  }

  /** OpenAI 视角的 wire JSON（只在 contextVersion 变化时由组件重算） */
  function wireJson() {
    return context ? JSON.stringify(contextToOpenAIMessages(context), null, 2) : ''
  }

  const store = {
    pump: null, // 当轮 EventPump（DebugBar 按钮直接操作它）
    subscribe,
    getSnapshot,
    getContext,
    startContext,
    pushUser,
    handleEvent,
    userPrompt,
    setMapActive,
    setRunning,
    setStatus,
    setHeld,
    clearHeld,
    toggleBreakpoint,
    toggleSlowMo,
    toggleWire,
    setFollow,
    setPump,
    bumpVfs,
    wireJson,
    commit,
  }
  return store
}
