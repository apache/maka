/**
 * X-Track Storage - 工具函数
 *
 * 提供文本处理和辅助功能
 */

/**
 * 文本分词函数
 * 将文本分割为用于搜索的标记
 */
export function tokenizeText(text: string): string[] {
  if (!text) return []

  return text
    .toLowerCase()
    // 移除 URL
    .replace(/https?:\/\/\S+/g, '')
    // 移除提及
    .replace(/@[\w]+/g, '')
    // 移除话题标签（保留文本）
    .replace(/#/g, '')
    // 分词（支持多语言）
    .split(/[\s\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,\-./:;<=>?@[\]^_`{|}~，。！？；：""''【】（）]/)
    .filter(token => token.length >= 2) // 只保留长度 >= 2 的标记
    .filter((token, index, arr) => arr.indexOf(token) === index) // 去重
}

/**
 * 规范化文本
 */
export function normalizeText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/**
 * 检查是否为有效的推文 ID
 */
export function isValidTweetId(id: string): boolean {
  return /^\d{15,}$/.test(id)
}

/**
 * 检查是否为有效的用户名
 */
export function isValidScreenName(screenName: string): boolean {
  return /^[a-zA-Z0-9_]{1,15}$/.test(screenName)
}

/**
 * 格式化数字（K/M/B 后缀）
 */
export function formatNumber(num: number): string {
  if (num >= 1000000000) {
    return (num / 1000000000).toFixed(1).replace(/\.0$/, '') + 'B'
  }
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  }
  return num.toString()
}

/**
 * 解析格式化的数字
 */
export function parseFormattedNumber(str: string): number {
  const normalized = str.toUpperCase().trim()
  const multiplier: Record<string, number> = {
    K: 1000,
    M: 1000000,
    B: 1000000000
  }

  const match = normalized.match(/^([\d.]+)([KMB])?$/)
  if (!match) return 0

  const value = parseFloat(match[1])
  const suffix = match[2] || ''

  return Math.round(value * (multiplier[suffix] || 1))
}

/**
 * 计算两个日期之间的相对时间
 */
export function getRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSecs = Math.floor(diffMs / 1000)
  const diffMins = Math.floor(diffSecs / 60)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSecs < 60) {
    return `${diffSecs}s`
  } else if (diffMins < 60) {
    return `${diffMins}m`
  } else if (diffHours < 24) {
    return `${diffHours}h`
  } else if (diffDays < 7) {
    return `${diffDays}d`
  } else {
    const diffWeeks = Math.floor(diffDays / 7)
    if (diffWeeks < 4) {
      return `${diffWeeks}w`
    }
    const diffMonths = Math.floor(diffDays / 30)
    if (diffMonths < 12) {
      return `${diffMonths}mo`
    }
    const diffYears = Math.floor(diffDays / 365)
    return `${diffYears}y`
  }
}

/**
 * 清理推文文本（移除多余空白）
 */
export function cleanTweetText(text: string): string {
  return text
    .replace(/Show more$/i, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '')
    .replace(/ *\n */g, '\n')
}

/**
 * 截断文本
 */
export function truncateText(text: string, maxLength: number, suffix = '...'): string {
  if (text.length <= maxLength) return text
  return text.substring(0, maxLength - suffix.length) + suffix
}

/**
 * 高亮搜索关键词
 */
export function highlightKeywords(text: string, keywords: string[]): string {
  if (!keywords.length) return text

  const pattern = new RegExp(`(${keywords.map(escapeRegex).join('|')})`, 'gi')
  return text.replace(pattern, '<mark>$1</mark>')
}

/**
 * 转义正则表达式特殊字符
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 防抖函数
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  return function (this: unknown, ...args: Parameters<T>) {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }

    timeoutId = setTimeout(() => {
      fn.apply(this, args)
    }, delay)
  }
}

/**
 * 节流函数
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false

  return function (this: unknown, ...args: Parameters<T>) {
    if (!inThrottle) {
      fn.apply(this, args)
      inThrottle = true
      setTimeout(() => {
        inThrottle = false
      }, limit)
    }
  }
}
