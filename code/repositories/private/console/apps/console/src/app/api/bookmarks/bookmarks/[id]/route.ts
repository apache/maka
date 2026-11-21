import { UpdateBookmarkInputSchema } from '@ggbdpq/console-shared/bookmarks'
import { getBookmarkDb } from '@/server/bookmarks/connection'
import {
  getBookmark,
  purgeBookmark,
  softDeleteBookmark,
  updateBookmark,
} from '@/server/bookmarks/db/repo-bookmarks'
import { parseBody, serializeError } from '@/server/bookmarks/http'

type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const id = Number((await params).id)
    const patch = parseBody(UpdateBookmarkInputSchema, await req.json())
    const bookmark = updateBookmark(getBookmarkDb(), id, patch)
    if (!bookmark) {
      return Response.json({ code: 'NOT_FOUND', message: `书签 ${id} 不存在` }, { status: 404 })
    }
    return Response.json(bookmark)
  } catch (err) {
    const { statusCode, body } = serializeError(err)
    return Response.json(body, { status: statusCode })
  }
}

/** DELETE 软删进回收站；?purge=true 彻底删除（仅限已在回收站的行） */
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const id = Number((await params).id)
    if (new URL(req.url).searchParams.get('purge') === 'true') {
      const current = getBookmark(getBookmarkDb(), id)
      if (!current) {
        return Response.json({ code: 'NOT_FOUND', message: `书签 ${id} 不存在` }, { status: 404 })
      }
      if (current.deletedAt === null) {
        return Response.json({ code: 'CONFLICT', message: '先移入回收站再彻底删除' }, { status: 409 })
      }
      purgeBookmark(getBookmarkDb(), id)
    } else if (!softDeleteBookmark(getBookmarkDb(), id)) {
      return Response.json({ code: 'NOT_FOUND', message: `书签 ${id} 不存在` }, { status: 404 })
    }
    return new Response(null, { status: 204 })
  } catch (err) {
    const { statusCode, body } = serializeError(err)
    return Response.json(body, { status: statusCode })
  }
}
