import { describe, expect, it } from 'vitest'
import { chunkText, DEFAULT_CHUNK } from './chunk'

describe('chunkText', () => {
  it('空白输入返回空数组', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n\t  ')).toEqual([])
  })

  it('不超过 size 的文本原样一片', () => {
    expect(chunkText('pnpm install', { size: 100 })).toEqual(['pnpm install'])
  })

  it('统一换行并去掉首尾空白', () => {
    expect(chunkText('  a\r\nb\r\n  ', { size: 100 })).toEqual(['a\nb'])
  })

  it('优先在换行/句末切分，不把一句话劈开', () => {
    const text = '第一句很短。第二句也很短。第三句同样很短。'
    const chunks = chunkText(text, { size: 16, overlap: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(16)
    // 每片都以句号收尾，说明切点落在句末
    for (const c of chunks) expect(c.endsWith('。')).toBe(true)
  })

  it('相邻分片按 overlap 重叠，且整体向前推进', () => {
    const text = 'A'.repeat(40) + '。' + 'B'.repeat(40) + '。' + 'C'.repeat(40)
    const chunks = chunkText(text, { size: 30, overlap: 10 })
    expect(chunks.length).toBeGreaterThan(1)
    for (let i = 1; i < chunks.length; i++) {
      // 后一片的头部出现在前一片尾部（重叠确实发生）
      expect(chunks[i - 1].includes(chunks[i].slice(0, 5))).toBe(true)
    }
  })

  it('超长无标点文本被硬切，且每片不超 size', () => {
    const chunks = chunkText('x'.repeat(1000), { size: 100, overlap: 0 })
    expect(chunks.every((c) => c.length <= 100)).toBe(true)
    expect(chunks.join('')).toBe('x'.repeat(1000))
  })

  it('overlap 必须小于 size', () => {
    expect(() => chunkText('abc', { size: 10, overlap: 10 })).toThrow(RangeError)
    expect(() => chunkText('abc', { size: 0 })).toThrow(RangeError)
  })

  it('默认参数落在 200~400 字符区间', () => {
    expect(DEFAULT_CHUNK.size).toBeGreaterThanOrEqual(200)
    expect(DEFAULT_CHUNK.size).toBeLessThanOrEqual(400)
    expect(DEFAULT_CHUNK.overlap).toBeLessThan(DEFAULT_CHUNK.size)
  })
})
