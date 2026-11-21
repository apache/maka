import { ArrowLeft, FileText, Loader2, RefreshCw, Search, Trash2, Upload } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { Badge } from '@/features/ruoyi-ai/components/ui/badge'
import { Button, buttonVariants } from '@/features/ruoyi-ai/components/ui/button'
import { Card, CardContent } from '@/features/ruoyi-ai/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/features/ruoyi-ai/components/ui/dialog'
import { Input } from '@/features/ruoyi-ai/components/ui/input'
import { Label } from '@/features/ruoyi-ai/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/features/ruoyi-ai/components/ui/table'
import { retrieve } from '@/features/ruoyi-ai/lib/domain/retrieve'
import type { Asset, Hit } from '@/features/ruoyi-ai/lib/domain/types'
import { formatBytes, formatDate, STATUS_META } from '@/features/ruoyi-ai/lib/format'
import { MODEL_LABEL, embedderFor, getIndex, useKnowledge } from '@/features/ruoyi-ai/stores/knowledge'

type Tab = 'files' | 'search' | 'config'

const TABS: { id: Tab; label: string }[] = [
  { id: 'files', label: '文件管理' },
  { id: 'search', label: '检索测试' },
  { id: 'config', label: '知识库配置' },
]

export default function KnowledgeDetail() {
  const { kbId = '' } = useParams()
  const kb = useKnowledge((s) => s.kbs.find((k) => k.id === kbId))
  // zustand v5：selector 必须返回稳定引用，过滤放渲染里（列表很小，不值得上 useShallow）
  const allAssets = useKnowledge((s) => s.assets)
  const allChunks = useKnowledge((s) => s.chunks)
  const assets = allAssets.filter((a) => a.kbId === kbId)
  const chunks = allChunks.filter((c) => c.kbId === kbId)
  const busy = useKnowledge((s) => s.busy)
  const addFile = useKnowledge((s) => s.addFile)
  const reparse = useKnowledge((s) => s.reparse)
  const reparseAll = useKnowledge((s) => s.reparseAll)
  const removeAsset = useKnowledge((s) => s.removeAsset)
  const updateKb = useKnowledge((s) => s.updateKb)

  const [tab, setTab] = useState<Tab>('files')
  const [source, setSource] = useState<Asset | null>(null)

  if (!kb) {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        知识库不存在，
        <Link to="/knowledge" className="underline underline-offset-4">
          返回列表
        </Link>
      </div>
    )
  }

  const parsingAll = busy === `${kb.id}:all`

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b px-5 py-3">
        <Link to="/knowledge" className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}>
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">{kb.name}</h1>
          <p className="truncate text-xs text-muted-foreground">{kb.description || '暂无描述'}</p>
        </div>
        <Badge variant="outline" className="ml-auto shrink-0">
          {MODEL_LABEL[kb.embeddingModel] ?? kb.embeddingModel}
        </Badge>
      </div>

      <div className="flex items-center gap-1 border-b px-5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={
              'border-b-2 px-3 py-2.5 text-sm transition-colors ' +
              (tab === t.id
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground')
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {tab === 'files' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <label className={buttonVariants({ size: 'default', className: 'cursor-pointer' })}>
                <Upload className="size-4" />
                上传文档
                <input
                  type="file"
                  accept=".txt,.md,.json,.csv"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    e.target.value = ''
                    if (file) void addFile(kb.id, file)
                  }}
                />
              </label>
              <Button variant="secondary" disabled={parsingAll} onClick={() => void reparseAll(kb.id)}>
                <RefreshCw className={'size-4 ' + (parsingAll ? 'animate-spin' : '')} />
                全部重新解析
              </Button>
              <span className="ml-auto text-xs text-muted-foreground">
                共 {assets.length} 个附件 · {chunks.length} 个分片
              </span>
            </div>

            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>附件名称</TableHead>
                      <TableHead>附件类型</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className="text-right">分片数</TableHead>
                      <TableHead>上传时间</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {assets.map((asset) => {
                      const meta = STATUS_META[asset.status]
                      const isBusy = busy === asset.id
                      return (
                        <TableRow key={asset.id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <FileText className="size-4 text-muted-foreground" />
                              <span className="truncate">{asset.name}</span>
                            </div>
                            <p className="mt-0.5 pl-6 text-xs text-muted-foreground">
                              {formatBytes(asset.size)}
                              {asset.error ? ` · ${asset.error}` : ''}
                            </p>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">.{asset.type}</TableCell>
                          <TableCell>
                            <span className={`inline-flex items-center gap-1.5 text-xs ${meta.text}`}>
                              {isBusy ? (
                                <Loader2 className="size-3 animate-spin" />
                              ) : (
                                <span className={`size-1.5 rounded-full ${meta.dot}`} />
                              )}
                              {isBusy ? '解析中' : meta.label}
                            </span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{asset.chunkCount}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{formatDate(asset.uploadedAt)}</TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={isBusy}
                                onClick={() => void reparse(asset.id)}
                              >
                                <RefreshCw className="size-3.5" />
                                重新解析
                              </Button>
                              <Link
                                to={`/knowledge/${kb.id}/chunks/${asset.id}`}
                                className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                              >
                                知识片段
                              </Link>
                              <Button variant="ghost" size="sm" onClick={() => setSource(asset)}>
                                查看源文件
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive"
                                onClick={() => {
                                  if (confirm(`删除「${asset.name}」及其分片？`)) void removeAsset(asset.id)
                                }}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                    {assets.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="py-12 text-center text-sm text-muted-foreground">
                          还没有附件，上传一个 .txt 开始
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        )}

        {tab === 'search' && <SearchTab kbId={kb.id} topK={kb.topK} embedderId={kb.embeddingModel} />}
        {tab === 'config' && (
          <ConfigTab
            chunkSize={kb.chunkSize}
            chunkOverlap={kb.chunkOverlap}
            topK={kb.topK}
            embeddingModel={kb.embeddingModel}
            saving={parsingAll}
            onSave={(patch) => updateKb(kb.id, patch)}
          />
        )}
      </div>

      <Dialog open={source !== null} onOpenChange={(open) => !open && setSource(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{source?.name}</DialogTitle>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-6 whitespace-pre-wrap">
            {source?.content}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function SearchTab(props: { kbId: string; topK: number; embedderId: string }) {
  const [query, setQuery] = useState('怎么启动 ruoyi-admin')
  const [topK, setTopK] = useState(props.topK)
  const [ablate, setAblate] = useState(false)
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [ms, setMs] = useState(0)
  const [running, setRunning] = useState(false)
  const assets = useKnowledge((s) => s.assets)

  async function run() {
    if (!query.trim() || running) return
    setRunning(true)
    const t0 = performance.now()
    try {
      const found = ablate
        ? []
        : await retrieve(query, {
            kbId: props.kbId,
            topK,
            embedder: embedderFor(props.embedderId),
            index: getIndex(),
          })
      setHits(found)
      setMs(performance.now() - t0)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4">
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            rows={2}
            className="w-full resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring"
            placeholder="输入一句自然语言问题"
          />
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Label htmlFor="topk" className="text-xs">
                TopK
              </Label>
              <Input
                id="topk"
                type="number"
                min={1}
                max={20}
                value={topK}
                onChange={(e) => setTopK(Number(e.target.value))}
                className="h-8 w-20"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={ablate} onChange={(e) => setAblate(e.target.checked)} />
              关闭检索（消融对照）
            </label>
            <Button className="ml-auto" disabled={running} onClick={() => void run()}>
              <Search className="size-4" />
              {running ? '检索中…' : '检索'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {hits !== null && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {ablate ? '检索已关闭：' : `命中 ${hits.length} 条 · 耗时 ${ms.toFixed(1)}ms`}
            {ablate && '下面应该一条都没有——这就是关掉向量检索后的退化样子。'}
          </p>
          {hits.map((hit, i) => (
            <Card key={hit.chunkId}>
              <CardContent className="space-y-2 p-4">
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="font-mono">#{i + 1}</span>
                  <span>{assets.find((a) => a.id === hit.assetId)?.name ?? hit.assetId}</span>
                  <span className="ml-auto tabular-nums">相似度 {hit.score.toFixed(3)}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-emerald-500"
                    style={{ width: `${Math.max(2, Math.min(100, hit.score * 100))}%` }}
                  />
                </div>
                <p className="text-sm whitespace-pre-wrap">{hit.text}</p>
              </CardContent>
            </Card>
          ))}
          {hits.length === 0 && (
            <Card>
              <CardContent className="p-6 text-center text-sm text-muted-foreground">
                未检索到相关内容
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}

function ConfigTab(props: {
  chunkSize: number
  chunkOverlap: number
  topK: number
  embeddingModel: string
  saving: boolean
  onSave: (patch: { chunkSize: number; chunkOverlap: number; topK: number; embeddingModel: string }) => Promise<void>
}) {
  const [size, setSize] = useState(props.chunkSize)
  const [overlap, setOverlap] = useState(props.chunkOverlap)
  const [topK, setTopK] = useState(props.topK)
  const [model, setModel] = useState(props.embeddingModel)

  const dirty = size !== props.chunkSize || overlap !== props.chunkOverlap || topK !== props.topK || model !== props.embeddingModel
  const modelChanged = model !== props.embeddingModel

  return (
    <Card className="max-w-xl">
      <CardContent className="space-y-4 p-4">
        <div className="space-y-1.5">
          <Label htmlFor="model">向量模型</Label>
          <select
            id="model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none"
          >
            <option value="bge-small-zh-512">bge-small-zh-v1.5 · 512 维（真语义）</option>
            <option value="hash-256">本地哈希 · 256 维（离线兜底）</option>
          </select>
          <p className="text-xs text-muted-foreground">
            {modelChanged
              ? '切换模型会清空现有分片与向量，并按新模型重新解析全部附件。'
              : '首次使用 bge 会下载约 24MB 模型，之后走浏览器缓存。'}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="size">分片大小</Label>
            <Input id="size" type="number" min={32} value={size} onChange={(e) => setSize(Number(e.target.value))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="overlap">重叠</Label>
            <Input
              id="overlap"
              type="number"
              min={0}
              value={overlap}
              onChange={(e) => setOverlap(Number(e.target.value))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="topk-cfg">默认 TopK</Label>
            <Input id="topk-cfg" type="number" min={1} max={20} value={topK} onChange={(e) => setTopK(Number(e.target.value))} />
          </div>
        </div>

        <Button
          disabled={!dirty || props.saving || overlap >= size}
          onClick={() => void props.onSave({ chunkSize: size, chunkOverlap: overlap, topK, embeddingModel: model })}
        >
          {props.saving ? '重建索引中…' : '保存并重建'}
        </Button>
        {overlap >= size && <p className="text-xs text-destructive">重叠必须小于分片大小</p>}
      </CardContent>
    </Card>
  )
}
