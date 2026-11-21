// src/cli.js
// 拼装层 —— 对应 nano-pi 的 src/cli.ts，把 llm / agent / tui / tools 粘起来。
//
// 与 TS 版的差异：
//   - 设置（utils/settings.js + 设置弹窗）替代环境变量；每轮实时读取，改完不用刷新
//   - 无 session 持久化——浏览器刷新即重置，教学定位正好符合"从头看一遍"
//   - 事件不再用 for-await 直通消费，而是经 EventPump 油门（utils/pump.js）放行
//   - 视图状态委托给 session-store（React 外壳从它渲染）；本文件不 import React——
//     终端打印仍由这里的 renderEvent 驱动（tui 是核心学习文件，保持命令式）
//
// main({ tui, store, openSource }) 由 app/ 外壳调用，返回 { context }。

import { runAgent } from './agent.js'
import { builtinTools } from './tools.js'
import * as vfs from './web-utils/vfs.js'
import { getSettings } from './web-utils/settings.js'
import { EventPump } from './web-utils/pump.js'

export function main({ tui, store, openSource }) {
  // ─── 1. 沙盒与 context：agent 的全部状态从这里开始 ───────────────────
  // 沙盒：预置 bug 项目；右侧文件视图展示内容与每次修改的 diff（期4）
  vfs.resetSandbox()
  store.bumpVfs()

  // context：agent 的全部状态。messages 跨轮持久（同一引用一直 push）；
  // systemPrompt 每轮从设置实时读——改设置不用刷新页面
  const context = {
    get systemPrompt() { return getSettings().systemPrompt },
    messages: [],
  }
  store.startContext(context)

  const tools = builtinTools()

  tui.printNotice('pi-web-dev 已就绪。试试：运行 test.js，修复 math.js 让所有测试通过')
  tui.printNotice('行首 [文件 · 函数] 是这一步的来源；F10 单步 / F8 继续；断点在下方控制条设置')
  tui.printNotice('想看 compaction：⚙ 设置里把阈值调低（如 8/4），多聊几轮把消息推过阈值')

  // ─── 2. renderEvent：事件放行后的分发——终端打印明细，其余视图状态进 store ──
  function renderEvent(ev) {
    store.handleEvent(ev)
    switch (ev.type) {
      case 'assistant_text': tui.printText(ev.delta, ev.src); break
      case 'tool_call': tui.printToolCall(ev.name, ev.args, ev.src); break
      case 'tool_result':
        tui.printToolResult(ev.name, ev.result, ev.src)
        store.bumpVfs() // 工具可能刚改过沙盒，右侧 diff 视图同步
        break
      case 'turn_end':
        if (ev.stopReason === 'max_tokens') tui.printNotice('output truncated by max_tokens')
        if (ev.stopReason === 'error') tui.printNotice('[error occurred]')
        tui.printTurnEnd(ev.stopReason, ev.src)
        break
      case 'compact_start':
        tui.printCompactStart(ev.count, ev.src)
        break
      case 'compact_end':
        tui.printCompactEnd(ev, ev.src)
        break
    }
  }

  // ─── 3. endTurn：回合收尾——解锁输入、地图熄灭 ──────────────────────
  function endTurn() {
    store.setRunning(false)
    store.setMapActive(null)
    store.commit()
    tui.setBusy(false)
  }

  // ─── 4. 每轮装配：用户输入 → runAgent 事件流 → 油门逐个放行 ──────────
  // （本文件的心脏：agent 只管生成事件，快慢停走全由油门决定）
  tui.onPrompt(async (text) => {
    store.userPrompt()
    context.messages.push({ role: 'user', content: text })
    store.pushUser(text)

    tui.setBusy(true)
    store.setRunning(true)
    store.setStatus('自动播放中')
    store.commit()

    // compaction 配置每轮实时读取（期6）：改完阈值下一轮生效，仪表盘分母同步
    const compactOpts = {
      compactThreshold: getSettings().compactThreshold,
      keepRecent: getSettings().keepRecent,
    }

    const ctrl = new AbortController()
    const gen = runAgent(getModel(), context, tools, ctrl.signal, compactOpts)

    const pump = new EventPump(gen, {
      onEvent: (ev) => {
        tui.highlightLastLine(false) // 上一处扣住的高亮随放行解除
        store.clearHeld()
        store.commit()
        renderEvent(ev)
      },
      onWait: () => {
        store.setStatus('等待下一个事件…（LLM 请求 / 工具执行中）')
        store.commit()
      },
      onHold: (ev, reason) => {
        tui.highlightLastLine(true) // 程序计数器停在这里
        store.setHeld(ev, reason)
        store.commit()
        // 跟随执行（期5）：断点扣住时自动打开 yield 这个函数的源码——
        // F10 单步一下，高亮换一处，就是调试器 Step Over 的手感
        if (store.getSnapshot().follow && ev.src) openSource(ev.src.file, ev.src.fn)
      },
      onResume: () => {
        store.setStatus('自动播放中')
        store.commit()
      },
      onDone: endTurn,
      onError: (e) => {
        tui.printError(`[error] ${e.message}`)
        endTurn()
      },
    })
    store.setPump(pump)
    // 停止 = abort + 油门全开：让 aborted 收尾事件流走完再结束回合
    tui.onAbort(() => { ctrl.abort(); pump.forceAuto() })
    pump.start()
  })

  tui.start()
  return { context }
}

// ─── 5. getModel：从设置构造模型配置（每轮实时读取——改了下一轮生效） ────
export function getModel() {
  const s = getSettings()
  return { apiKey: s.apiKey, model: s.model, baseUrl: s.baseUrl, maxTokens: 4096 }
}
