import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Button } from '@/features/ruoyi-ai/components/ui/button'
import { Card, CardContent } from '@/features/ruoyi-ai/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/features/ruoyi-ai/components/ui/dialog'
import { Input } from '@/features/ruoyi-ai/components/ui/input'
import { Label } from '@/features/ruoyi-ai/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/features/ruoyi-ai/components/ui/table'
import { formatDate } from '@/features/ruoyi-ai/lib/format'
import { MODEL_LABEL, useKnowledge } from '@/features/ruoyi-ai/stores/knowledge'

export default function KnowledgeList() {
  const kbs = useKnowledge((s) => s.kbs)
  const assets = useKnowledge((s) => s.assets)
  const chunks = useKnowledge((s) => s.chunks)
  const createKb = useKnowledge((s) => s.createKb)
  const removeKb = useKnowledge((s) => s.removeKb)
  const navigate = useNavigate()

  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  async function submit() {
    const id = await createKb({ name, description })
    setOpen(false)
    setName('')
    setDescription('')
    navigate(`/knowledge/${id}`)
  }

  return (
    <div className="space-y-5 p-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-lg font-semibold">知识管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            每个知识库一套独立的分片与向量，检索不会串库。
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="size-4" />
          新建知识库
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>知识库</TableHead>
                <TableHead>向量模型</TableHead>
                <TableHead className="text-right">附件</TableHead>
                <TableHead className="text-right">分片</TableHead>
                <TableHead className="text-right">更新时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {kbs.map((kb) => {
                const kbAssets = assets.filter((a) => a.kbId === kb.id)
                const kbChunks = chunks.filter((c) => c.kbId === kb.id)
                return (
                  <TableRow key={kb.id}>
                    <TableCell>
                      <Link to={`/knowledge/${kb.id}`} className="font-medium hover:underline">
                        {kb.name}
                      </Link>
                      {kb.description && (
                        <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{kb.description}</p>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {MODEL_LABEL[kb.embeddingModel] ?? kb.embeddingModel}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{kbAssets.length}</TableCell>
                    <TableCell className="text-right tabular-nums">{kbChunks.length}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {formatDate(kb.updatedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => {
                          if (confirm(`删除知识库「${kb.name}」？附件与向量会一起清掉。`)) void removeKb(kb.id)
                        }}
                      >
                        <Trash2 className="size-3.5" />
                        删除
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
              {kbs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-12 text-center text-sm text-muted-foreground">
                    还没有知识库
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建知识库</DialogTitle>
            <DialogDescription>默认使用 bge-small-zh-v1.5（512 维），之后可在配置里切换。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="kb-name">名称</Label>
              <Input id="kb-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：若依部署手册" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kb-desc">描述</Label>
              <Input
                id="kb-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="这个库收什么文档"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void submit()} disabled={!name.trim()}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
