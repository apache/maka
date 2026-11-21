// js/pump.js
// 事件油门 —— 断点系统的核心（纯逻辑，无 DOM，可在 Node 里无头测试）。
//
// 期1/期2 里 cli.js 用 for-await 直通消费 agent 事件（油门全开）；
// 期3 换成本模块：油门逐个拉取事件，决定每个事件"立即放行"还是"扣住等指令"。
//
// 三级控制（对应共识 Q6）：
//   自动播放  mode='auto'，事件到达即放行（期1/期2 的行为）
//   暂停      mode='paused'，下一个到达的事件被扣住
//   单步      step()——扣住状态下放行恰好一个事件；事件还在路上（等 LLM 响应）
//             时点单步，则下一个事件到达即放行一个（pendingStep 排队）
//
// 条件断点：事件类型级（delta 不断点——一条回复几百个 delta 点不动）：
//   tool_call / tool_result / turn_end / compact_end / round_start（轮边界）
//   round_start = 每轮循环的第一个事件：回合的第一个事件，或 tool_result /
//   compact_end 之后的第一个 assistant_text/tool_call（上一轮收尾、下一轮即将开始）
//   compact_end 可断点——压缩后先看摘要内容再放行（期6）
//   断点命中时自动播放被"打停"，直到用户继续。
//
// 背压（backpressure）：油门扣住事件时，generator 的 next() 没被调用，
// agent 的 for-await stream 停在原地，底层 fetch 在内存缓冲——天然背压，
// 不丢事件也不超前后端。这正是 async generator 架构送的红利。
//
// 注意："扣住"发生在事件已产出、尚未交给视图之前——调试器语义：
// 断点命中时你能看到"下一步是什么"，但它还没打印/没动画/没进 context。

const SLOW_MO_MS = 400

/** 断点可挂的事件类型（chip 顺序即 debugbar 展示顺序） */
export const BREAKPOINT_TYPES = ['tool_call', 'tool_result', 'turn_end', 'compact_end', 'round_start']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class EventPump {
  /**
   * @param source   agent 的 async generator（runAgent(...) 的返回值）
   * @param handlers {
   *   onEvent(ev, index)   事件放行（此时才允许渲染），
   *   onWait()             即将拉取下一个事件（可能在等 LLM 响应/工具执行），
   *   onHold(ev, reason)   事件被扣住（断点命中或暂停），
   *   onResume()           从扣住恢复自动播放，
   *   onDone()             事件流结束（generator done），
   *   onError(error)       拉取过程抛异常，
   * }
   */
  constructor(source, handlers = {}) {
    this.source = source
    this.h = handlers
    this.mode = 'auto' // 'auto' | 'paused'
    this.breakpoints = new Set()
    this.slowMo = false
    this.eventIndex = 0
    this.lastType = null
    this.isFirst = true // 回合内第一个事件（round_start 判定用）
    this.held = null // 被扣住的事件
    this.pendingStep = false // 单步已排队（事件还在路上）
    this.releaseCb = null // 扣住时的放行回调
  }

  /** 启动拉取循环（fire-and-forget，结束走 onDone/onError） */
  start() { this.pullLoop() }

  async pullLoop() {
    try {
      while (true) {
        if (this.h.onWait) this.h.onWait()
        const { value: ev, done } = await this.source.next()
        if (done) break

        const bp = this.hitBreakpoint(ev)
        const willHold = this.mode === 'paused' || bp
        if (willHold) {
          if (bp) this.mode = 'paused' // 断点把自动播放打停
          if (this.pendingStep) {
            // 单步已排队：这一个事件就是用户要的那一步，直接放行
            this.pendingStep = false
          } else {
            this.held = ev
            if (this.h.onHold) this.h.onHold(ev, bp ? `断点命中：${bp}` : '已暂停')
            await new Promise((r) => { this.releaseCb = r })
            this.releaseCb = null
            this.held = null
          }
        }

        this.deliver(ev)
        if (this.slowMo) await sleep(SLOW_MO_MS)
      }
      if (this.h.onDone) this.h.onDone()
    } catch (e) {
      if (this.h.onError) this.h.onError(e)
    }
  }

  /** 放行一个事件：计数、记 lastType、交给视图 */
  deliver(ev) {
    this.eventIndex++
    this.lastType = ev.type
    this.isFirst = false
    if (this.h.onEvent) this.h.onEvent(ev, this.eventIndex)
  }

  /** 命中哪种断点？返回断点名或 null（round_start 是推导出的虚拟断点） */
  hitBreakpoint(ev) {
    if (this.breakpoints.has(ev.type)) return ev.type
    if (
      this.breakpoints.has('round_start') &&
      (this.isFirst || this.lastType === 'tool_result' || this.lastType === 'compact_end') &&
      (ev.type === 'assistant_text' || ev.type === 'tool_call')
    ) return 'round_start'
    return null
  }

  // ===== UI 操作（debugbar 调用） =====

  /** 继续自动播放：扣住的放行，之后不再停（除非再命中断点） */
  play() {
    this.mode = 'auto'
    this.pendingStep = false
    this.releaseIfHeld()
    if (this.h.onResume) this.h.onResume()
  }

  /** 暂停：下一个到达的事件被扣住 */
  pause() { this.mode = 'paused' }

  /**
   * 单步：扣住中 → 放行当前这一个（下一个照常扣住）；
   * 事件在路上 → 排队，到达即放行一个。等价于调试器的 Step Over。
   */
  step() {
    this.mode = 'paused'
    if (this.held) {
      this.releaseIfHeld()
    } else {
      this.pendingStep = true
    }
  }

  /** 停止按钮专用：油门全开 + 放行扣住的事件，让 aborted 收尾事件流走完 */
  forceAuto() {
    this.mode = 'auto'
    this.pendingStep = false
    this.releaseIfHeld()
  }

  releaseIfHeld() {
    if (this.releaseCb) {
      const r = this.releaseCb
      this.releaseCb = null
      r()
    }
  }

  toggleBreakpoint(type) {
    if (this.breakpoints.has(type)) this.breakpoints.delete(type)
    else this.breakpoints.add(type)
  }
}
