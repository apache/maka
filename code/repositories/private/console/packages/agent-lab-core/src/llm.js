// js/llm.js
// 统一 LLM API —— 把 OpenAI Completions SSE 响应解析成四种事件流。
// 只支持 OpenAI 兼容格式（GLM、DeepSeek、OpenRouter、Ollama 等均兼容）。
//
// 与 pi-from-scratch/src/llm.ts 逐段对应——TS 版用的 fetch / ReadableStream /
// TextDecoder 本来就是浏览器原生 API，去掉类型标注几乎原样搬运。
//
// 消息结构（JSDoc 说明，替代 TS 类型）：
//   Message  = { role: 'user' | 'assistant', content: string | ContentBlock[] }
//   Context  = { systemPrompt?: string, messages: Message[] }
//   ContentBlock =
//     | { type: 'text', text: string }
//     | { type: 'tool_use', id, name, input }          // assistant 发起的工具调用
//     | { type: 'tool_result', tool_use_id, content }  // 塞在 user message 里回传结果

// ─── 1. contextToOpenAIMessages：先翻译再出门（纯转换，无网络） ─────────
/**
 * 把 Context 转成 OpenAI messages 格式。
 * 纯转换函数，不含网络逻辑——context 是我们的内部结构，API 要的是它的格式。
 */
export function contextToOpenAIMessages(context) {
  const messages = []
  if (context.systemPrompt) messages.push({ role: 'system', content: context.systemPrompt })

  for (const msg of context.messages) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content })
      continue
    }

    const blocks = msg.content
    if (msg.role === 'assistant') {
      const toolCalls = []
      let text = ''
      for (const b of blocks) {
        if (b.type === 'text') text += b.text
        else if (b.type === 'tool_use') {
          toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } })
        }
      }
      // OpenAI 要求 assistant 消息必须有 content（非 null）或 tool_calls。
      // 纯 tool_call 时 content 为 null；两者皆空（如 abort/error 后的无内容轮次）用空串占位，避免 API 400。
      const content = text || (toolCalls.length ? null : '')
      messages.push({ role: 'assistant', content, tool_calls: toolCalls.length ? toolCalls : undefined })
    } else {
      // user message 里的 tool_result block → OpenAI 要求独立的 role:tool 消息
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content })
        } else if (b.type === 'text') {
          messages.push({ role: 'user', content: b.text })
        }
      }
    }
  }
  return messages
}

// ─── 2. handleSSELine：单帧解析——delta 分派 + partial JSON 累积 ────────
/**
 * 解析一行 SSE data，累积 tool_call，返回 text_delta 和 stop_reason。
 * tool_call 的 arguments 是分片到达的 partial JSON——按 index 累积字符串，流结束再 parse。
 */
function handleSSELine(data, toolCallBuffers) {
  let chunk
  try { chunk = JSON.parse(data) } catch { return { textDelta: null, stopReason: null } }

  const choice = chunk.choices && chunk.choices[0]
  if (!choice) return { textDelta: null, stopReason: null }

  let textDelta = null
  let stopReason = null

  if (choice.delta && choice.delta.content) textDelta = choice.delta.content

  if (choice.delta && choice.delta.tool_calls) {
    for (const tc of choice.delta.tool_calls) {
      const idx = tc.index ?? 0
      if (!toolCallBuffers.has(idx)) {
        toolCallBuffers.set(idx, { id: tc.id ?? `call_${idx}`, name: '', argsBuf: '' })
      }
      const entry = toolCallBuffers.get(idx)
      if (tc.id) entry.id = tc.id
      if (tc.function && tc.function.name) entry.name = tc.function.name
      if (tc.function && tc.function.arguments) entry.argsBuf += tc.function.arguments
    }
  }

  // finish_reason 映射：tool_calls → tool_use，length → max_tokens，stop → end_turn（默认值）
  if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use'
  else if (choice.finish_reason === 'length') stopReason = 'max_tokens'

  return { textDelta, stopReason }
}

// ─── 3. flushToolCalls：流结束才拼图——argsBuf 整体 parse 再发出 ────────
/** 流结束：把累积的 tool_calls 按 index 排序后整体发出 */
function flushToolCalls(toolCallBuffers) {
  const calls = []
  for (const [, tc] of [...toolCallBuffers].sort((a, b) => a[0] - b[0])) {
    let args = {}
    if (tc.argsBuf) {
      try { args = JSON.parse(tc.argsBuf) } catch { args = {} }
    }
    calls.push({ id: tc.id, name: tc.name, args })
  }
  return calls
}

// ─── 4. stream 主流程：构造请求 → fetch → SSE 逐行 → 发出事件 ─────────
/**
 * 调用 OpenAI Completions API（streaming），返回统一事件流：
 *   { type: 'text_delta', delta } | { type: 'tool_call', id, name, args }
 *   | { type: 'done', stopReason } | { type: 'error', error }
 *
 * @param model   { apiKey, model, baseUrl?, maxTokens? }
 * @param context Context
 * @param opts    { tools?: ToolDef[], signal?: AbortSignal }
 */
export async function* stream(model, context, opts = {}) {
  const url = `${model.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`
  const messages = contextToOpenAIMessages(context)

  const body = { model: model.model, stream: true, messages }
  if (model.maxTokens) body.max_tokens = model.maxTokens
  if (opts.tools && opts.tools.length) {
    body.tools = opts.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }

  // 发请求
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${model.apiKey}` },
      body: JSON.stringify(body),
      signal: opts.signal,
    })
  } catch (e) {
    if (opts.signal && opts.signal.aborted) { yield { type: 'done', stopReason: 'aborted' }; return }
    yield { type: 'error', error: e }; return
  }

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => 'unknown error')
    yield { type: 'error', error: new Error(`API ${response.status}: ${text}`) }; return
  }

  // 逐行解析 SSE
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let stopReason = 'end_turn'
  const toolCallBuffers = new Map()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') continue

        const result = handleSSELine(data, toolCallBuffers)
        if (result.textDelta) yield { type: 'text_delta', delta: result.textDelta }
        if (result.stopReason) stopReason = result.stopReason
      }
    }
  } catch (e) {
    if (opts.signal && opts.signal.aborted) { yield { type: 'done', stopReason: 'aborted' }; return }
    yield { type: 'error', error: e }; return
  }

  // 发出累积的 tool_calls
  for (const tc of flushToolCalls(toolCallBuffers)) {
    yield { type: 'tool_call', id: tc.id, name: tc.name, args: tc.args }
  }
  yield { type: 'done', stopReason: opts.signal && opts.signal.aborted ? 'aborted' : stopReason }
}

// ─── 5. 消息构建辅助：从事件累积出能进 context 的 message ─────────────
// ===== message 构建辅助函数 =====

/** 从一轮 stream 的事件中累积出 assistant message（text + tool_use blocks） */
export function buildAssistantMessage(text, toolCalls) {
  const content = []
  if (text) content.push({ type: 'text', text })
  for (const tc of toolCalls) {
    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args })
  }
  return { role: 'assistant', content }
}

/** 构造 tool_result user message（OpenAI 要求结果作为 tool role 消息回传） */
export function buildToolResultMessage(results) {
  return {
    role: 'user',
    content: results.map(r => ({
      type: 'tool_result',
      tool_use_id: r.tool_use_id,
      content: r.content,
    })),
  }
}
