/** 向量工具。所有 embedding 出口都归一化，检索时点积即余弦。 */

export function normalize(v: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  if (sum === 0) return v
  const inv = 1 / Math.sqrt(sum)
  for (let i = 0; i < v.length; i++) v[i] *= inv
  return v
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new RangeError(`维度不一致: ${a.length} vs ${b.length}`)
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}
