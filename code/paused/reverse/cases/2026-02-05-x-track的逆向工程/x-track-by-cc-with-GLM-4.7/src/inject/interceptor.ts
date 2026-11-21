/**
 * X-Track Inject Script - 网络拦截器
 *
 * 此脚本在页面的主上下文中运行，用于拦截网络请求
 * 它必须被注入到页面的主世界中才能访问原始的 XHR/fetch
 */

;(function () {
  'use strict'

  console.log('X-Track: Main World Interceptor loaded')

  // ============================================================================
  // 常量定义
  // ============================================================================

  const MESSAGE_SOURCE = 'XTRACK_INJECT'
  const MESSAGE_TYPE = 'XTRACK_INTERCEPT_DATA'

  // 目标 API 端点
  const TARGET_API_ENDPOINTS = [
    '/TweetDetail',
    '/UserTweets',
    '/Bookmarks',
    '/Likes',
    '/HomeTimeline',
    '/UserMedia',
    '/ArticleDetail', // 文章完整内容
    '/SearchTimeline',
    '/ListLatestTweetsTimeline',
    '/TweetDetailByRestId'
  ]

  // ============================================================================
  // 工具函数
  // ============================================================================

  /**
   * 检查 URL 是否为目标 URL
   */
  function isTargetUrl(url: string): boolean {
    return TARGET_API_ENDPOINTS.some(endpoint => url.includes(endpoint))
  }

  /**
   * 向 content script 发送消息
   */
  function postToContentScript(type: string, data: unknown, url: string): void {
    window.postMessage(
      {
        source: MESSAGE_SOURCE,
        type,
        url,
        data
      },
      '*'
    )
  }

  /**
   * 安全解析 JSON
   */
  function safeParseJSON(text: string): unknown | null {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  // ============================================================================
  // XHR 拦截
  // ============================================================================

  const XHR = XMLHttpRequest.prototype
  const originalOpen = XHR.open
  const originalSend = XHR.send

  /**
   * 拦截 XHR.open
   */
  XHR.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    // 存储 URL 供后续使用
    ;(this as any)._url = url.toString()
    return originalOpen.apply(this, [method, url, ...rest] as never)
  }

  /**
   * 拦截 XHR.send
   */
  XHR.send = function (this: XMLHttpRequest, ...args: unknown[]) {
    this.addEventListener('load', function () {
      const url = (this as any)._url as string

      if (url && isTargetUrl(url)) {
        const data = safeParseJSON(this.responseText)

        if (data) {
          postToContentScript(MESSAGE_TYPE, data, url)
        }
      }
    })

    return originalSend.apply(this, args as never)
  }

  // ============================================================================
  // Fetch 拦截
  // ============================================================================

  const originalFetch = window.fetch

  /**
   * 拦截 window.fetch
   */
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const response = await originalFetch(input, init)

    try {
      const url = input instanceof Request ? input.url : input.toString()

      if (url && isTargetUrl(url)) {
        console.log('X-Track Inject: Intercepted fetch to', url)

        // 克隆响应以避免消耗原始响应
        const clonedResponse = response.clone()

        clonedResponse
          .json()
          .then(data => {
            console.log('X-Track Inject: Sending data to content script')
            postToContentScript(MESSAGE_TYPE, data, url)
          })
          .catch(error => {
            console.warn('X-Track Inject: Failed to parse JSON', error)
          })
      }
    } catch (error) {
      // 忽略错误
      console.debug('X-Track Inject: Fetch interception error', error)
    }

    return response
  } as typeof fetch

  // ============================================================================
  // 导出（用于调试）
  // ============================================================================

  ;(window as any).__XTRACK_INTERCEPTOR__ = {
    isTargetUrl,
    TARGET_API_ENDPOINTS,
    MESSAGE_SOURCE,
    MESSAGE_TYPE
  }
})()
