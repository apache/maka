import type { Asset, KnowledgeBase } from './domain/types'
import { DEFAULT_CHUNK } from './domain/chunk'

/** 截图里那份被上传的「启动命令.txt」，一字不改 */
export const SAMPLE_TEXT = [
  'cd /d D:\\workspace\\ruoyi-admin',
  'pnpm install',
  'pnpm dev:antd',
  '',
  'cd /d D:\\workspace\\ruoyi-web',
  'pnpm install',
  'pnpm dev --port 5180 --strictPort',
].join('\n')

export interface Seed {
  kb: KnowledgeBase
  asset: Asset
}

export function seed(): Seed {
  const now = Date.now()
  const kb: KnowledgeBase = {
    id: 'kb-ruoyi-ai',
    name: 'RuoYi AI 知识库',
    description: '若依 AI 管理端与前端工程的启动、联调笔记',
    // 首屏用哈希模型保证离线秒开；bge 在「知识库配置」里一键切换
    embeddingModel: 'hash-256',
    chunkSize: DEFAULT_CHUNK.size,
    chunkOverlap: DEFAULT_CHUNK.overlap,
    topK: 5,
    createdAt: now,
    updatedAt: now,
  }
  const asset: Asset = {
    id: 'asset-start-cmd',
    kbId: kb.id,
    name: '启动命令.txt',
    type: 'txt',
    size: new TextEncoder().encode(SAMPLE_TEXT).length,
    status: 'pending',
    chunkCount: 0,
    uploadedAt: now,
    content: SAMPLE_TEXT,
  }
  return { kb, asset }
}
