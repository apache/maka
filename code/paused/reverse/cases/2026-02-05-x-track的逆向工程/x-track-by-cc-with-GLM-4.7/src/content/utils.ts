/**
 * X-Track Content Script - DOM 工具函数
 *
 * 提供各种 DOM 操作和数据提取的辅助函数
 */

/**
 * 从推文元素中提取推文ID
 */
export function extractTweetId(article: Element): string | null {
  // 方法1: 尝试查找状态链接
  const link = article.querySelector('a[href*="/status/"]')
  if (link) {
    const href = link.getAttribute('href')
    if (href) {
      const parts = href.split('/')
      const statusIndex = parts.indexOf('status')
      if (statusIndex !== -1 && parts[statusIndex + 1]) {
        return parts[statusIndex + 1].split('?')[0] // 移除查询参数
      }
    }
  }

  // 方法2: 检查 data-testid
  // 某些文章有 data-testid="tweet-123456"
  const testId = article.dataset.testid
  if (testId && testId.startsWith('tweet-')) {
    return testId.replace('tweet-', '')
  }

  return null
}

/**
 * 统计关键词配置（多语言支持）
 */
export const STAT_KEYWORDS = {
  likes: ['like', 'likes', 'liked', '点赞', '喜歡', '喜欢', '赞', '讚', '좋아요'],
  retweets: ['repost', 'retweet', 'retweets', '转推', '转发', '轉推', '轉發', '리포스트', '리트윗'],
  replies: ['reply', 'replies', 'replying', '回复', '回覆', '评论', '評論', '회신'],
  views: ['view', 'views', '查看', '浏览', '瀏覽', '次查看', '觀看', '조회']
}

/**
 * 从文本中解析计数（支持 K/M/B 后缀和中文单位）
 */
export function parseCountFromLabel(text: string | null): number | null {
  if (!text) return null
  const normalized = text.replace(/,/g, '').trim()
  if (!normalized) return null

  const lower = normalized.toLowerCase()
  let multiplier = 1

  // 检测英文后缀
  if (/[0-9.]+\s*k/.test(lower)) {
    multiplier = 1000
  } else if (/[0-9.]+\s*m/.test(lower)) {
    multiplier = 1000000
  } else if (/[0-9.]+\s*b/.test(lower)) {
    multiplier = 1000000000
  }

  // 检测中文单位
  if (normalized.includes('万') || normalized.includes('萬')) {
    multiplier = Math.max(multiplier, 10000)
  }
  if (normalized.includes('千')) {
    multiplier = Math.max(multiplier, 1000)
  }
  if (normalized.includes('亿') || normalized.includes('億')) {
    multiplier = Math.max(multiplier, 100000000)
  }

  const numberMatch = normalized.match(/[\d.]+/)
  if (!numberMatch) return null

  const value = parseFloat(numberMatch[0])
  if (Number.isNaN(value)) return null

  return Math.round(value * multiplier)
}

/**
 * 从元素中提取计数
 */
export function extractCountFromElement(el: Element | null): number | null {
  if (!el) return null

  const possibleTexts: (string | null)[] = []

  // 尝试 aria-label
  possibleTexts.push(el.getAttribute('aria-label'))

  // 尝试计数器 span
  const counterSpan =
    el.querySelector('[data-testid="app-text-transition-container"]') ||
    el.querySelector('span')
  if (counterSpan) {
    possibleTexts.push(counterSpan.textContent)
  }

  // 尝试文本内容
  possibleTexts.push(el.textContent)

  for (const text of possibleTexts) {
    const parsed = parseCountFromLabel(text)
    if (parsed !== null) {
      return parsed
    }
  }

  return null
}

/**
 * 从文章元素中获取统计数据
 */
export function getStatValue(
  articleElement: Element,
  testIds: string[] = [],
  keywords: string[] = []
): number {
  // 首先尝试通过 data-testid 查找
  for (const id of testIds) {
    const el = articleElement.querySelector(`[data-testid="${id}"]`)
    const value = extractCountFromElement(el)
    if (value !== null) {
      return value
    }
  }

  // 如果未找到，尝试通过关键词查找
  if (keywords.length > 0) {
    const statNodes = articleElement.querySelectorAll('[role="group"] [aria-label]')
    for (const node of statNodes) {
      const label = node.getAttribute('aria-label') || node.textContent || ''
      const lowerLabel = label.toLowerCase()
      if (keywords.some(keyword => lowerLabel.includes(keyword))) {
        const value = parseCountFromLabel(label)
        if (value !== null) {
          return value
        }
      }
    }
  }

  return 0
}

