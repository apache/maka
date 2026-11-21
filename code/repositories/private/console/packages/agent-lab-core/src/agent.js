// js/agent.js
// Agent Loop —— 整个项目的灵魂：一个 while 循环。
//
// LLM 流式回复 → 有 tool_call 就执行 → 结果放回到 Context → 继续流式
// 直到模型不再调工具（end_turn / max_tokens）或被中断（aborted / error）。
//
// 与 pi-from-scratch/src/agent.ts 逐段对应，一处差异：
//   每个事件多带 src 来源标注 { file, fn }——左侧"注释化终端"靠它
//   显示"[文件 · 函数]"，回答"这一步是谁 yield 的"
//
// 期6 补齐了 TS 版的 compaction（对话压缩）：每轮循环开头检查消息数，
// 超阈值就让 LLM 总结旧消息、用摘要替换——"context 有上限，满了要压缩"
// 是 agent 自管理上下文的核心能力。阈值默认与 TS 版一致（50/20），
// 可经 opts 覆盖（设置面板里可调，方便演示时调低眼看它触发）。
//
// 直接 import stream 而非依赖注入——让学习者一眼看到"这是 LLM 交互点"。
// compactContext 的 streamFn 注入参数是唯一例外：为了无头测试假 LLM。

import { stream, buildAssistantMessage, buildToolResultMessage } from './llm.js'

// ─── 1. compaction 常量：阈值与保留条数 ──────────────────────────────
/** compaction 触发阈值：消息数超过此值时压缩旧消息（与 TS 版一致，可在设置面板调低演示） */
const DEFAULT_COMPACT_THRESHOLD = 50
/** compaction 保留近期消息数 */
const DEFAULT_KEEP_RECENT = 20

/**
 * 工具定义：name + 描述 + JSON Schema 参数 + execute 函数
 * （JS 版写在 JSDoc 里，形状与 TS 版的 AgentTool 一致）
 */

/**
 * agent 对外的事件流，供 UI 消费：
 *   assistant_text | tool_call | tool_result | turn_end | compact_start | compact_end
 *   每个都带 src: { file, fn } —— 事件诞生的模块与函数
 */

// ─── 2. compactContext：对话压缩（期6，与 runAgent 一起读更完整） ────────
/**
 * 对话压缩：当消息过多时，让 LLM 总结旧消息，用摘要替换。
 * 教的是"context 有上限，满了要压缩"——agent 自管理上下文的核心能力。
 * pi 的实现 970 行含 token 估算/cut point 边界/split turn 等，教学版极简为消息条数近似。
 *
 * 三重失败保护：abort 不压（避免空摘要损坏 context）、LLM 出错不压、
 * 空摘要不压——保留原始消息永远比空摘要安全。
 *
 * @param opts { threshold?, keepRecent?, streamFn? } streamFn 供无头测试注入假 LLM
 * @returns 压缩成功返回 { summary, removed, kept }；未触发/失败返回 null
 */
export async function compactContext(model, context, signal, opts = {}) {
  const streamFn = opts.streamFn ?? stream
  const threshold = opts.threshold ?? DEFAULT_COMPACT_THRESHOLD
  const keepRecent = opts.keepRecent ?? DEFAULT_KEEP_RECENT
  if (signal?.aborted) return null
  if (context.messages.length < threshold) return null

  const oldMessages = context.messages.slice(0, -keepRecent)
  const recentMessages = context.messages.slice(-keepRecent)

  // 把旧消息序列化成纯文本让 LLM 总结
  const conversationText = oldMessages
    .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n')

  // 用一轮非流式调用让 LLM 总结
  const summaryContext = {
    systemPrompt: '请将以下对话总结为简洁的上下文摘要，保留关键决策、已做的工作和待办事项。',
    messages: [{ role: 'user', content: conversationText }],
  }

  let summary = ''
  let failed = false
  for await (const ev of streamFn(model, summaryContext, { signal })) {
    if (ev.type === 'text_delta') summary += ev.delta
    else if (ev.type === 'error' || (ev.type === 'done' && ev.stopReason === 'aborted')) { failed = true; break }
  }

  // 压缩失败时不替换 context——保留原始消息比空摘要更安全
  if (failed || !summary) return null

  // 用摘要消息替换旧消息，保留近期消息
  context.messages = [
    { role: 'user', content: `[context summary]\n${summary}` },
    ...recentMessages,
  ]
  return { summary, removed: oldMessages.length, kept: recentMessages.length }
}

/**
 * 运行 agent 循环。无 max_steps——loop 到模型说停为止。
 *
 * @param model    模型配置 { apiKey, model, baseUrl?, maxTokens? }
 * @param context  对话上下文（会被原地修改——context 就是 agent 的全部状态）
 * @param tools    工具注册表
 * @param signal   abort 信号（浏览器版对应"停止"按钮，等价 Ctrl+C）
 * @param opts     { compactThreshold?, keepRecent?, streamFn? } compaction 配置（默认 50/20）
 */
