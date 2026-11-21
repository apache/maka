/**
 * URL 工具函数
 *
 * 功能:
 * - URL 参数处理
 * - URL 构建
 * - 域名解析
 */

/**
 * 获取 URL 参数
 */
export function getUrlParams(url: string = window.location.href): Record<string, string> {
  const params: Record<string, string> = {}
  const queryString = url.split('?')[1]

  if (!queryString) return params

  const searchParams = new URLSearchParams(queryString)
  searchParams.forEach((value, key) => {
    params[key] = value
  })

  return params
}

/**
 * 设置 URL 参数
 */
export function setUrlParam(url: string, key: string, value: string): string {
  const urlObj = new URL(url)
  urlObj.searchParams.set(key, value)
  return urlObj.toString()
}

/**
 * 删除 URL 参数
 */
export function removeUrlParam(url: string, key: string): string {
  const urlObj = new URL(url)
  urlObj.searchParams.delete(key)
  return urlObj.toString()
}

/**
 * 构建 URL
 */
export function buildUrl(base: string, path: string, params?: Record<string, any>): string {
  const url = new URL(path, base)

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value))
      }
    })
  }

  return url.toString()
}

/**
 * 获取域名
 */
export function getDomain(url: string): string {
  try {
    const urlObj = new URL(url)
    return urlObj.hostname
  } catch {
    return ''
  }
}

/**
 * 获取根域名
 */
export function getRootDomain(url: string): string {
  const domain = getDomain(url)
  if (!domain) return ''

  const parts = domain.split('.')
  if (parts.length < 2) return domain

  // 处理类似 co.uk 的情况
  if (parts.length > 2) {
    return parts.slice(-2).join('.')
  }

  return domain
}

/**
 * 判断是否为相同域名
 */
export function isSameDomain(url1: string, url2: string): boolean {
  return getDomain(url1) === getDomain(url2)
}

/**
 * 判断是否为外部链接
 */
export function isExternalLink(url: string, currentDomain: string = window.location.hostname): boolean {
  const domain = getDomain(url)
  return domain !== '' && domain !== currentDomain
}

/**
 * 获取 Favicon URL
 */
export function getFaviconUrl(url: string): string {
  const domain = getDomain(url)
  if (!domain) return ''

  return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`
}

/**
 * 获取网站图标 URL (使用代理)
 */
export function getWebsiteIcon(url: string): string {
  const domain = getDomain(url)
  if (!domain) return ''

  return `https://files.codelife.cc/icon/${domain}.png`
}

/**
 * URL 编码
 */
export function encodeUrl(url: string): string {
  return encodeURIComponent(url)
}

/**
 * URL 解码
 */
export function decodeUrl(encoded: string): string {
  return decodeURIComponent(encoded)
}

/**
 * Base64 编码 URL (安全方式)
 */
export function base64EncodeUrl(url: string): string {
  return btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/**
 * Base64 解码 URL
 */
export function base64DecodeUrl(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=')
  return atob(padded)
}