/**
 * 检查是否为推广/广告推文
 */
export function isPromotedTweet(articleElement: Element): boolean {
  if (!articleElement) return false

  // 推广标签关键词（多语言）
  const promotedLabels = [
    'Promoted',
    'Ad',
    '推广',
    '广告',
    'プロモーション',
    '광고'
  ]
  const allText = articleElement.textContent || ''

  // 方法1: 检查推广指示器 span
  const spans = articleElement.querySelectorAll('span')
  for (const span of spans) {
    const text = span.textContent?.trim()
    if (text && promotedLabels.includes(text)) {
      return true
    }
  }

  // 方法2: 检查包含 "promoted" 或 "ad" 的 data-testid
  const promotedElements = articleElement.querySelectorAll(
    '[data-testid*="promoted"], [data-testid*="Promoted"]'
  )
  if (promotedElements.length > 0) {
    return true
  }

  // 方法3: 检查包含推广关键词的 aria-label
  const elementsWithAria = articleElement.querySelectorAll('[aria-label]')
  for (const el of elementsWithAria) {
    const ariaLabel = el.getAttribute('aria-label')?.toLowerCase() || ''
    if (
      ariaLabel.includes('promoted') ||
      ariaLabel.includes('ad') ||
      ariaLabel.includes('推广')
    ) {
      return true
    }
  }

  // 方法4: 检查 DOM 结构中的特定推广推文指示器
  const socialContext = articleElement.querySelector('[data-testid="socialContext"]')
  if (socialContext) {
    const contextText = socialContext.textContent?.toLowerCase() || ''
    if (
      contextText.includes('promoted') ||
      contextText.includes('推广') ||
      contextText.includes('ad')
    ) {
      return true
    }
  }

  // 方法5: 检查推广链接模式
  const hasAdIndicator = articleElement.querySelector('[data-testid="placementTracking"]')
  if (hasAdIndicator) {
    return true
  }

  return false
}

/**
 * 从文章元素中提取媒体附件
 */
export interface MediaAttachment {
  url: string
  type: 'image' | 'video'
  tweetId: string
  author: string
}

export function extractMediaAttachments(
  article: Element,
  tweetId: string,
  handle: string
): MediaAttachment[] {
  if (!article) return []

  const media: MediaAttachment[] = []
  const seen = new Set<string>()

  const addMedia = (url: string | null, type: 'image' | 'video') => {
    if (!url) return
    const normalized = url.split('?')[0] || url
    if (seen.has(normalized)) return
    seen.add(normalized)
    media.push({ url, type, tweetId, author: handle })
  }

  // 提取图片
  const imageNodes = article.querySelectorAll(
    'div[data-testid="tweetPhoto"] img, ' +
      'div[data-testid="tweetDetailPhoto"] img, ' +
      'div[data-testid="tweet-media"] img'
  )
  imageNodes.forEach(img => {
    const src = (img as HTMLImageElement).currentSrc || img.getAttribute('src')
    addMedia(src, 'image')
  })

  // 提取视频
  let videoNodes = article.querySelectorAll(
    'div[data-testid="videoPlayer"] video, ' +
      'div[data-testid="tweetGif"] video, ' +
      'div[data-testid="animatedGifPlayable"] video'
  )
  if (!videoNodes.length) {
    videoNodes = article.querySelectorAll('video')
  }

  videoNodes.forEach(video => {
    // 确保视频属于当前文章
    if (video.closest('article') !== article) return

    let src = (video as HTMLVideoElement).currentSrc || video.getAttribute('src')
    if (!src) {
      const sourceEl = video.querySelector('source[src]')
      if (sourceEl) {
        src = sourceEl.getAttribute('src') || ''
      }
    }
    addMedia(src, 'video')
  })

  return media
}

/**
 * 从当前用户信息 DOM 中提取用户名
 */
