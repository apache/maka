import { describe, expect, it } from 'vitest'
import { VectorIndex } from './index'
import { normalize } from './vector'

function vec(...xs: number[]) {
  return normalize(Float32Array.from(xs))
}

function rec(id: string, kbId: string, assetId: string, vector: Float32Array) {
  return { id, kbId, assetId, vector, text: `text-${id}` }
}

describe('VectorIndex', () => {
  it('按余弦相似度降序返回 topK', () => {
    const index = new VectorIndex()
    index.add([
      rec('a', 'kb1', 'f1', vec(1, 0)),
      rec('b', 'kb1', 'f1', vec(0.8, 0.6)),
      rec('c', 'kb1', 'f1', vec(0, 1)),
    ])
    const hits = index.search('kb1', vec(1, 0), 2)
    expect(hits.map((h) => h.chunkId)).toEqual(['a', 'b'])
    expect(hits[0].score).toBeCloseTo(1, 6)
    expect(hits[0].text).toBe('text-a')
  })

  it('按 kbId 隔离，跨库检索不到', () => {
    const index = new VectorIndex()
    index.add([rec('a', 'kb1', 'f1', vec(1, 0)), rec('b', 'kb2', 'f2', vec(1, 0))])
    expect(index.search('kb1', vec(1, 0), 5).map((h) => h.chunkId)).toEqual(['a'])
    expect(index.search('kb2', vec(1, 0), 5).map((h) => h.chunkId)).toEqual(['b'])
  })

  it('topK 超过记录数时返回全部，topK<=0 返回空', () => {
    const index = new VectorIndex()
    index.add([rec('a', 'kb1', 'f1', vec(1, 0)), rec('b', 'kb1', 'f1', vec(0, 1))])
    expect(index.search('kb1', vec(1, 0), 99)).toHaveLength(2)
    expect(index.search('kb1', vec(1, 0), 0)).toEqual([])
    expect(index.search('kb1', vec(1, 0), -1)).toEqual([])
  })

  it('removeAsset 之后不再命中，其余记录保留', () => {
    const index = new VectorIndex()
    index.add([rec('a', 'kb1', 'f1', vec(1, 0)), rec('b', 'kb1', 'f2', vec(1, 0))])
    index.removeAsset('f1')
    expect(index.size()).toBe(1)
    expect(index.search('kb1', vec(1, 0), 5).map((h) => h.chunkId)).toEqual(['b'])
  })

  it('维度不一致直接报错，不静默算错分', () => {
    const index = new VectorIndex()
    index.add([rec('a', 'kb1', 'f1', vec(1, 0))])
    expect(() => index.add([rec('b', 'kb1', 'f1', vec(1, 0, 0))])).toThrow(RangeError)
    expect(() => index.search('kb1', vec(1, 0, 0), 1)).toThrow(RangeError)
  })
})
