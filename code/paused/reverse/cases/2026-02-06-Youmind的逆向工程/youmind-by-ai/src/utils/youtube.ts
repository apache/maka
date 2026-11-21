/**
 * YouTube 工具函数
 *
 * 提供 YouTube 视频信息提取和字幕获取功能
 */

import type { YouTubeVideo, SubtitleCue } from '../types';

/**
 * 从 YouTube 全局变量中提取视频信息
 * @param globalVariables 包含 ytInitialPlayerResponse 的全局变量
 * @returns YouTube 视频信息
 */
export function extractYouTubeVideoInfo(globalVariables: {
  ytInitialPlayerResponse?: YouTubePlayerResponse;
}): YouTubeVideo | null {
  const { ytInitialPlayerResponse } = globalVariables;

  if (!ytInitialPlayerResponse?.videoDetails) {
    return null;
  }

  const { videoDetails } = ytInitialPlayerResponse;

  return {
    id: videoDetails.videoId,
    title: videoDetails.title,
    description: videoDetails.shortDescription,
    channelName: videoDetails.author,
    channelId: videoDetails.channelId,
    duration: videoDetails.lengthSeconds ? parseInt(videoDetails.lengthSeconds, 10) : undefined,
    viewCount: videoDetails.viewCount ? parseInt(videoDetails.viewCount, 10) : undefined,
    thumbnails: ytInitialPlayerResponse.thumbnails?.thumbnails?.map((thumb) => ({
      width: thumb.width,
      height: thumb.height,
      url: thumb.url,
    })),
  };
}

/**
 * YouTube 播放器响应类型
 */
interface YouTubePlayerResponse {
  videoDetails?: {
    videoId: string;
    title: string;
    shortDescription?: string;
    lengthSeconds?: string;
    channelId: string;
    author: string;
    viewCount?: string;
  };
  thumbnails?: {
    thumbnails?: Array<{
      width: number;
      height: number;
      url: string;
    }>;
  };
}

/**
 * 捕获视频帧
 * @param video 视频元素
 * @param options 捕获选项
 * @returns Base64 图片或 Blob
 */
export async function captureVideoFrame(
  video: HTMLVideoElement,
  options: {
    format?: 'base64' | 'blob';
    quality?: number;
    withSubtitleOnCanvas?: boolean;
    subtitleText?: string;
  } = {}
): Promise<string | Blob | null> {
  const {
    format = 'base64',
    quality = 0.95,
    withSubtitleOnCanvas = false,
    subtitleText = '',
  } = options;

  try {
    // 创建 canvas
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      console.error('[captureVideoFrame] Failed to get canvas context');
      return null;
    }

    // 绘制视频帧
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // 添加字幕到画布
    if (withSubtitleOnCanvas && subtitleText) {
      drawSubtitleOnCanvas(ctx, canvas, subtitleText);
    }

    // 返回指定格式
    if (format === 'blob') {
      return new Promise((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error('Failed to create blob'));
            }
          },
          'image/jpeg',
          quality
        );
      });
    }

    return canvas.toDataURL('image/jpeg', quality);
  } catch (error) {
    console.error('[captureVideoFrame] Error capturing video frame:', error);
    return null;
  }
}

/**
 * 在画布上绘制字幕
 * @param ctx Canvas 上下文
 * @param canvas Canvas 元素
 * @param text 字幕文本
 */
function drawSubtitleOnCanvas(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  text: string
): void {
  const padding = 10;
  const bottomPosition = canvas.height - 24;

  // 测量文本宽度
  ctx.font = '28px Arial';
  const textWidth = ctx.measureText(text).width;
  const textHeight = 28;

  // 绘制半透明背景
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(
    (canvas.width - textWidth) / 2 - padding,
    bottomPosition - textHeight - padding,
    textWidth + padding * 2,
    textHeight + padding * 2
  );

  // 绘制文本
  ctx.fillStyle = 'white';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(text, canvas.width / 2, bottomPosition);
}

/**
 * 获取当前 YouTube 页面显示的字幕
 * @returns 字幕文本或 undefined
 */
export function getCurrentYouTubeSubtitle(): string | undefined {
  try {
    // 可能的字幕选择器
    const selectors = [
      '.ytp-caption-segment',
      '.caption-window-container',
      '.ytp-caption-window-container',
      '.captions-text',
    ];

    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        // 提取并合并所有字幕文本
        const subtitles = Array.from(elements)
          .map((el) => el.textContent?.trim())
          .filter((text): text is string => Boolean(text && text.length > 0));

        if (subtitles.length > 0) {
          return subtitles.join(' ');
        }
      }
    }

    return undefined;
  } catch (error) {
    console.error('[getCurrentYouTubeSubtitle] Failed to get subtitle:', error);
    return undefined;
  }
}

/**
 * 解析 YouTube timedtext API URL
 * @param url timedtext API URL
 * @returns 解析后的参数
 */
export function parseTimedtextUrl(url: string): {
  lang: string;
  v: string;
  fmt: string;
  type?: string;
} | null {
  try {
    const urlObj = new URL(url);

    return {
      lang: urlObj.searchParams.get('lang') || '',
      v: urlObj.searchParams.get('v') || '',
      fmt: urlObj.searchParams.get('fmt') || 'srv1',
      type: urlObj.searchParams.get('type') || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 解析 YouTube 字幕 XML/JSON 响应
 * @param text 字幕响应文本
 * @param type 响应类型
 * @returns 字幕条目数组
 */
export function parseYouTubeSubtitle(
  text: string,
  type: 'xml' | 'json' = 'xml'
): SubtitleCue[] {
  if (type === 'xml') {
    return parseXMLSubtitle(text);
  }
  return parseJSONSubtitle(text);
}

/**
 * 解析 XML 格式字幕
 * @param xml XML 字符串
 * @returns 字幕条目数组
 */
function parseXMLSubtitle(xml: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const transcriptions = doc.querySelectorAll('transcript text');

  transcriptions.forEach((textEl) => {
    const start = parseFloat(textEl.getAttribute('start') || '0');
    const dur = parseFloat(textEl.getAttribute('dur') || '0');
    const content = textEl.textContent || '';

    cues.push({
      start,
      end: start + dur,
      text: content,
    });
  });

  return cues;
}

/**
 * 解析 JSON 格式字幕
 * @param json JSON 字符串
 * @returns 字幕条目数组
 */
function parseJSONSubtitle(json: string): SubtitleCue[] {
  try {
    const data = JSON.parse(json);
    const cues: SubtitleCue[] = [];

    if (data.events) {
      data.events.forEach((event: { tStartMs: number; dDurationMs: number; segs: Array<{ utf8: string }> }) => {
        const text = event.segs.map((seg) => seg.utf8).join('');
        cues.push({
          start: event.tStartMs / 1000,
          end: (event.tStartMs + event.dDurationMs) / 1000,
          text,
        });
      });
    }

    return cues;
  } catch {
    return [];
  }
}
