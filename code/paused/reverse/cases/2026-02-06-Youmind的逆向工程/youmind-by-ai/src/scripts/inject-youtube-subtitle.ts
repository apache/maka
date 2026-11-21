/**
 * YouTube 字幕拦截注入脚本
 *
 * 功能：
 * 1. 拦截 YouTube timedtext API 请求（XHR 和 Fetch）
 * 2. 通过自定义事件发送字幕 URL 给 Content Script
 * 3. 支持 Trusted Types 策略
 */

/**
 * YouTube 字幕拦截器
 * 拦截 XHR 和 Fetch 请求以获取字幕 API URL
 */
function injectYouTubeInterceptor(): void {
  /**
   * 拦截 XMLHttpRequest.prototype.open
   * 监听包含 timedtext 的 URL
   */
  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    ...args: unknown[]
  ) {
    const urlString = typeof url === 'string' ? url : url.href;

    // 检查是否为 YouTube 字幕 API
    if (urlString.includes('www.youtube.com/api/timedtext')) {
      // 发送自定义事件
      const timedTextEvent = new CustomEvent('youtube_timedtext_request_youmind', {
        detail: urlString,
      });
      window.dispatchEvent(timedTextEvent);
    }

    return originalXHROpen.apply(this, [method, url, ...args] as never);
  };

  /**
   * 拦截 window.fetch
   * 监听包含 timedtext 的 URL
   */
  const originalFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    // 检查是否为 YouTube 字幕 API
    if (url.includes('www.youtube.com/api/timedtext')) {
      // 发送自定义事件
      const timedTextEvent = new CustomEvent('youtube_timedtext_request_youmind', {
        detail: url,
      });
      window.dispatchEvent(timedTextEvent);
    }

    return originalFetch.apply(this, [input, init] as never);
  };
}

/**
 * 注入脚本到页面
 * 使用 script 标签绕过 Trusted Types 限制
 */
(function injectYouTubeSubtitleScript() {
  try {
    const script = document.createElement('script');

    // 检查是否支持 Trusted Types
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
      try {
        // 创建 Trusted Types 策略
        const policy = trustedTypes.createPolicy('youmind-youtube-interceptor', {
          createScript: (input: string) => input,
        });
        script.textContent = policy.createScript(`(${injectYouTubeInterceptor.toString()})()`);
      } catch (e) {
        // 策略创建失败，抛出错误到 catch 块
        throw new Error('TrustedTypes policy creation failed');
      }
    } else {
      // 不支持 Trusted Types，直接设置
      script.textContent = `(${injectYouTubeInterceptor.toString()})()`;
    }

    // 插入 script 标签
    (document.head || document.documentElement).appendChild(script);

    // 立即移除 script 标签
    script.remove();
  } catch (error) {
    // Script 标签方式失败，直接执行函数
    injectYouTubeInterceptor();
  }
})();
