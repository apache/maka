import { PracticeSyncRequestSchema, type PracticeSyncResponse } from '@ggbdpq/console-shared'
import { syncPractice } from '@/server/practice/sync'

export const maxDuration = 300

/** POST /api/practice/sync：全量同步配置仓库的窗口内提交（约 1-2 分钟，取决于分支数） */
export async function POST(req: Request) {
  let body: unknown = {}
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const parsed = PracticeSyncRequestSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ code: 'VALIDATION_ERROR', message: '窗口日期格式应为 YYYY-MM-DD' }, { status: 400 })
  }

  try {
    const startedAt = Date.now()
    const result = await syncPractice(parsed.data)
    const payload: PracticeSyncResponse = {
      ok: result.perRepo.every((r) => r.error === null),
      commits: result.commits.length,
      durationMs: Date.now() - startedAt,
      perRepo: result.perRepo,
    }
    return Response.json(payload)
  } catch (err) {
    return Response.json(
      { code: 'SYNC_ERROR', message: err instanceof Error ? err.message : '同步失败' },
      { status: 500 },
    )
  }
}
