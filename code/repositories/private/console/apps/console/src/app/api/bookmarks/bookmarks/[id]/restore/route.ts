import { getBookmarkDb } from '@/server/bookmarks/connection'
import { restoreBookmark } from '@/server/bookmarks/db/repo-bookmarks'
import { serializeError } from '@/server/bookmarks/http'

type Ctx = { params: Promise<{ id: string }> }

/** 从回收站恢复；URL 已被其他活跃书签占用时 409 */
export async function POST(_req: Request, { params }: Ctx) {
  try {
    const bookmark = restoreBookmark(getBookmarkDb(), Number((await params).id))
    if (!bookmark) {
      return Response.json(
        { code: 'NOT_FOUND', message: '书签不存在或不在回收站中' },
        { status: 404 },
      )
    }
    return Response.json(bookmark)
  } catch (err) {
    const { statusCode, body } = serializeError(err)
    return Response.json(body, { status: statusCode })
  }
}
