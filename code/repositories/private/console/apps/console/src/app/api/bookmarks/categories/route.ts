import { getBookmarkDb } from '@/server/bookmarks/connection'
import { listCategories } from '@/server/bookmarks/db/repo-bookmarks'

/** 分类过滤下拉数据：活跃书签按分类计数 */
export async function GET() {
  return Response.json({ categories: listCategories(getBookmarkDb()) })
}
