import { Link } from 'react-router'
import { Badge } from '@/features/ruoyi-ai/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/features/ruoyi-ai/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/features/ruoyi-ai/components/ui/table'
import { formatDate, STATUS_META } from '@/features/ruoyi-ai/lib/format'
import { MODEL_LABEL, useKnowledge } from '@/features/ruoyi-ai/stores/knowledge'

function Stat(props: { label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-normal text-muted-foreground">{props.label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold tabular-nums">{props.value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{props.hint}</p>
      </CardContent>
    </Card>
  )
}

export default function Dashboard() {
  const kbs = useKnowledge((s) => s.kbs)
  const assets = useKnowledge((s) => s.assets)
  const chunks = useKnowledge((s) => s.chunks)

  const parsed = assets.filter((a) => a.status === 'parsed').length
  const models = [...new Set(kbs.map((k) => k.embeddingModel))]
  const dims = models.map((m) => (m === 'bge-small-zh-512' ? 512 : 256)).join(' / ') || '—'
  const recent = [...assets].sort((a, b) => b.uploadedAt - a.uploadedAt).slice(0, 6)

  return (
    <div className="space-y-5 p-5">
      <div>
        <h1 className="text-lg font-semibold">概览</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          文档 → 解析 → 分片 → 向量 → 索引 → 检索 → 回答，这一条链路的观测面。
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="知识库" value={String(kbs.length)} hint="每个库独立隔离检索" />
        <Stat label="附件" value={`${parsed} / ${assets.length}`} hint="已解析 / 全部" />
        <Stat label="分片" value={String(chunks.length)} hint="向量条数与分片一致" />
        <Stat label="向量维度" value={dims} hint={models.map((m) => MODEL_LABEL[m] ?? m).join('；') || '尚无模型'} />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-sm">最近附件</CardTitle>
          <Link to="/knowledge" className="text-xs text-muted-foreground underline-offset-4 hover:underline">
            全部知识库
          </Link>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>附件名称</TableHead>
                <TableHead>知识库</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">分片数</TableHead>
                <TableHead className="text-right">上传时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.map((asset) => {
                const meta = STATUS_META[asset.status]
                const kb = kbs.find((k) => k.id === asset.kbId)
                return (
                  <TableRow key={asset.id}>
                    <TableCell>
                      <Link to={`/knowledge/${asset.kbId}`} className="hover:underline">
                        {asset.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{kb?.name ?? '—'}</TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center gap-1.5 text-xs ${meta.text}`}>
                        <span className={`size-1.5 rounded-full ${meta.dot}`} />
                        {meta.label}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{asset.chunkCount}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {formatDate(asset.uploadedAt)}
                    </TableCell>
                  </TableRow>
                )
              })}
              {recent.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                    还没有附件，去知识库上传一个 .txt 试试
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">向量模型</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <Badge variant="outline" className="mr-2">默认</Badge>
            bge-small-zh-v1.5 · 512 维：真语义，首次使用从 HuggingFace 拉取约 24MB 模型（浏览器缓存后续秒开）。
          </p>
          <p>
            <Badge variant="outline" className="mr-2">兜底</Badge>
            本地哈希 · 256 维：零依赖离线可用，但没有同义词泛化，只适合验证链路。
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
