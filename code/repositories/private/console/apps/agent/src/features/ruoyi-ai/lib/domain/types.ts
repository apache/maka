// 领域契约。所有页面、store、持久层都只认这里的类型，不在组件里另起字段名。

export type ParseStatus = 'pending' | 'parsing' | 'parsed' | 'failed'

export interface KnowledgeBase {
  id: string
  name: string
  description: string
  /** 该库默认使用的向量模型 id，见 Embedder.id */
  embeddingModel: string
  chunkSize: number
  chunkOverlap: number
  topK: number
  createdAt: number
  updatedAt: number
}

export interface Asset {
  id: string
  kbId: string
  name: string
  /** 扩展名，不带点；截图里显示为 .txt */
  type: string
  size: number
  status: ParseStatus
  chunkCount: number
  uploadedAt: number
  error?: string
  /** 原始文本。截图里的「查看源文件」直接读它。 */
  content: string
}

export interface Chunk {
  id: string
  kbId: string
  assetId: string
  /** 分片在该附件内的序号，从 0 开始 */
  index: number
  text: string
  vector: Float32Array
}

export interface Hit {
  chunkId: string
  assetId: string
  kbId: string
  text: string
  /** 余弦相似度，方向向量已归一化时等于点积 */
  score: number
}

export interface Answer {
  text: string
  citations: Hit[]
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  text: string
  citations?: Hit[]
  at: number
}

export interface Session {
  id: string
  title: string
  kbId: string | null
  messages: Message[]
  updatedAt: number
}
