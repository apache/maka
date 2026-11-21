/**
 * YouMind Content Script 主入口
 *
 * 功能：
 * 1. YouTube 页面集成
 * 2. Twitter 页面集成
 * 3. 网页内容剪藏
 * 4. 与 Background 通信
 * 5. UI 组件渲染
 */

import { t } from '../i18n';
import { captureVideoFrame, getCurrentYouTubeSubtitle, extractYouTubeVideoInfo } from '../utils/youtube';
import { scrapByJina, getPageTitle, getPageUrl, getSelectionText, getSelectionHtml } from '../utils/api';
import { getStoredUser } from '../utils/storage';
import type { Message, YouTubeVideo, WebpageContent } from '../types';

/**
 * 执行注入脚本到页面上下文
 * @param scriptUrl 脚本 URL
 */
async function injectScript(scriptUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL(scriptUrl);
    script.onload = () => {
      script.remove();
      resolve();
    };
    script.onerror = reject;
    (document.head || document.documentElement).appendChild(script);
  });
}

/**
 * 初始化 Content Script
 */
export async function onExecute(context: { perf: { injectTime: number; loadTime: number } }): Promise<void> {
  console.log('[YouMind] Content script initialized', context.perf);

  const url = window.location.href;

  // 根据页面类型注入相应脚本
  if (url.includes('youtube.com')) {
    await initYouTubeIntegration();
  } else if (url.includes('twitter.com') || url.includes('x.com')) {
    await initTwitterIntegration();
  }

  // 通用页面功能
  await initGeneralFeatures();

  // 监听来自 background 的消息
  chrome.runtime.onMessage.addListener(handleMessage);
}

/**
 * 初始化 YouTube 集成
 */
async function initYouTubeIntegration(): Promise<void> {
  console.log('[YouMind] Initializing YouTube integration');

  // 注入 YouTube 元数据提取脚本
  await injectScript('scripts/inject-youtube.js');

  // 注入 YouTube 字幕拦截脚本
  await injectScript('scripts/inject-youtube-subtitle.js');

  // 监听 YouTube 元数据事件
  window.addEventListener('grab_youtube_metacontext_youmind', handleYouTubeMetadata);

  // 监听 YouTube 字幕请求事件
  window.addEventListener('youtube_timedtext_request_youmind', handleYouTubeSubtitleRequest);
}

/**
 * 处理 YouTube 元数据事件
 */
async function handleYouTubeMetadata(event: CustomEvent): Promise<void> {
  const { ytInitialPlayerResponse } = event.detail;

  if (!ytInitialPlayerResponse) {
    return;
  }

  const videoInfo = extractYouTubeVideoInfo({ ytInitialPlayerResponse });

  if (videoInfo) {
    console.log('[YouMind] YouTube video info:', videoInfo);

    // 存储到全局状态供其他功能使用
    (window as unknown as Record<string, unknown>).YouMindVideoInfo = videoInfo;
  }
}

/**
 * 处理 YouTube 字幕请求事件
 */
async function handleYouTubeSubtitleRequest(event: CustomEvent): Promise<void> {
  const subtitleUrl = event.detail as string;
  console.log('[YouMind] YouTube subtitle URL:', subtitleUrl);

  // TODO: 下载并解析字幕
}

/**
 * 初始化 Twitter 集成
 */
async function initTwitterIntegration(): Promise<void> {
  console.log('[YouMind] Initializing Twitter integration');

  // 注入 Twitter 拦截脚本
  await injectScript('scripts/inject-twitter.js');
}

/**
 * 初始化通用功能
 */
async function initGeneralFeatures(): Promise<void> {
  console.log('[YouMind] Initializing general features');

  // 检查用户登录状态
  const user = await getStoredUser();
  if (user?.isLogin) {
    // 可以注入 UI 组件
  }
}

/**
 * 处理来自 background 的消息
 */
