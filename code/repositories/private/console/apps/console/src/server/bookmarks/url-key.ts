/** URL 归一化键：trim + 去尾斜杠。Q7 定案——精确匹配去重，不做协议/查询参数归一化。 */
export function urlKey(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/**
 * 近似重复键：忽略协议、www 前缀、查询参数与锚点，只看主机 + 路径。
 * 与 urlKey 的分工：url_key 管"是否同一条"（硬约束），duplicateKey 管"是不是同一页"（检测视图，只提示不拦截）。
 */
export function duplicateKey(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname.replace(/\/+$/, '') || '/'
    return `${u.hostname.replace(/^www\./, '')}${path}`
  } catch {
    return `raw:${url.trim().replace(/\/+$/, '')}`
  }
}
