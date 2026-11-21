import { describe, expect, it } from 'vitest'
import { hashEmbedder } from './embed'
import { VectorIndex } from './index'
import { retrieve } from './retrieve'

describe('retrieve', () => {
  it('空白问题不触发检索', async () => {
    const index = new VectorIndex()
    expect(await retrieve('   ', { kbId: 'kb1', embedder: hashEmbedder, index })).toEqual([])
  })

  it('返回按分数排序的命中，并带上分片正文', async () => {
    const index = new VectorIndex()
    const embedder = hashEmbedder
    const texts = [
      'cd /d D:\\workspace\\ruoyi-admin pnpm install',
      '今天天气不错，适合散步',
    ]
    const vs = await embedder.embed(texts)
    index.add(
      texts.map((text, i) => ({ id: `c${i}`, kbId: 'kb1', assetId: 'f1', vector: vs[i], text })),
    )

    const hits = await retrieve('怎么安装依赖', { kbId: 'kb1', topK: 2, embedder, index })
    expect(hits).toHaveLength(2)
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score)
    expect(hits[0].text).toContain('pnpm')
  })

  it('topK 夹在 1..20，越界不报错', async () => {
    const index = new VectorIndex()
    const [v] = await hashEmbedder.embed(['任意文本'])
    index.add([{ id: 'c1', kbId: 'kb1', assetId: 'f1', vector: v, text: '任意文本' }])
    expect(await retrieve('任意', { kbId: 'kb1', topK: 0, embedder: hashEmbedder, index })).toHaveLength(1)
    expect(await retrieve('任意', { kbId: 'kb1', topK: 999, embedder: hashEmbedder, index })).toHaveLength(1)
  })
})
