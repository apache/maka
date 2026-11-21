import { describe, expect, it } from 'vitest'
import { hashEmbedder, tokenize } from './embed'

function cos(a: Float32Array, b: Float32Array): number {
  let d = 0
  for (let i = 0; i < a.length; i++) d += a[i] * b[i]
  return d
}

describe('hashEmbedder', () => {
  it('维度固定且与 id 一致', async () => {
    const [v] = await hashEmbedder.embed(['pnpm install'])
    expect(v).toBeInstanceOf(Float32Array)
    expect(v.length).toBe(hashEmbedder.dim)
  })

  it('同一文本永远得到同一向量', async () => {
    const [a] = await hashEmbedder.embed(['启动命令 cd /d D:\\workspace'])
    const [b] = await hashEmbedder.embed(['启动命令 cd /d D:\\workspace'])
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('向量归一化，空文本为零向量不产生 NaN', async () => {
    const [v] = await hashEmbedder.embed(['向量模型'])
    expect(cos(v, v)).toBeCloseTo(1, 5)
    const [zero] = await hashEmbedder.embed([''])
    expect(Array.from(zero).every((x) => x === 0)).toBe(true)
  })

  it('同主题文本相似度高于无关文本', async () => {
    const [base, near, far] = await hashEmbedder.embed([
      'pnpm install',
      'pnpm install --port 5180',
      '今天天气不错，适合散步',
    ])
    expect(cos(base, near)).toBeGreaterThan(cos(base, far))
  })

  it('中文按单字+双字切词，能区分不同片段', () => {
    expect([...tokenize('启动命令')].sort()).toEqual(
      ['启', '动', '命', '令', '启动', '动命', '命令'].sort(),
    )
    expect(tokenize('Hello World')).toEqual(['hello', 'world'])
  })
})
