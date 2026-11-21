import { normalize } from './vector'

export interface Embedder {
  /** 模型标识，会显示在知识库配置与概览页 */
  readonly id: string
  readonly dim: number
  embed(texts: string[]): Promise<Float32Array[]>
}

/** FNV-1a，32 位。只用于特征哈希，不是加密。 */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * 英文/数字按词，中文按「单字 + 相邻双字」。
 * 中文不引入分词库：双字已经能区分「启动/命令/启动命令」，代价是词表噪音。
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens: string[] = []
  for (const m of lower.matchAll(/[a-z0-9_]+/g)) tokens.push(m[0])
  for (const run of lower.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (let i = 0; i < run.length; i++) {
      tokens.push(run[i])
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2))
    }
  }
  return tokens
}

export const HASH_DIM = 256

/**
 * 本地哈希嵌入：零依赖、离线可用，但**没有语义泛化**——同义词不会靠近。
 * 它是 bge 加载失败时的兜底，不是本项目的「向量模型」主角。
 */
export const hashEmbedder: Embedder = {
  id: 'hash-256',
  dim: HASH_DIM,
  async embed(texts) {
    return texts.map((text) => {
      const v = new Float32Array(HASH_DIM)
      for (const token of tokenize(text)) {
        const h = fnv1a(token)
        v[h % HASH_DIM] += (h & 0x80000000) !== 0 ? -1 : 1
      }
      return normalize(v)
    })
  },
}

/**
 * 真语义向量：bge-small-zh-v1.5（512 维，中文）。
 * 首次调用会从 HuggingFace 拉 ~24MB 模型并初始化 wasm，之后走浏览器缓存。
 */
export function createBgeEmbedder(model = 'Xenova/bge-small-zh-v1.5'): Embedder {
  let pipe: Promise<(texts: string[], opts: object) => Promise<{ tolist(): number[][] }>> | null = null

  function load() {
    pipe ??= import('@huggingface/transformers').then(({ pipeline }) =>
      pipeline('feature-extraction', model, { dtype: 'q8' }),
    ) as unknown as typeof pipe
    return pipe!
  }

  return {
    id: 'bge-small-zh-512',
    dim: 512,
    async embed(texts) {
      if (texts.length === 0) return []
      const extract = await load()
      const out = await extract(texts, { pooling: 'mean', normalize: true })
      return out.tolist().map((row) => Float32Array.from(row))
    },
  }
}
