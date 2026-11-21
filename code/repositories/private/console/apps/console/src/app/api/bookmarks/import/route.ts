import { ImportRequestSchema } from '@ggbdpq/console-shared/bookmarks'
import { getBookmarkDb } from '@/server/bookmarks/connection'
import { previewImport, runImport } from '@/server/bookmarks/import-service'
import { parseBody, serializeError } from '@/server/bookmarks/http'

/** 两段式导入：confirm=false 返回预览摘要（不落库），confirm=true 事务内批量插入 */
export async function POST(req: Request) {
  try {
    const { html, confirm } = parseBody(ImportRequestSchema, await req.json())
    const db = getBookmarkDb()
    return Response.json(confirm ? runImport(db, html) : previewImport(db, html))
  } catch (err) {
    const { statusCode, body } = serializeError(err)
    return Response.json(body, { status: statusCode })
  }
}
