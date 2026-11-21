// =============================================================================
// NeatDownloadManager Extension v1.9.92 — 类型定义
// 从混淆 JS 中逆向推断，反映了运行时的实际数据形状
// =============================================================================

// -----------------------------------------------------------------------------
// 消息协议：Background (bg.js) <-> Content Script (ct.js)
// -----------------------------------------------------------------------------

/**
 * 从 content script 发往 background service worker 的消息类型
 *
 * - 2: 更新当前标签页信息 (tab URL 变化)
 * - 4: 键盘事件状态 (Delete 键按下/释放)
 * - 6: 用户点击媒体面板中的下载项，发送下载请求
 */
export type ContentToBackgroundMessage =
  | [2, tabUrl: string, pageUrl: string, pageTitle: string]     // 页面 URL 更新
  | [4, mode: 'keydown' | 'keyup']                              // 键盘事件
  | [6, downloadItem: DownloadRequestMessage, pageUrl: string, pageTitle: string, displayName: string]; // 下载请求

/**
 * 从 background service worker 发往 content script 的消息类型
 *
 * - 1: 传递检测到的下载项给 content script 显示
 * - 3: 分配连接 ID
 * - 5: 显示/隐藏面板切换
 * - 11: 页面 URL 变更通知
 * - 13: ShowMediaPanel 配置变更
 * - 15: 连接桌面应用失败告警
 */
export type BackgroundToContentMessage =
  | [1, downloadItem: DetectedDownload, pageUrl: string, pageTitle: string]
  | [3, connectionId: number]
  | [5]
  | [11, url: string]
  | [13, showMediaPanel: boolean]
  | [15];

// -----------------------------------------------------------------------------
// 请求/响应建模
// -----------------------------------------------------------------------------

/** 内部请求对象 (对应 bg.js 中的 T 构造函数)，封装一次 HTTP 请求的完整元数据 */
export interface RequestInfo {
  /** 1: HTTP 方法 (GET/POST) */
  '1': string;
  /** 2: URL */
  '2': string;
  /** 3: 保留字段 (可能在处理流程中赋值) */
  '3': string;
  /** 4: 页面标题 (document.title) */
  '4': string;
  /** 5: Referer / 来源 URL */
  '5': string;
  /** 6: 下载类型：normal | media | hls */
  '6': string;
  /** 7: Content-Length 字节数 */
  '7': number;
  /** 8: Content-Type 原始值 */
  '8': string;
  /** 9: 文件名 / 描述 */
  '9': string;
  /** 10: Content-Type (处理后) */
  '10': string;
  /** 11: Content-Disposition */
  '11': string;
  /** cookies: 该 URL 的 cookie 字符串 */
  cookies: string;
  /** postData: POST 请求体文本 (表单数据 / multipart) */
  postData: string | null;
  /** pageUrl: 发起请求的页面 URL */
  pageUrl?: string;
  /** 额外 HTTP 头 (X- 前缀的自定义头) */
  [xHeader: string]: string | number | null | undefined;
}

/** 通过 Port 传递的下载请求 */
export interface DownloadRequestMessage {
  /** 1: HTTP 方法 */
  '1'?: string;
  /** 2: URL */
  '2': string;
  /** 3: 可选附加数据 */
  '3'?: string;
  /** 6: 类型 */
  '6'?: string;
  /** 7: 文件大小 */
  '7'?: number;
  /** 8: Content-Type */
  '8'?: string;
  /** 10: Content-Type */
  '10'?: string;
  /** 11: Content-Disposition */
  '11'?: string;
  /** fEx: 文件扩展名 */
  fEx?: string;
  /** fS: 文件大小 */
  fS?: number;
  /** fDu: 时长文本 */
  fDu?: string;
  /** postData: POST 请求体 */
  postData?: string;
  /** 额外 X- 前缀头 */
  [xHeader: string]: string | number | undefined;
}

/** webRequest 拦截阶段捕获的内部记录 (存储在 bg.U.m 映射中) */
export interface RequestRecord {
  /** requestId */
  id: number;
  /** URL */
  '2': string;
  /** tabId */
  tabId: number;
  /** frameId */
  frameId: number;
  /** 请求头列表 */
  o?: chrome.webRequest.HttpHeader[];
  /** 响应头列表 */
  B?: chrome.webRequest.HttpHeader[];
  /** 请求体 (原始) */
  ja?: chrome.webRequest.WebRequestBodyDetails['requestBody'];
  /** 响应 Content-Type */
  '8'?: string;
  /** 响应 Content-Length */
  '7'?: number;
  /** 请求方法 */
  '1'?: string;
  /** 资源类型 */
  type?: string;
  /** 协议 */
  protocol?: string;
  /** URL 路径文件名 */
  l?: string;
  /** 文件扩展名 */
  s?: string;
  /** filename 参数值 */
  K?: string;
  /** filename 参数的扩展名 */
  P?: string;
  /** Content-Disposition 是否 = attachment */
  ha?: boolean;
  /** 是否为 main_frame 或 sub_frame */
  R?: boolean;
  /** 内容类型推断的扩展名 */
  O?: string;
  /** 最终推断扩展名 */
  g?: string;
  /** 最终文件名 */
  fileName?: string;
}

// -----------------------------------------------------------------------------
// 媒体面板相关类型 (ct.js)
// -----------------------------------------------------------------------------

