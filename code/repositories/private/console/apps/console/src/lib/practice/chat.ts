import { PracticeSseEventSchema, type PracticeChatRequest, type PracticeSseEvent } from '@ggbdpq/console-shared'

/**
 * 手写 SSE 流解析（POST + ReadableStream，与 todo 域同款约定）。
 * 每帧经 PracticeSseEventSchema 校验：前后端共用契约，漂移在此即刻暴露。
 */
export async function* streamPracticeChat(
  body: PracticeChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<PracticeSseEvent> {
  const res = await fetch('/api/practice/chat', {
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
      yield PracticeSseEventSchema.parse(JSON.parse(dataLine.slice(6)))
    }
  }
}
