import { describe, expect, it } from 'vitest'
import { composeAnswer } from './answer'
import type { Hit } from './types'

function hit(score: number, text: string, chunkId = 'c1'): Hit {
  return { chunkId, assetId: 'a1', kbId: 'kb1', text, score }
}

const names = { a1: '启动命令.txt' }

describe('composeAnswer', () => {
  it('没有命中时明说检索不到，不编答案', () => {
    const answer = composeAnswer([], { names })
    expect(answer.citations).toEqual([])
    expect(answer.text).toContain('未在知识库中检索到相关内容')
  })

  it('最多引用 3 条，按分数降序，带文件名与序号', () => {
    const hits = [hit(0.9, 'cd /d D:\\workspace\\ruoyi-admin', 'c1'), hit(0.8, 'pnpm install', 'c2'), hit(0.7, 'pnpm dev:antd', 'c3'), hit(0.5, '噪音', 'c4')]
    const answer = composeAnswer(hits, { names })
    expect(answer.citations).toHaveLength(3)
    expect(answer.citations.map((c) => c.chunkId)).toEqual(['c1', 'c2', 'c3'])
    expect(answer.text).toContain('启动命令.txt')
    expect(answer.text).toContain('pnpm install')
    expect(answer.text).toContain('0.90')
  })

  it('超长分片截断，避免聊天区被一段 500 字淹没', () => {
    const long = 'x'.repeat(500)
    const answer = composeAnswer([hit(0.6, long)], { names })
    expect(answer.text).toContain('…')
    expect(answer.text.length).toBeLessThan(long.length)
  })

  it('未知附件名时退回 id，不显示 undefined', () => {
    const answer = composeAnswer([hit(0.6, 'abc', 'c9')], { names: {} })
    expect(answer.text).toContain('a1')
    expect(answer.text).not.toContain('undefined')
  })
})