// ─── 3. runAgent 入口：async generator，节奏控制权在消费者手里 ──────────
export async function* runAgent(model, context, tools, signal, opts = {}) {
  const toolMap = new Map(tools.map(t => [t.name, t]))
  const toolDefs = tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))

  while (true) {
    // ─── 4. 圈首：压缩检查——消息过多先总结替换，不到阈值等于不存在 ──────
    // 0. 对话压缩：消息过多时先压缩旧消息（compact_start/end 只在真正触发时才发）
    if (context.messages.length >= (opts.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD)) {
      yield { type: 'compact_start', count: context.messages.length, src: { file: 'agent.js', fn: 'compactContext' } }
      const done = await compactContext(model, context, signal, {
        threshold: opts.compactThreshold,
        keepRecent: opts.keepRecent,
        streamFn: opts.streamFn,
      })
      yield done
        ? { type: 'compact_end', summary: done.summary, removed: done.removed, kept: done.kept, src: { file: 'agent.js', fn: 'compactContext' } }
        : { type: 'compact_end', failed: true, src: { file: 'agent.js', fn: 'compactContext' } }
    }

    // ─── 5. 流式收集：for await 逐事件分派，三个累积器记账 ─────────────
    // 1. 流式调用 LLM，收集文本和 tool_calls
    let text = ''
    let stopReason = 'end_turn' // 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted'
    const toolCalls = []

    for await (const ev of stream(model, context, { tools: toolDefs, signal })) {
      if (ev.type === 'text_delta') {
        text += ev.delta
        // 事件诞生在 llm.js 的 stream()，agent 只是转发——src 标诞生地
        yield { type: 'assistant_text', delta: ev.delta, src: { file: 'llm.js', fn: 'stream' } }
      } else if (ev.type === 'tool_call') {
        toolCalls.push({ id: ev.id, name: ev.name, args: ev.args })
        yield { type: 'tool_call', id: ev.id, name: ev.name, args: ev.args, src: { file: 'llm.js', fn: 'stream' } }
      } else if (ev.type === 'done') {
        stopReason = ev.stopReason
        if (ev.stopReason === 'aborted') {
          // abort 时丢弃 tool_calls（无对应 tool_result 会导致下轮 API 报错）
          context.messages.push(buildAssistantMessage(text, []))
          yield { type: 'turn_end', stopReason: 'aborted', src: { file: 'agent.js', fn: 'runAgent' } }
          return
        }
      } else if (ev.type === 'error') {
        context.messages.push(buildAssistantMessage(text, []))
        yield { type: 'assistant_text', delta: `\n[error] ${ev.error.message}`, src: { file: 'agent.js', fn: 'runAgent' } }
        yield { type: 'turn_end', stopReason: 'error', src: { file: 'agent.js', fn: 'runAgent' } }
        return
      }
    }

    // ─── 6. 回合收尾：塞回 context、截断保护、end_turn 判断 ────────────
    // 2. 把 assistant 回复塞回 context
    context.messages.push(buildAssistantMessage(text, toolCalls))

    // 3. 截断处理：max_tokens 时 tool args 可能不完整，不执行，把错误放回 Context 让模型重发
    if (stopReason === 'max_tokens' && toolCalls.length > 0) {
      const results = toolCalls.map(tc => ({
        tool_use_id: tc.id,
        content: `error: output truncated by max_tokens, tool "${tc.name}" args may be incomplete.`,
      }))
      context.messages.push(buildToolResultMessage(results))
      for (let i = 0; i < toolCalls.length; i++) {
        yield { type: 'tool_result', id: toolCalls[i].id, name: toolCalls[i].name, result: results[i].content, src: { file: 'agent.js', fn: 'runAgent' } }
      }
      continue
    }

    // 4. 没有 tool_call → 循环结束
    // 畸形 API 可能返回 tool_use 但无 tool_call delta，此时视为正常结束
    const reason = stopReason === 'tool_use' ? 'end_turn' : stopReason
    if (toolCalls.length === 0) {
      yield { type: 'turn_end', stopReason: reason, src: { file: 'agent.js', fn: 'runAgent' } }
      return
    }

    // ─── 7. 执行工具与回环：串行执行 → 结果回 Context → 回到 while 顶部 ──
    // 5. 串行执行 tool_calls（pi 有 sequential/parallel 两种模式，教学版统一串行）
    // args 未经 parameters 验证直接传入 execute（教学版简化，生产应先 validate）
    const results = []
    for (const tc of toolCalls) {
      const tool = toolMap.get(tc.name)
      let result
      if (!tool) {
        result = `error: tool "${tc.name}" not found`
        yield {
          type: 'tool_result', id: tc.id, name: tc.name, result,
          src: { file: 'agent.js', fn: 'runAgent' }, // 找不到工具：结果由 agent 生成
        }
      } else {
        try {
          result = await tool.execute(tc.args, signal)
          yield {
            type: 'tool_result', id: tc.id, name: tc.name, result,
            src: { file: 'tools.js', fn: `${tc.name}.execute` }, // 正常路径：结果来自工具本身
          }
        } catch (e) {
          result = `error: ${e.message}`
          yield {
            type: 'tool_result', id: tc.id, name: tc.name, result,
            src: { file: 'tools.js', fn: `${tc.name}.execute` }, // 工具抛错也标工具——错误就发生在它内部
          }
        }
      }
      results.push({ tool_use_id: tc.id, content: result })
      if (signal && signal.aborted) break
    }

    // 6. 为被 abort 跳过的 tool_call 补上错误结果（API 要求每个 tool_call 都有对应 tool_result）
    for (const tc of toolCalls.slice(results.length)) {
      results.push({ tool_use_id: tc.id, content: 'error: aborted' })
      yield { type: 'tool_result', id: tc.id, name: tc.name, result: 'error: aborted', src: { file: 'agent.js', fn: 'runAgent' } }
    }

    // 7. 把 tool_result 放回到 Context，进入下一轮 —— 循环的"环"就在这里
    context.messages.push(buildToolResultMessage(results))
  }
}
