import { create } from 'zustand'
import { getState, setState } from '@/features/ruoyi-ai/lib/db'
import { createBgeEmbedder, hashEmbedder, type Embedder } from '@/features/ruoyi-ai/lib/domain/embed'
import { VectorIndex } from '@/features/ruoyi-ai/lib/domain/index'
import { ingestAsset } from '@/features/ruoyi-ai/lib/domain/ingest'
import { DEFAULT_CHUNK } from '@/features/ruoyi-ai/lib/domain/chunk'
import type { Asset, Chunk, KnowledgeBase } from '@/features/ruoyi-ai/lib/domain/types'
import { uid } from '@/features/ruoyi-ai/lib/format'
import { seed } from '@/features/ruoyi-ai/lib/samples'

export const MODEL_LABEL: Record<string, string> = {
  'hash-256': '本地哈希 · 256 维（离线兜底）',
  'bge-small-zh-512': 'bge-small-zh-v1.5 · 512 维（真语义）',
}

const index = new VectorIndex()
const embedders = new Map<string, Embedder>()

export function getIndex(): VectorIndex {
  return index
}

export function embedderFor(id: string): Embedder {
  if (id !== 'bge-small-zh-512') return hashEmbedder
  let e = embedders.get(id)
  if (!e) {
    e = createBgeEmbedder()
    embedders.set(id, e)
  }
  return e
}

interface Persisted {
  kbs: KnowledgeBase[]
  assets: Asset[]
  chunks: Chunk[]
}

interface KnowledgeState extends Persisted {
  ready: boolean
  /** 正在解析的附件 id，或 `${kbId}:all` 表示整库重解析 */
  busy: string | null
  init: () => Promise<void>
  createKb: (input: { name: string; description: string }) => Promise<string>
  removeKb: (id: string) => Promise<void>
  addFile: (kbId: string, file: File) => Promise<void>
  reparse: (assetId: string) => Promise<void>
  reparseAll: (kbId: string) => Promise<void>
  removeAsset: (assetId: string) => Promise<void>
  updateKb: (id: string, patch: Partial<KnowledgeBase>) => Promise<void>
}

// StrictMode 会把 effect 跑两遍：同一次初始化只能有一份 Promise，否则会种两份种子数据
let initPromise: Promise<void> | null = null

function persist() {
  const { kbs, assets, chunks } = useKnowledge.getState()
  return setState('knowledge', { kbs, assets, chunks } satisfies Persisted)
}

export const useKnowledge = create<KnowledgeState>()((set, get) => ({
  kbs: [],
  assets: [],
  chunks: [],
  ready: false,
  busy: null,

  init: () => (initPromise ??= (async () => {
    if (get().ready) return
    const saved = await getState<Persisted>('knowledge')
    let state: Persisted
    if (saved) {
      state = saved
    } else {
      const { kb, asset } = seed()
      state = { kbs: [kb], assets: [asset], chunks: [] }
    }

    index.add(
      state.chunks.map((c) => ({
        id: c.id,
        kbId: c.kbId,
        assetId: c.assetId,
        vector: c.vector,
        text: c.text,
      })),
    )
    set({ ...state, ready: true })

    // 上次没解析完的（pending / 中断的 parsing）补一次
    for (const asset of state.assets.filter((a) => a.status !== 'parsed')) {
      await get().reparse(asset.id)
    }
  })()),

  createKb: async ({ name, description }) => {
    const now = Date.now()
    const kb: KnowledgeBase = {
      id: uid('kb'),
      name: name.trim() || '未命名知识库',
      description: description.trim(),
      embeddingModel: 'bge-small-zh-512',
      chunkSize: DEFAULT_CHUNK.size,
      chunkOverlap: DEFAULT_CHUNK.overlap,
      topK: 5,
      createdAt: now,
      updatedAt: now,
    }
    set({ kbs: [...get().kbs, kb] })
    await persist()
    return kb.id
  },

  removeKb: async (id) => {
    const assetIds = new Set(get().assets.filter((a) => a.kbId === id).map((a) => a.id))
    index.removeKb(id)
    set({
      kbs: get().kbs.filter((k) => k.id !== id),
      assets: get().assets.filter((a) => a.kbId !== id),
      chunks: get().chunks.filter((c) => !assetIds.has(c.assetId)),
    })
    await persist()
  },

  addFile: async (kbId, file) => {
    const content = await file.text()
    const asset: Asset = {
      id: uid('asset'),
      kbId,
      name: file.name,
      type: file.name.split('.').pop()?.toLowerCase() ?? 'txt',
      size: file.size,
      status: 'pending',
      chunkCount: 0,
      uploadedAt: Date.now(),
      content,
    }
    set({ assets: [...get().assets, asset] })
    await get().reparse(asset.id)
  },

  reparse: async (assetId) => {
    const asset = get().assets.find((a) => a.id === assetId)
    const kb = asset && get().kbs.find((k) => k.id === asset.kbId)
    if (!asset || !kb) return

    set({
      busy: assetId,
      assets: get().assets.map((a) => (a.id === assetId ? { ...a, status: 'parsing' } : a)),
    })

    const { asset: done, chunks } = await ingestAsset(
      { ...asset, status: 'parsing' },
      {
        embedder: embedderFor(kb.embeddingModel),
        index,
        chunk: { size: kb.chunkSize, overlap: kb.chunkOverlap },
      },
    )

    set({
      busy: null,
      assets: get().assets.map((a) => (a.id === assetId ? done : a)),
      chunks: [...get().chunks.filter((c) => c.assetId !== assetId), ...chunks],
    })
    await persist()
  },

  reparseAll: async (kbId) => {
    const ids = get().assets.filter((a) => a.kbId === kbId).map((a) => a.id)
    set({ busy: `${kbId}:all` })
    for (const id of ids) await get().reparse(id)
    set({ busy: null })
  },

  removeAsset: async (assetId) => {
    index.removeAsset(assetId)
    set({
      assets: get().assets.filter((a) => a.id !== assetId),
      chunks: get().chunks.filter((c) => c.assetId !== assetId),
    })
    await persist()
  },

  updateKb: async (id, patch) => {
    const before = get().kbs.find((k) => k.id === id)
    if (!before) return
    const next: KnowledgeBase = { ...before, ...patch, updatedAt: Date.now() }
    set({ kbs: get().kbs.map((k) => (k.id === id ? next : k)) })

    const rebuild =
      before.embeddingModel !== next.embeddingModel ||
      before.chunkSize !== next.chunkSize ||
      before.chunkOverlap !== next.chunkOverlap

    if (rebuild) {
      // 换模型/改切分 = 旧向量全部作废，清空后重建
      const assetIds = new Set(get().assets.filter((a) => a.kbId === id).map((a) => a.id))
      index.removeKb(id)
      set({
        chunks: get().chunks.filter((c) => !assetIds.has(c.assetId)),
        assets: get().assets.map((a) =>
          assetIds.has(a.id) ? { ...a, status: 'pending', chunkCount: 0 } : a,
        ),
      })
      await get().reparseAll(id)
    }
    await persist()
  },
}))
