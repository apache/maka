import { SseEventSchema, type ChatRequest, type SseEvent } from '@ggbdpq/console-shared/todo'

/**
 * 手写 SSE 流解析（Q14 定案：POST + ReadableStream，不用 EventSource——后者只支持 GET）。
 * 每帧经 SseEventSchema 校验：前后端共用契约，漂移在此即刻暴露。
 */
export async function* streamChat(
  body: ChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const res = await fetch('/api/todo/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    const raw = await res.json().catch(() => null)
    const message =
      raw && typeof raw === 'object' && 'message' in raw
        ? String((raw as { message: unknown }).message)
        : `请求失败（HTTP ${res.status}）`
    yield { type: 'error', code: 'HTTP_ERROR', message }
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))
      if (!dataLine) continue
      yield SseEventSchema.parse(JSON.parse(dataLine.slice(6)))
    }
  }
}