async function handleMessage(message: Message, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void): Promise<void> {
  console.log('[YouMind] Received message:', message.type);

  try {
    switch (message.type) {
      case 'SAVE_CONTENT':
        await handleSaveContent(message.data);
        sendResponse({ success: true });
        break;
      case 'SAVE_IMAGE':
        await handleSaveImage(message.data);
        sendResponse({ success: true });
        break;
      case 'SAVE_LINK':
        await handleSaveLink(message.data);
        sendResponse({ success: true });
        break;
      case 'SAVE_WEBPAGE':
        await handleSaveWebpage();
        sendResponse({ success: true });
        break;
      case 'OPEN_SIDEBAR':
        await openSidebar();
        sendResponse({ success: true });
        break;
      case 'START_TRANSLATE':
        await handleTranslate();
        sendResponse({ success: true });
        break;
      default:
        sendResponse({ success: false, error: 'Unknown message type' });
    }
  } catch (error) {
    sendResponse({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * 处理保存内容
 */
async function handleSaveContent(data: { selectionText?: string }): Promise<void> {
  const text = data.selectionText || getSelectionText();

  if (!text) {
    throw new Error('No content selected');
  }

  console.log('[YouMind] Saving content:', text.substring(0, 100));

  // TODO: 实现保存逻辑
  await notifySuccess(t('SAVED'));
}

/**
 * 处理保存图片
 */
async function handleSaveImage(data: { imageUrl?: string }): Promise<void> {
  const imageUrl = data.imageUrl;

  if (!imageUrl) {
    throw new Error('No image URL provided');
  }

  console.log('[YouMind] Saving image:', imageUrl);

  // TODO: 实现保存逻辑
  await notifySuccess(t('SAVED'));
}

/**
 * 处理保存链接
 */
async function handleSaveLink(data: { url?: string }): Promise<void> {
  const url = data.url;

  if (!url) {
    throw new Error('No link URL provided');
  }

  console.log('[YouMind] Saving link:', url);

  // TODO: 实现保存逻辑
  await notifySuccess(t('SAVED'));
}

/**
 * 处理保存网页
 */
async function handleSaveWebpage(): Promise<void> {
  const url = getPageUrl();
  const title = getPageTitle();

  console.log('[YouMind] Saving webpage:', title, url);

  try {
    // 尝试使用 Jina AI 抓取
    const webpageData = await scrapByJina(url);

    console.log('[YouMind] Jina AI scraped:', webpageData);

    // TODO: 上传到 YouMind
  } catch (error) {
    console.error('[YouMind] Jina AI failed, falling back to basic data:', error);

    // 回退到基本数据
    const basicData = {
      title,
      url,
      content: document.body.innerText,
    };

    // TODO: 上传基本数据
  }

  await notifySuccess(t('SAVED'));
}

/**
 * 打开侧边栏
 */
async function openSidebar(): Promise<void> {
  console.log('[YouMind] Opening sidebar');

  // TODO: 实现 UI 组件
}

/**
 * 处理翻译
 */
async function handleTranslate(): Promise<void> {
  console.log('[YouMind] Starting translation');

  // TODO: 实现翻译功能
}

/**
 * 显示成功通知
 */
async function notifySuccess(message: string): Promise<void> {
  // 使用 Chrome 通知 API
  if (chrome.notifications) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('images/logo/production/128.png'),
      title: 'YouMind',
      message,
    });
  }
}

/**
 * 获取 YouTube 当前视频信息
 * @returns 视频信息
 */
export function getYouTubeVideoInfo(): YouTubeVideo | null {
  return (window as unknown as Record<string, unknown>).YouMindVideoInfo as YouTubeVideo | null;
}

/**
 * 捕获 YouTube 视频帧
 * @param video 视频元素
 * @param options 选项
 * @returns Base64 图片或 Blob
 */
export async function captureYouTubeFrame(
  video: HTMLVideoElement,
  options?: {
    format?: 'base64' | 'blob';
    quality?: number;
    withSubtitle?: boolean;
  }
): Promise<string | Blob | null> {
  const subtitleText = options?.withSubtitle ? getCurrentYouTubeSubtitle() : undefined;

  return captureVideoFrame(video, {
    ...options,
    withSubtitleOnCanvas: options?.withSubtitle,
    subtitleText,
  });
}
