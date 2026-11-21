import { BatchRequestSchema } from '@ggbdpq/console-shared/bookmarks'
import { getBookmarkDb } from '@/server/bookmarks/connection'
import {
  batchPurge,
  batchRecategorize,
  batchRestore,
  batchSoftDelete,
} from '@/server/bookmarks/db/repo-bookmarks'
import { parseBody, serializeError } from '@/server/bookmarks/http'

/** 批量操作：delete/restore/purge/recategorize（事务内逐条执行） */
export async function POST(req: Request) {
  try {
    const { action, ids, category } = parseBody(BatchRequestSchema, await req.json())
    const db = getBookmarkDb()
    const affected =
      action === 'delete'
        ? batchSoftDelete(db, ids)
        : action === 'restore'
          ? batchRestore(db, ids)
          : action === 'purge'
            ? batchPurge(db, ids)
            : batchRecategorize(db, ids, category ?? '')
    return Response.json({ affected })
  } catch (err) {
    const { statusCode, body } = serializeError(err)
    return Response.json(body, { status: statusCode })
  }
}
