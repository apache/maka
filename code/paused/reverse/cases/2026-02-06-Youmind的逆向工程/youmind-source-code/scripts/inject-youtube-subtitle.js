;(function () {
  // 定义要注入的函数
  function injectYouTubeInterceptor() {
    // 监听 YouTube
    const originalXHROpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function (method, url, ...args) {
      // 检查URL是否包含timedtext API
      if (url.includes('www.youtube.com/api/timedtext')) {
        // 发送自定义事件传递URL
        const timedTextEvent = new CustomEvent(
          'youtube_timedtext_request_youmind',
          {
            detail: url,
          }
        )
        window.dispatchEvent(timedTextEvent)
        // console.log('看看 1 捕获到YouTube字幕API请求:', url)
      }
      return originalXHROpen.apply(this, [method, url, ...args])
    }

    // 拦截 fetch API
    const originalFetch = window.fetch
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input.url

      // 检查URL是否包含timedtext API
      if (url.includes('www.youtube.com/api/timedtext')) {
        // 发送自定义事件传递URL
        const timedTextEvent = new CustomEvent(
          'youtube_timedtext_request_youmind',
          {
            detail: url,
          }
        )
        window.dispatchEvent(timedTextEvent)
        // console.log('看看 2 捕获到YouTube字幕API请求:', url)
      }

      return originalFetch.apply(this, arguments)
    }
  }

  try {
    // 尝试使用 script 标签注入（处理 Trusted Types）
    const script = document.createElement('script')

    // 检查是否支持 Trusted Types
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
      try {
        const policy = trustedTypes.createPolicy(
          'youmind-youtube-interceptor',
          {
            createScript: (input) => input,
          }
        )
        script.textContent = policy.createScript(
          `(${injectYouTubeInterceptor.toString()})()`
        )
      } catch (e) {
        // 如果创建策略失败，使用备选方案
        throw new Error('TrustedTypes policy creation failed')
      }
    } else {
      // 不支持 Trusted Types，直接设置
      script.textContent = `(${injectYouTubeInterceptor.toString()})()`
    }

    // 将script标签插入到页面头部
    ;(document.head || document.documentElement).appendChild(script)

    // 插入后立即移除script标签，保持页面整洁
    script.remove()
  } catch (error) {
    // 如果 script 标签方式失败，直接执行函数
    injectYouTubeInterceptor()
  }
})()
