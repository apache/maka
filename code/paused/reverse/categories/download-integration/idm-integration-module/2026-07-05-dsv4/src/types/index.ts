// ============================================================
// IDM Integration Module — Reverse Engineering Type Definitions
// Based on v6.43.1 Chrome Extension Source (MV3)
// ============================================================

// --- IPC / Native Messaging ---

/**
 * Native message sent between the Chrome extension and the IDM desktop
 * application via `chrome.runtime.connectNative("com.tonec.idm")` or
 * WebSocket (fallback to ws://127.0.0.1:1001).
 *
 * Binary protocol over WebSocket uses a prefix-based framing format
 * (see background.js `qb` parser). Native messaging uses the standard
 * Chrome `postMessage` / `onMessage` pattern.
 */
export interface NativeMessage {
  /** Message sequence number (auto-incrementing per session) */
  seq: number;
  /** Message type discriminator (0-100+) */
  type: number;
  /** Flags bitfield */
  flags: number;
  /** Sub-type or secondary discriminator */
  subType: number;
  /** Positional parameters (array of integers) */
  params: number[];
  /** Named fields (key-value) */
  fields: Record<number, string | number>;
}

// --- Download Task ---

/**
 * Represents a download intercepted, queued, or managed by the extension.
 * Created in response to webRequest events (onBeforeRequest,
 * onHeadersReceived, etc.) and passed to the IDM desktop app.
 */
export interface DownloadTask {
  /** Internal unique ID assigned by the extension */
  id: string;
  /** Chrome download item ID (if created via downloads API) */
  downloadId?: number;
  /** Chrome tab ID where the request originated */
  tabId: number;
  /** Chrome frame ID */
  frameId: number;
  /** The request URL (may be rewritten to idmdwnlmfv9:// scheme) */
  url: string;
  /** The original URL before internal rewriting */
  originalUrl?: string;
  /** Referrer URL */
  referrer?: string;
  /** Page URL (the tab's top-level URL) */
  pageUrl?: string;
  /** Suggested filename (from Content-Disposition or URL path) */
  filename?: string;
  /** File extension derived from URL or Content-Type */
  extension?: string;
  /** MIME type from Content-Type header */
  mimeType?: string;
  /** HTTP status code */
  statusCode?: number;
  /** Content-Length in bytes (null if unknown) */
  totalBytes?: number | null;
  /** Bitmask flags: 1=HTML, 2=image, 4=video, 8=HTTPS, 16=QUIC, ... */
  flags: number;
  /** Action determined by the classifier (1=skip, 2=download, 4=sniff, etc.) */
  action: number;
  /** Request headers (name-value pairs) */
  requestHeaders?: Array<{ name: string; value?: string; binaryValue?: number[] }>;
  /** Response headers (name-value pairs) */
  responseHeaders?: Array<{ name: string; value?: string; binaryValue?: number[] }>;
  /** POST request body (if applicable) */
  requestBody?: string | ArrayBuffer | null;
  /** Cookie string for the request URL */
  cookies?: string;
  /** Time when the request was initiated (DOMHighResTimeStamp) */
  timeStamp?: number;
  /** Time when response started (for latency calculation) */
  responseTime?: number;
  /** Proxy configuration string */
  proxyInfo?: string;
}

// --- Media Info ---

/**
 * Media element information captured by the content script.
 * Sent from content.js to background.js for video/audio download
 * operations (YouTube, Vimeo, generic HTML5 media).
 */
export interface MediaInfo {
  /** Internal element ID (unique per session) */
  elementId: number;
  /** Element type: "video", "audio", "object", "embed" */
  elementType: string;
  /** Direct src/data URL of the media element */
  mediaUrl: string;
  /** Alternative URL (e.g., from child <source> elements) */
  altUrl?: string;
  /** Page title or media title extracted from the DOM */
  title: string;
  /** Title source hint (e.g., 80=document.title, 70=og:title, 130=Opera) */
  titleSource?: number;
  /** Bounding rectangle [left, top, right, bottom, devicePixelRatio] */
  rect?: [number, number, number, number, number];
  /** Whether the element is visible and not hidden */
  visible?: boolean;
  /** Internal flags (e.g., YouTube-specific) */
  flags?: number;
  /** YouTube video ID (if applicable) */
  youtubeVideoId?: string;
  /** Vimeo video ID (if applicable) */
  vimeoVideoId?: string;
  /** Generic site-specific player data blob */
  siteData?: Record<number, string>;
}

// --- Port Connection (Content Script <-> Background) ---

/**
 * Connection metadata for a content-script port.
 * Maintained in the background page's port registry (`this.m`).
 */
export interface ContentPort {
  /** Unique port ID (auto-increment) */
  id: number;
  /** Tab ID the port belongs to */
  tabId: number;
  /** Browser window ID */
  windowId?: number;
  /** Frame ID (0 = top-level) */
  frameId: number;
  /** Tab URL at time of connection */
  url: string;
  /** Whether this is the top-level frame */
  isTop: boolean;
  /** Site classifier result (YouTube=1, Vimeo=4, etc.) */
  classifierResult?: number;
  /** Runtime port object */
  port?: chrome.runtime.Port;
}

// --- Tab/Window State ---

/**
 * Per-window state tracked by the background service worker.
 */
export interface WindowState {
  /** Window ID */
  id: number;
  /** Active tab ID in this window */
  activeTabId: number;
  /** Window width */
  width: number;
  /** Window height */
  height: number;
  /** Window left offset */
  left: number;
  /** Window top offset */
  top: number;
  /** Device pixel ratio multiplier */
  devicePixelRatio: number;
  /** Title bar height (OS-dependent) */
  titleBarHeight: number;
  /** DPI scale factor */
  scaleFactor: number;
  /** Is popup/app window */
  isPopup: boolean;
  /** Is fullscreen */
  isFullscreen: boolean;
  /** Is maximized */
  isMaximized: boolean;
  /** Is minimized */
  isMinimized: boolean;
}

// --- Protocol Constants ---

/** URL scheme enum used for classifying request protocols */
export const enum UrlScheme {
  HTTP = 0,
  HTTPS = 8,
  FTP = 2,
  FTPS = 10,
  IDMREG = 12,
  IDMDWNLM = 14,
}

/** Download action classification results */
export const enum DownloadAction {
  SKIP = 1,
  DOWNLOAD = 2,
  SNIFF = 3,
  GRAB = 4,
  WEBPAGE = 5,
  REJECT = 6,
}

/** Message types for content-script <-> background IPC */
export const enum ContentMessageType {
  CONNECT_INFO = 21,
  TITLE_UPDATE = 24,
  MEDIA_ELEMENT = 22,
  MEDIA_DISCONNECT = 23,
  LINK_SEARCH_RESULT = 27,
  MOUSE_DOWN = 32,
  KEYBOARD_EVENT = 31,
  SCROLL = 29,
  RESIZE = 30,
  FRAME_ID = 25,
  FETCH_RESPONSE = 45,
  ROT13_ERROR = 36,
  SITE_DATA = 37,
}

/** Background message types for IDM desktop IPC */
export const enum NativeMessageType {
  HANDSHAKE = 2,
  CONFIG_SYNC = 4,
  WINDOW_INFO = 5,
  TAB_INFO = 6,
  DOWNLOAD_REQUEST = 13,
  LINK_SNIFF = 14,
  MEDIA_GRAB_START = 9,
  MEDIA_GRAB_STOP = 8,
  LINK_GRAB_PROGRESS = 10,
  PROXY_INFO = 1,
  FLV_FETCH = 16,
  BROWSER_INFO = 21,
}
