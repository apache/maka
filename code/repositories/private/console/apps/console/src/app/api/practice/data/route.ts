import type { PracticeData } from '@ggbdpq/console-shared'
import { loadPracticeData } from '@/server/practice/data'

export const dynamic = 'force-dynamic'

/** GET /api/practice/data：提交 + 统计 + 同步元信息全量载荷 */
export async function GET() {
  try {
    const data: PracticeData = loadPracticeData()
    return Response.json(data)
  } catch (err) {
    return Response.json(
      { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : '读取失败' },
      { status: 500 },
    )
  }
}
