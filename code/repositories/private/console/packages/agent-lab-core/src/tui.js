// js/tui.js
// 注释化终端 —— 对应 nano-pi 的 src/tui.ts（readline 终端 UI 的浏览器版）。
//
// 终端 UI 框架的功课不做 differential renderer、不做组件树、不做 markdown 渲染。
// 但比 TS 版多做一件事：每行打印带 [文件 · 函数] 来源标注——
// 事件的 src 字段（见 agent.js）在这里变成行首小灰字，
// 一条流同时回答"打印了什么"和"是哪个函数 yield 的"。
//
// 所有动态内容用 textContent 写入（不用 innerHTML）——模型输出是不可信输入。

export class Tui {
  // ─── 1. 构造：终端骨架——输出区 / 插槽 / 输入行 ──────────────────────
  /** @param root 左侧面板容器元素（index.html 里的 #terminal） */
  constructor(root) {
    root.replaceChildren()
    this.root = root

    const out = document.createElement('div')
    out.className = 'term-out'
    const row = document.createElement('div')
    row.className = 'term-input-row'

    const prompt = document.createElement('span')
    prompt.className = 'term-prompt'
    prompt.textContent = '›'
    const input = document.createElement('input')
    input.className = 'term-input'
    input.type = 'text'
    input.placeholder = '输入任务，如：运行 test.js，修复 math.js 让所有测试通过'
    const stop = document.createElement('button')
    stop.className = 'term-stop'
    stop.type = 'button'
    stop.textContent = '停止'
    stop.hidden = true

    row.append(prompt, input, stop)
    const mid = document.createElement('div') // 插槽：期3 调试控制条挂在这里
    root.append(out, mid, row)
    this.midSlot = mid

    this.out = out
    this.input = input
    this.stopBtn = stop
    this.onPromptCb = null
    this.onAbortCb = null
    this.onSrcClickCb = null
    this.curTextEl = null // 当前流式文本行（delta 追加到它，turn 结束置 null）

    // 贴底滚动：用户没往上翻就一直跟着滚；翻上去读历史时就不再打扰
    this.stick = true
    out.addEventListener('scroll', () => {
      this.stick = out.scrollHeight - out.scrollTop - out.clientHeight < 60
    })

    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      const text = input.value.trim()
      if (!text) return
      input.value = ''
      this.printUser(text) // 终端回显（readline 的 '> xxx' 等价物）
      if (this.onPromptCb) this.onPromptCb(text)
    })
    stop.addEventListener('click', () => {
      if (this.onAbortCb) this.onAbortCb()
    })
  }

  // ─── 2. 回调注册与生命周期：onPrompt / onAbort / start / setBusy ──────
  /** 注册 prompt 回调（对应 TS 版 onPrompt） */
  onPrompt(cb) { this.onPromptCb = cb }

  /** 注册"停止"回调（对应 TS 版 onAbort / Ctrl+C） */
  onAbort(cb) { this.onAbortCb = cb }

  /** 注册来源标签点击回调（期5 源码联动：点 [文件 · 函数] 跳源码视图） */
  onSrcClick(cb) { this.onSrcClickCb = cb }

  /** 启动 TUI：聚焦输入框（对应 TS 版 start()） */
  start() { this.input.focus() }

  /** agent 开始运行时调用：禁输入、亮出停止按钮（对应 TS 版 setBusy） */
  setBusy(busy) {
    this.input.disabled = busy
    this.stopBtn.hidden = !busy
    this.root.classList.toggle('busy', busy)
    if (!busy) {
      this.finishText()
      this.input.focus()
    }
  }

  // ─── 3. 打印基元：line / highlightLastLine / srcTag（每行都由它们搭出来） ─
  /** 新建一行并贴底滚动 */
  line(className) {
    const el = document.createElement('div')
    el.className = `term-line ${className}`
    this.out.appendChild(el)
    this.lastLine = el
    if (this.stick) this.out.scrollTop = this.out.scrollHeight
    return el
  }

  /** 断点扣住时高亮最后一行——"程序计数器停在这"的视觉等价物 */
  highlightLastLine(on) {
    if (this.lastLine) this.lastLine.classList.toggle('is-current', Boolean(on))
  }

  /** 行首来源标注 [文件 · 函数]；注册了 onSrcClick 后可点击跳源码视图 */
  srcTag(parent, src) {
    if (!src) return
    const tag = document.createElement('span')
    tag.className = 'term-src'
    tag.textContent = `[${src.file} · ${src.fn}]`
    if (this.onSrcClickCb) {
      tag.classList.add('clickable')
      tag.title = '点击在源码视图中定位'
      tag.addEventListener('click', () => this.onSrcClickCb({ file: src.file, fn: src.fn }))
    }
    parent.appendChild(tag)
  }

  // ─── 4. 打印 API：事件 → 行（cli.js 的 renderEvent 逐个调用） ─────────
  /** 用户输入回显 */
  printUser(text) {
    const el = this.line('term-user')
    this.srcTag(el, { file: 'tui.js', fn: 'prompt' })
    const body = document.createElement('span')
    body.textContent = ` ${text}`
    el.appendChild(body)
  }

  /** 流式打印 assistant 文本 delta：同轮流式追加到一行，新轮新起一行 */
  printText(delta, src) {
    if (!this.curTextEl) {
      const el = this.line('term-assistant streaming')
      this.srcTag(el, src)
      const body = document.createElement('span')
      body.className = 'term-assistant-text'
      el.appendChild(body)
      this.curTextEl = el
    }
    this.curTextEl.querySelector('.term-assistant-text').append(delta)
    if (this.stick) this.out.scrollTop = this.out.scrollHeight
  }

  /** 结束当前流式文本行（去掉光标动画；turn_end / setBusy 时调用） */
  finishText() {
    if (this.curTextEl) this.curTextEl.classList.remove('streaming')
    this.curTextEl = null
  }

  /** 打印 tool 调用 */
  printToolCall(name, args, src) {
    const el = this.line('term-toolcall')
    this.srcTag(el, src)
    const nameEl = document.createElement('span')
    nameEl.className = 'tc-name'
    nameEl.textContent = ` tool: ${name}`
    const argsEl = document.createElement('span')
    argsEl.className = 'tc-args'
    argsEl.textContent = ` ${JSON.stringify(args)}`
    el.append(nameEl, argsEl)
  }

  /** 打印 tool 结果：长内容默认折叠，点击展开 */
  printToolResult(name, result, src) {
    const el = this.line('term-toolresult')
    this.srcTag(el, src)
    const nameEl = document.createElement('span')
    nameEl.className = 'tr-name'
    nameEl.textContent = ` result: ${name}`
    el.appendChild(nameEl)
    const body = document.createElement('pre')
    body.className = 'tr-body'
    body.textContent = result
    if (result.length > 400 || result.split('\n').length > 6) body.classList.add('collapsed')
    body.addEventListener('click', () => body.classList.toggle('collapsed'))
    el.appendChild(body)
  }

  /** 回合结束：分隔线（比 TS 版多展示 stopReason——它本身就是知识点） */
  printTurnEnd(stopReason, src) {
    this.finishText()
    const el = this.line('term-turnend')
    this.srcTag(el, src)
    const body = document.createElement('span')
    body.textContent = ` ── turn 结束（${stopReason}）──`
    el.appendChild(body)
  }

  /** 压缩开始：agent 要把旧消息交给 LLM 总结（期6） */
  printCompactStart(count, src) {
    this.finishText()
    const el = this.line('term-compact')
    this.srcTag(el, src)
    const body = document.createElement('span')
    body.textContent = ` ── 压缩 context：${count} 条消息超过阈值，LLM 总结旧消息中… ──`
    el.appendChild(body)
  }

  /** 压缩结束：摘要替换旧消息（失败时如实报告，context 保持原样） */
  printCompactEnd(ev, src) {
    const el = this.line('term-compact')
    this.srcTag(el, src)
    if (ev.failed) {
      const body = document.createElement('span')
      body.textContent = ` ── 压缩失败（abort / LLM 错误 / 空摘要），保留原始消息 ──`
      el.appendChild(body)
      return
    }
    const body = document.createElement('span')
    body.textContent = ` ── 压缩完成：-${ev.removed} 条 → 摘要 + 保留 ${ev.kept} 条 ──`
    el.appendChild(body)
    const sum = document.createElement('pre')
    sum.className = 'tr-body collapsed'
    sum.textContent = ev.summary
    sum.addEventListener('click', () => sum.classList.toggle('collapsed'))
    el.appendChild(sum)
  }

  /** 打印提示信息（max_tokens 截断、沙盒重置等） */
  printNotice(text) {
    const el = this.line('term-notice')
    el.textContent = text
  }

  /** 打印错误 */
  printError(text) {
    const el = this.line('term-error')
    el.textContent = text
  }
}
