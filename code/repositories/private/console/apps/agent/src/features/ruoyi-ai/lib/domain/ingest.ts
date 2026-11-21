import { chunkText, DEFAULT_CHUNK, type ChunkOptions } from './chunk'
import type { Embedder } from './embed'
import type { VectorIndex } from './index'
import type { Asset, Chunk } from './types'

export interface IngestDeps {
  embedder: Embedder
  index: VectorIndex
  chunk?: ChunkOptions
}

export interface IngestResult {
  asset: Asset
  chunks: Chunk[]
}

/**
 * 解析 → 分片 → 向量 → 入库。失败不抛异常，落成 status=failed 让 UI 展示并允许重试。
 * 幂等：每次先摘掉该附件的旧向量，重解析不会叠加。
 */
export async function ingestAsset(asset: Asset, deps: IngestDeps): Promise<IngestResult> {
  deps.index.removeAsset(asset.id)

  if (!asset.content.trim()) {
    return fail(asset, '文件内容为空')
  }

  const sizes = { ...DEFAULT_CHUNK, ...deps.chunk }
  try {
    const pieces = chunkText(asset.content, sizes)
    if (pieces.length === 0) throw new Error('文件内容为空')

    const vectors = await deps.embedder.embed(pieces)
    if (vectors.length !== pieces.length) {
      throw new Error(`向量数量不匹配：分片 ${pieces.length}，向量 ${vectors.length}`)
    }

    const chunks: Chunk[] = pieces.map((text, i) => ({
      id: `${asset.id}#${i}`,
      kbId: asset.kbId,
      assetId: asset.id,
      index: i,
      text,
      vector: vectors[i],
    }))

    deps.index.add(
      chunks.map((c) => ({
        id: c.id,
        kbId: c.kbId,
        assetId: c.assetId,
        vector: c.vector,
        text: c.text,
      })),
    )

    return {
      asset: { ...asset, status: 'parsed', chunkCount: chunks.length, error: undefined },
      chunks,
    }
  } catch (error) {
    deps.index.removeAsset(asset.id)
    return fail(asset, error instanceof Error ? error.message : '解析失败')
  }
}

function fail(asset: Asset, error: string): IngestResult {
  return { asset: { ...asset, status: 'failed', chunkCount: 0, error }, chunks: [] }
}
