import { handlePracticeChat } from '@/server/practice/agent'

export const maxDuration = 300

/** POST /api/practice/chat：实践复盘对话（SSE 流式） */
export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ code: 'VALIDATION_ERROR', message: '请求体不能为空' }, { status: 400 })
  }
  return handlePracticeChat(body, req.signal)
}
