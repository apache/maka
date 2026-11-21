import type { Embedder } from './embed'
import type { VectorIndex } from './index'
import type { Hit } from './types'

export interface RetrieveOptions {
  kbId: string
  topK?: number
  embedder: Embedder
  index: VectorIndex
}

export const DEFAULT_TOP_K = 5
export const MAX_TOP_K = 20

export async function retrieve(question: string, opts: RetrieveOptions): Promise<Hit[]> {
  const q = question.trim()
  if (!q) return []
  const k = Math.min(MAX_TOP_K, Math.max(1, Math.trunc(opts.topK ?? DEFAULT_TOP_K)))
  const [vector] = await opts.embedder.embed([q])
  return opts.index.search(opts.kbId, vector, k)
}
