import type { Hit } from './types'
import { normalize } from './vector'

export interface VectorRecord {
  id: string
  kbId: string
  assetId: string
  vector: Float32Array
  text: string
}

/**
 * 进程内向量索引。
 * ponytail: 暴力余弦，O(n·dim)/次查询。≤1 万分片（512 维）实测毫秒级；
 * 超过就换 HNSW 或把索引挪到服务端，接口保持不变。
 */
export class VectorIndex {
  private records: VectorRecord[] = []
  private dim: number | null = null

  /** 入库时就地归一化，保证搜索时的点积等于余弦 */
  add(records: VectorRecord[]): void {
    for (const r of records) {
      this.assertDim(r.vector.length)
      normalize(r.vector)
      this.records.push(r)
    }
  }

  removeAsset(assetId: string): void {
    this.records = this.records.filter((r) => r.assetId !== assetId)
  }

  removeKb(kbId: string): void {
    this.records = this.records.filter((r) => r.kbId !== kbId)
  }

  search(kbId: string, query: Float32Array, topK: number): Hit[] {
    if (topK <= 0) return []
    this.assertDim(query.length)
    const hits: Hit[] = []
    for (const r of this.records) {
      if (r.kbId !== kbId) continue
      let dot = 0
      for (let i = 0; i < query.length; i++) dot += r.vector[i] * query[i]
      hits.push({ chunkId: r.id, assetId: r.assetId, kbId: r.kbId, text: r.text, score: dot })
    }
    // 同分按 id 稳定排序，避免刷新后结果跳来跳去
    hits.sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
    return hits.slice(0, topK)
  }

  size(): number {
    return this.records.length
  }

  private assertDim(dim: number): void {
    if (this.dim === null) this.dim = dim
    if (this.dim !== dim) throw new RangeError(`维度不一致: 索引 ${this.dim} vs 输入 ${dim}`)
  }
}
