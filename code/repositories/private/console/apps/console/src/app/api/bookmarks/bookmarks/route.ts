import { CreateBookmarkInputSchema } from '@ggbdpq/console-shared/bookmarks'
import { getBookmarkDb } from '@/server/bookmarks/connection'
import { createBookmark, listBookmarks } from '@/server/bookmarks/db/repo-bookmarks'
import { parseBody, serializeError } from '@/server/bookmarks/http'

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** 服务端过滤 + 分页：q 关键词 / category 精确 / view=trash 回收站；5693+ 条量级不全量渲染 */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams
  const params = {
    q: sp.get('q')?.trim() || undefined,
    category: sp.get('category') || undefined,
    view: sp.get('view') === 'trash' ? ('trash' as const) : ('active' as const),
    limit: clampInt(sp.get('limit'), 200, 1, 500),
    offset: Math.max(0, clampInt(sp.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)),
  }
  const result = listBookmarks(getBookmarkDb(), params)
  return Response.json({ ...result, limit: params.limit, offset: params.offset })
}

export async function POST(req: Request) {
  try {
    const input = parseBody(CreateBookmarkInputSchema, await req.json())
    const bookmark = createBookmark(getBookmarkDb(), input)
    return Response.json(bookmark, { status: 201 })
  } catch (err) {
    const { statusCode, body } = serializeError(err)
    return Response.json(body, { status: statusCode })
  }
}
