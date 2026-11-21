import { describe, expect, it } from 'vitest'
import { hashEmbedder } from './embed'
import { ingestAsset } from './ingest'
import { VectorIndex } from './index'
import type { Asset } from './types'

function asset(content: string, id = 'asset-1'): Asset {
  return {
    id,
    kbId: 'kb-1',
    name: '启动命令.txt',
    type: 'txt',
    size: content.length,
    status: 'pending',
    chunkCount: 0,
    uploadedAt: 0,
    content,
  }
}

function deps() {
  return { embedder: hashEmbedder, index: new VectorIndex() }
}

const SAMPLE = 'cd /d D:\\workspace\\ruoyi-admin\npnpm install\npnpm dev:antd\n'

describe('ingestAsset', () => {
  it('解析成功：状态转 parsed，分片入库', async () => {
    const d = deps()
    const { asset: done, chunks } = await ingestAsset(asset(SAMPLE), d)
    expect(done.status).toBe('parsed')
    expect(done.chunkCount).toBe(chunks.length)
    expect(chunks.map((c) => c.id)).toEqual(chunks.map((_, i) => `asset-1#${i}`))
    expect(chunks[0].vector.length).toBe(hashEmbedder.dim)
    expect(d.index.size()).toBe(chunks.length)
  })

  it('空内容判失败，不写索引', async () => {
    const d = deps()
    const { asset: done, chunks } = await ingestAsset(asset('   \n '), d)
    expect(done.status).toBe('failed')
    expect(done.error).toContain('内容为空')
    expect(chunks).toEqual([])
    expect(d.index.size()).toBe(0)
  })

  it('重复解析幂等，不产生重复向量', async () => {
    const d = deps()
    const first = await ingestAsset(asset(SAMPLE), d)
    const second = await ingestAsset(asset(SAMPLE), d)
    expect(second.asset.status).toBe('parsed')
    expect(second.chunks).toHaveLength(first.chunks.length)
    expect(d.index.size()).toBe(first.chunks.length)
  })

  it('向量模型抛错时转 failed 并清掉半成品', async () => {
    const d = deps()
    const broken = {
      id: 'boom',
      dim: 8,
      embed: async () => {
        throw new Error('模型加载失败')
      },
    }
    const { asset: done } = await ingestAsset(asset(SAMPLE), { ...d, embedder: broken })
    expect(done.status).toBe('failed')
    expect(done.error).toBe('模型加载失败')
    expect(done.chunkCount).toBe(0)
    expect(d.index.size()).toBe(0)
  })

  it('重新解析会覆盖旧分片内容', async () => {
    const d = deps()
    await ingestAsset(asset('旧的启动命令'), d)
    const { chunks } = await ingestAsset(asset('新的启动命令\n第二行'), d)
    expect(d.index.size()).toBe(chunks.length)
    expect(d.index.search('kb-1', await hashEmbedder.embed(['新的启动命令']).then((v) => v[0]), 1)[0].text).toContain('新的')
  })
})
