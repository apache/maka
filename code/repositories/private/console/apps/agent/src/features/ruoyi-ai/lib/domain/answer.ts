import type { Answer, Hit } from './types'

export interface AnswerOptions {
  /** assetId → 文件名，用来生成「《启动命令.txt》第 1 段」 */
  names?: Record<string, string>
  maxCitations?: number
}

const SNIPPET = 160

/**
 * 本地检索回答：没有 LLM 也能演示 RAG 的「接地」效果——答案只由命中片段拼出，
 * 没有命中就明说没有，而不是让模型自由发挥。
 */
export function composeAnswer(hits: Hit[], options: AnswerOptions = {}): Answer {
  const names = options.names ?? {}
  const max = options.maxCitations ?? 3
  const top = [...hits].sort((a, b) => b.score - a.score).slice(0, max)

  if (top.length === 0) {
    return {
      text: '未在知识库中检索到相关内容。可以换一种问法，或确认附件状态是「已解析」。',
      citations: [],
    }
  }

  const lines = [
    `根据知识库检索到 ${hits.length} 条相关片段，最高相似度 ${top[0].score.toFixed(2)}：`,
    '',
  ]

  top.forEach((hit, i) => {
    const name = names[hit.assetId] ?? hit.assetId
    const seq = chunkSeq(hit.chunkId)
    const label = seq > 0 ? `《${name}》第 ${seq} 段` : `《${name}》`
    lines.push(`${i + 1}. ${label} · ${hit.score.toFixed(2)}`)
    lines.push(`   ${snippet(hit.text)}`)
    lines.push('')
  })

  return { text: lines.join('\n').trimEnd(), citations: top }
}

function chunkSeq(chunkId: string): number {
  const raw = chunkId.split('#')[1]
  const n = Number(raw)
  return Number.isInteger(n) ? n + 1 : 0
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > SNIPPET ? `${flat.slice(0, SNIPPET)}…` : flat
}