export function getCurrentUserScreenName(): string | null {
  // 方法1: 检查侧边栏账户切换器
  const accountSwitcher = document.querySelector(
    '[data-testid="SideNav_AccountSwitcher_Button"]'
  )
  if (accountSwitcher) {
    const allSpans = accountSwitcher.querySelectorAll('span')
    for (const span of allSpans) {
      const text = span.textContent || ''
      if (text.startsWith('@')) {
        return text.replace('@', '').toLowerCase()
      }
    }
  }

  // 方法2: 检查个人资料链接
  const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')
  if (profileLink) {
    const href = profileLink.getAttribute('href')
    if (href) {
      return href.replace('/', '').toLowerCase()
    }
  }

  return null
}

/**
 * 配置文件页用户信息
 */
export interface ProfileUserInfo {
  handle: string
  name: string
  avatarUrl: string
}

// 配置文件页用户信息缓存
let cachedProfileUserInfo: ProfileUserInfo | null = null
let cachedProfilePath: string | null = null

/**
 * 从配置文件页标题获取用户信息
 */
export function getProfilePageUserInfo(): ProfileUserInfo | null {
  const currentPath = window.location.pathname

  // 如果路径未更改，返回缓存
  if (cachedProfilePath === currentPath && cachedProfileUserInfo) {
    return cachedProfileUserInfo
  }

  // 仅在配置文件页面工作
  const pathMatch = currentPath.match(/^\/([^\/]+)/)
  if (
    !pathMatch ||
    ['i', 'home', 'explore', 'search', 'notifications', 'messages', 'settings'].includes(
      pathMatch[1]
    )
  ) {
    return null
  }

  const handle = pathMatch[1]
  let name = handle
  let avatarUrl = ''

  // 尝试从配置文件标题获取名称
  const profileTitle = document.querySelector(
    '[data-testid="UserName"] span, [data-testid="primaryColumn"] [dir="ltr"] span'
  )
  if (profileTitle) {
    const titleText = profileTitle.textContent || ''
    if (titleText && !titleText.startsWith('@')) {
      name = titleText
    }
  }

  // 尝试从标题栏获取名称
  const headerBar = document.querySelector('h2[role="heading"]')
  if (headerBar && !name) {
    const headerText = headerBar.textContent || ''
    if (headerText && !headerText.startsWith('@')) {
      name = headerText
    }
  }

  // 尝试从配置文件标题获取头像
  const profileAvatar = document.querySelector(
    `[data-testid="UserAvatar-Container-${handle}"] img, a[href="/${handle}/photo"] img`
  )
  if (profileAvatar) {
    const src = (profileAvatar as HTMLImageElement).src
    if (src) {
      avatarUrl = src
    }
  }

  // 备用方法：查找包含 profile_images 的头像
  if (!avatarUrl) {
    const avatars = document.querySelectorAll('img[src*="profile_images"]')
    for (const avatar of avatars) {
      const img = avatar as HTMLImageElement
      // 跳过小头像（可能在推文中），查找较大的
      if (img.width >= 48 || img.height >= 48) {
        avatarUrl = img.src
        break
      }
    }
  }

  // 方法3: 主列中的第一张配置文件图片
  if (!avatarUrl) {
    const primaryColumn = document.querySelector('[data-testid="primaryColumn"]')
    if (primaryColumn) {
      const img = primaryColumn.querySelector('img[src*="profile_images"]')
      if (img) {
        avatarUrl = (img as HTMLImageElement).src
      }
    }
  }

  const userInfo: ProfileUserInfo = { handle, name, avatarUrl }

  // 缓存结果
  cachedProfilePath = currentPath
  cachedProfileUserInfo = userInfo

  console.log('X-Track: Extracted profile page user info:', userInfo)
  return userInfo
}

/**
 * 从 UserTweets URL 中提取用户
 */
export function getUserFromTweetsUrl(url: string): string | null {
  if (!url) return null

  // URL 格式: https://x.com/i/api/graphql/.../UserTweets?variables={"userId":"...",...}
  // 或页面 URL: https://x.com/username 或 https://x.com/username/with_replies
  const pageMatch = window.location.pathname.match(/^\/([^\/]+)/)
  if (
    pageMatch &&
    pageMatch[1] &&
    !['i', 'home', 'explore', 'search', 'notifications', 'messages', 'settings'].includes(
      pageMatch[1]
    )
  ) {
    return pageMatch[1].toLowerCase()
  }

  return null
}
