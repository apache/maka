import { ArrowLeft, FileText } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { Badge } from '@/features/ruoyi-ai/components/ui/badge'
import { Card, CardContent } from '@/features/ruoyi-ai/components/ui/card'
import { buttonVariants } from '@/features/ruoyi-ai/components/ui/button'
import { useKnowledge } from '@/features/ruoyi-ai/stores/knowledge'

export default function Chunks() {
  const { kbId = '', assetId = '' } = useParams()
  const asset = useKnowledge((s) => s.assets.find((a) => a.id === assetId))
  const allChunks = useKnowledge((s) => s.chunks)
  const chunks = allChunks.filter((c) => c.assetId === assetId).sort((a, b) => a.index - b.index)

  return (
    <div className="space-y-4 p-5">
      <div className="flex items-center gap-3">
        <Link to={`/knowledge/${kbId}`} className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}>
          <ArrowLeft className="size-4" />
        </Link>
        <div>
          <h1 className="flex items-center gap-2 text-base font-semibold">
            <FileText className="size-4 text-muted-foreground" />
            {asset?.name ?? '附件'}
          </h1>
          <p className="text-xs text-muted-foreground">
            {chunks.length} 个分片 · 每个分片一条向量，检索命中的就是这里的原文
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {chunks.map((chunk) => (
          <Card key={chunk.id}>
            <CardContent className="space-y-2 p-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">第 {chunk.index + 1} 段</Badge>
                <span>{chunk.text.length} 字</span>
                <span className="ml-auto font-mono">{chunk.id}</span>
              </div>
              <p className="text-sm leading-6 whitespace-pre-wrap">{chunk.text}</p>
            </CardContent>
          </Card>
        ))}
        {chunks.length === 0 && (
          <Card>
            <CardContent className="p-8 text-center text-sm text-muted-foreground">
              这个附件还没有分片，回文件管理点「重新解析」
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