/** 检测到的可下载资源 */
export interface DetectedDownload {
  /** 哈希 ID */
  id: number;
  /** URL */
  '2': string;
  /** HTTP 方法 */
  '1'?: string;
  /** 文件扩展名 */
  fEx?: string;
  /** 显示标签 */
  '4'?: string;
  /** 文件大小 (字节) */
  fS?: number;
  /** 时长文本 */
  fDu?: string;
}

/** 媒体面板的位置信息 */
export interface PanelPosition {
  left: number;
  top: number;
}

/** 页面上的媒体元素信息 (VIDEO/AUDIO/OBJECT/EMBED) */
export interface MediaElementInfo {
  element: HTMLElement;
  src: string;
  width: number;
  height: number;
  area: number;
}

// -----------------------------------------------------------------------------
// 内容脚本与背景通信端口
// -----------------------------------------------------------------------------

/** 端口对象扩展状态 (ct.js 中的 N.D 映射) */
export interface PortConnectionState {
  /** 端口 ID */
  id: number;
  /** 标签页 URL */
  '2': string;
  /** 页面标题 */
  '4': string;
  /** tabId */
  tabId: number;
  /** frameId */
  frameId: number;
  /** 是否为主 frame */
  ia: boolean;
}

// -----------------------------------------------------------------------------
// 桌面应用通信
// -----------------------------------------------------------------------------

/** WebSocket 协议版本标识 */
export const WS_PROTOCOL = 'neatextension.v1';

/** WebSocket 服务端点 */
export const WS_ENDPOINT = 'ws://127.0.0.1:10007/download';

/** 桌面应用向扩展发送的 WebSocket 消息类型 */
export type DesktopAppMessage =
  | 'waiting'           // 桌面应用有等待队列
  | 'nowaiting'         // 桌面应用无等待队列
  | `Version:${string}` // 版本信息
  | `ShowPanelChrome=${'0' | '1'}`; // 控制媒体面板显示

// -----------------------------------------------------------------------------
// 存储 Schema
// -----------------------------------------------------------------------------

/** chrome.storage.local 键 */
export interface StorageSchema {
  /** ShowMediaPanel: 媒体面板开关 (-1=关闭, 1=开启) */
  ShowMediaPanel?: number;
}

// -----------------------------------------------------------------------------
// M3U8 / HLS 解析
// -----------------------------------------------------------------------------

/** M3U8 播放列表中的流条目 */
export interface HlsStreamEntry {
  /** 2: 流的完整 URL */
  2: string;
  /** tags: EXT-X-STREAM-INF 的标签参数 (带宽/分辨率) */
  tags: string;
}

// -----------------------------------------------------------------------------
// 枚举与常量
// -----------------------------------------------------------------------------

/** 被监听拦截的资源类型 */
export const MONITORED_TYPES = [
  'object',
  'xmlhttprequest',
  'media',
  'other',
  'main_frame',
  'sub_frame',
  'image',
] as const;
export type MonitoredType = (typeof MONITORED_TYPES)[number];

/** 总是拦截的下载类型 (即使没有 attachment 头) */
export const ALWAYS_DOWNLOAD_TYPES = ['object', 'xmlhttprequest', 'media', 'other'] as const;

/** 重定向状态码 */
export const REDIRECT_CODES = [301, 302, 303, 307, 308] as const;

/** 通过文件扩展名直接判定的视频/音频格式 */
export const MEDIA_EXTENSIONS = [
  'FLV', 'SWF', 'MP3', 'MP4', 'M4V', 'F4F', 'F4V', 'M4A', 'MPG', 'MPEG',
  'MPEG4', 'MPE', 'AVI', 'WMV', 'WMA', 'WAV', 'WAVE', 'ASF', 'RM', 'RAM',
  'OGG', 'OGV', 'OGM', 'OGA', 'MOV', 'MID', 'MIDI', '3GP', '3GPP', 'QT',
  'WEBM', 'TS', 'MKV', 'AAC', 'MP2T', 'MPEGTS', 'RMVB', 'VTT', 'SRT',
] as const;

/** 浏览器可渲染/不下载的扩展名 (黑名单) */
export const BROWSER_SAFE_EXTENSIONS = [
  'HTM', 'HTML', 'MHT', 'MHTML', 'SHTML', 'SHTM', 'XHT', 'XHTM', 'XHTML',
  'XML', 'TXT', 'CSS', 'JS', 'JSON', 'GIF', 'ICO', 'JPEG', 'JPG', 'PNG',
  'WEBP', 'BMP', 'SVG', 'TIF', 'TIFF', 'PDF', 'PHP', 'ASP', 'ASPX',
  'EOT', 'TTF', 'WOF', 'WOFF', 'WOFF2', 'MSG', 'PEM', 'BR', 'OTF',
  'ACZ', 'AZC', 'CGI', 'TPL', 'OSD', 'M3U8', 'DO', 'DICT',
] as const;

/** HLS 流式传输扩展名 (不直接下载) */
export const STREAMING_EXTENSIONS = ['F4F', 'MPEGTS', 'TS', 'MP2T'] as const;

/** 需特殊处理的域名模式 */
export const SPECIAL_HOSTS = ['vimeo.com', 'youtube.com', 'google.com', 'facebook.com'];
