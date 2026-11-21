import { getBookmarkDb } from '@/server/bookmarks/connection'
import { listDuplicateGroups } from '@/server/bookmarks/db/repo-bookmarks'

/** 近似重复分组（忽略协议/www/查询参数/锚点），只提示不拦截 */
export async function GET() {
  return Response.json({ groups: listDuplicateGroups(getBookmarkDb()) })
}
