/**
 * YouTube 元数据注入脚本
 *
 * 功能：
 * 1. 从 YouTube 页面全局变量中提取视频元数据
 * 2. 通过自定义事件发送给 Content Script
 * 3. 支持 metacontext 和传统 ytInitialPlayerResponse
 */

interface YouTubeGlobalVariables {
  /** YouTube 播放器响应数据 */
  ytInitialPlayerResponse?: YouTubePlayerResponse;
  /** YouTube 初始数据 */
  ytInitialData?: unknown;
}

interface YouTubePlayerResponse {
  /** 视频详情 */
  videoDetails?: {
    /** 视频 ID */
    videoId: string;
    /** 标题 */
    title: string;
    /** 描述 */
    shortDescription?: string;
    /** 时长（秒） */
    lengthSeconds?: string;
    /** 频道 ID */
    channelId: string;
    /** 频道名称 */
    author: string;
    /** 视图数 */
    viewCount?: string;
  };
  /** 缩略图 */
  thumbnails?: {
    /** 可用缩略图 */
    thumbnails?: Array<{
      /** 宽度 */
      width: number;
      /** 高度 */
      height: number;
      /** URL */
      url: string;
    }>;
  };
}

/**
 * 注入 YouTube 元数据提取器
 * 此函数在页面上下文中执行，可以访问 YouTube 全局变量
 */
(function injectYouTubeMetadataExtractor() {
  /**
   * 提取 YouTube 全局变量
   * 支持 metacontext API 和传统全局变量
   */
  const globalVariables: YouTubeGlobalVariables = {
    // 新版 YouTube 使用 metacontext
    ytInitialPlayerResponse:
      (window as unknown as { metacontext?: { context?: { ytInitialPlayerResponse?: unknown } } })
        .metacontext?.context?.ytInitialPlayerResponse as YouTubePlayerResponse | undefined,
    // 传统全局变量
    ytInitialData: (window as unknown as { ytInitialData?: unknown }).ytInitialData,
  };

  /**
   * 创建并派发自定义事件
   * Content Script 监听此事件以获取视频元数据
   */
  const event = new CustomEvent('grab_youtube_metacontext_youmind', {
    detail: globalVariables,
  });

  // 触发事件
  window.dispatchEvent(event);
})();
