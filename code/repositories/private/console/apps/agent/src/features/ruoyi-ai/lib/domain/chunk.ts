export interface ChunkOptions {
  /** 目标分片长度（字符） */
  size?: number
  /** 相邻分片重叠字符数；重叠是检索召回率的保险，不是正确性来源 */
  overlap?: number
}

export const DEFAULT_CHUNK = { size: 320, overlap: 48 } as const

/** 切点：句末/段落末尾之后。中文不靠分词库，靠标点兜住语义边界。 */
const BOUNDARY = /[。！？!?；;\n]/

export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const size = options.size ?? DEFAULT_CHUNK.size
  const overlap = options.overlap ?? DEFAULT_CHUNK.overlap
  if (!Number.isInteger(size) || size <= 0) throw new RangeError('size 必须是正整数')
  if (overlap < 0 || overlap >= size) throw new RangeError('overlap 必须满足 0 <= overlap < size')

  const normalized = text.replace(/\r\n?/g, '\n')
  if (!normalized.trim()) return []

  // 所有合法切点
  const cuts: number[] = []
  for (let i = 0; i < normalized.length; i++) {
    if (BOUNDARY.test(normalized[i])) cuts.push(i + 1)
  }

  const out: string[] = []
  let start = 0
  while (start < normalized.length) {
    let end = Math.min(start + size, normalized.length)
    if (end < normalized.length) {
      // 只在后半段找边界，否则会为了凑句子把片切得过短
      const floor = start + Math.ceil(size * 0.6)
      const cut = lastCut(cuts, floor, end)
      if (cut > start) end = cut
    }
    const piece = normalized.slice(start, end).trim()
    if (piece) out.push(piece)
    if (end >= normalized.length) break
    const next = end - overlap
    start = next > start ? next : end
  }
  return out
}

function lastCut(cuts: number[], floor: number, ceil: number): number {
  for (let i = cuts.length - 1; i >= 0; i--) {
    const c = cuts[i]
    if (c <= ceil && c >= floor) return c
  }
  return -1
}
