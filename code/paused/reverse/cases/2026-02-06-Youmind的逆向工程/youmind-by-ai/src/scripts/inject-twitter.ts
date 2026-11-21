/**
 * Twitter 视频信息拦截注入脚本
 *
 * 功能：
 * 1. 拦截 Twitter XHR 请求
 * 2. 解析包含 video_info 的响应
 * 3. 提取推文视频元数据
 */

/**
 * 注入 Twitter 拦截器
 * 拦截 XMLHttpRequest 以获取 Twitter 视频信息
 */
(function injectTwitterInterceptor() {
  // 保存原始 open 方法
  const originalOpen = XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    // 监听 readyState 变化
    this.addEventListener('readystatechange', function () {
      // 检查请求是否完成
      if (this.readyState !== 4 /* DONE */) {
        return;
      }

      // 跳过 ArrayBuffer 响应类型
      if (this.responseType === 'arraybuffer') {
        return;
      }

      try {
        const responseText = this.responseText;

        // 检查响应是否包含 video_info
        if (responseText.includes('video_info')) {
          const response = JSON.parse(responseText);
          // TODO: 处理 Twitter 视频信息
          // 可以派发自定义事件发送给 Content Script
          // const event = new CustomEvent('twitter_video_info_youmind', {
          //   detail: response
          // });
          // window.dispatchEvent(event);
        }
      } catch (error) {
        // JSON 解析失败，忽略错误
      }
    });

    return originalOpen.apply(this, [method, url, ...rest] as never);
  };
})();
