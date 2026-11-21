// ============================================================
// Codex DSV4 — 类型定义
// 基于 Codex v1.1.5 源码逆向分析
// ============================================================

// --- 原生消息通信相关 ---

/** 原生消息主机的命令结构 */
export interface CodexCommand {
  /** 命令类型：CDP 操作、标签管理、页面控制等 */
  type: string;
  /** 目标标签页 ID */
  tabId?: number;
  /** CDP 方法名 (如 "Page.navigate", "Runtime.evaluate") */
  method?: string;
  /** CDP 方法参数 */
  params?: Record<string, unknown>;
  /** 会话 ID */
  sessionId?: string;
  /** 轮次 ID */
  turnId?: string;
  /** 其他动态参数 */
  [key: string]: unknown;
}

/** 原生消息主机响应结构 */
export interface CodexResponse {
  /** 请求是否成功 */
  ok: boolean;
  /** 错误信息 */
  error?: string;
  /** 响应数据 */
  data?: unknown;
  /** 关联的请求类型 */
  type?: string;
}

// --- 原生传输连接相关 ---

/** 原生传输连接状态 */
export type NativeHostStatus =
  | "connected"
  | "disconnected"
  | "connecting"
  | "reconnecting";

/** 原生消息传输实例 */
export interface NativeTransport {
  /** 原生应用标识 — 注册表项名 */
  application: string;
  /** 当前连接端口 */
  port: chrome.runtime.Port | null;
  /** 重连定时器 ID */
  reconnectTimeoutId: number | null;
  /** 是否正在等待重连 */
  reconnectPending: boolean;
  /** 当前重连尝试次数 */
  reconnectAttempt: number;
  /** 当前连接状态 */
  status: NativeHostStatus;
}

// --- 标签页上下文相关 ---

/** CDP 目标信息 */
export interface CDPTarget {
  id: string;
  title: string;
  url: string;
  type: "page" | "iframe" | "worker" | "other";
  attached: boolean;
  faviconUrl?: string;
}

/** 标签页上下文 (AI 可操作的浏览器状态单元) */
export interface TabContext {
  /** Chrome 标签页 ID */
  tabId: number;
  /** 窗口 ID */
  windowId: number;
  /** 标签页 URL */
  url: string;
  /** 页面标题 */
  title: string;
  /** 图标 URL */
  favIconUrl?: string;
  /** 标签是否激活 */
  active: boolean;
  /** 标签所在组 ID (undefined 表示未分组) */
  groupId?: number;
  /** CDP 调试器是否已附加 */
  debuggerAttached: boolean;
  /** 标签页索引 (窗口内位置) */
  index: number;
  /** 标签是否静音 */
  muted?: boolean;
  /** 标签是否被固定 */
  pinned: boolean;
  /** 标签是否在阅读列表中 */
  inReadingList?: boolean;
  /** 标签是否被丢弃 (节省内存) */
  discarded: boolean;
}

// --- 浏览器整体状态相关 ---

/** 窗口信息 */
export interface WindowInfo {
  windowId: number;
  focused: boolean;
  tabs: TabContext[];
  state?: "normal" | "minimized" | "maximized" | "fullscreen";
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

/** 浏览器全局状态 (AI 可见的完整浏览器快照) */
export interface BrowserState {
  /** 所有窗口 */
  windows: WindowInfo[];
  /** 当前焦点窗口 ID */
  focusedWindowId: number;
  /** 当前激活标签页 ID */
  activeTabId: number;
  /** 所有标签组 */
  tabGroups: TabGroup[];
  /** 书签列表 */
  bookmarks?: BookmarkInfo[];
  /** 最近历史记录 */
  recentHistory?: HistoryEntry[];
  /** 下载列表 */
  downloads?: DownloadInfo[];
}

// --- 标签组相关 ---

/** 标签组信息 */
export interface TabGroup {
  /** 标签组 ID */
  groupId: number;
  /** 标题 */
  title: string;
  /** 颜色 */
  color: chrome.tabGroups.ColorEnum;
  /** 是否折叠 */
  collapsed: boolean;
  /** 所属窗口 ID */
  windowId: number;
}

// --- 书签/历史/下载相关 ---

/** 书签信息 */
export interface BookmarkInfo {
  id: string;
  title: string;
  url?: string;
  parentId?: string;
  index?: number;
  dateAdded?: number;
}

/** 历史记录条目 */
export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  lastVisitTime: number;
  visitCount: number;
  typedCount: number;
}

/** 下载信息 */
export interface DownloadInfo {
  id: number;
  url: string;
  filename: string;
  state: "in_progress" | "interrupted" | "complete";
  bytesReceived: number;
  totalBytes: number;
  mime?: string;
  startTime?: string;
  endTime?: string;
}

// --- AI 代理控制相关 ---

/** Agent 光标状态 */
export interface AgentCursorState {
  /** 光标是否可见 */
  visible: boolean;
  /** 光标 X 坐标 (视口坐标) */
  x: number;
  /** 光标 Y 坐标 (视口坐标) */
  y: number;
  /** 是否启用平移动画 */
  animateMovement?: boolean;
  /** 移动序列号 (用于动画编排) */
  moveSequence?: number;
}

/** Agent 光标事件 */
export interface AgentCursorEvent {
  type: "AGENT_CURSOR_STATE" | "AGENT_CURSOR_ARRIVED" | "GET_AGENT_CURSOR_STATE";
  state?: AgentCursorState;
  moveSequence?: number;
  sessionId?: string;
  turnId?: string;
  ok?: boolean;
}

// --- 内容脚本通信相关 ---

/** 内容脚本 Ping 消息 */
export interface ContentPingMessage {
  type: "CONTENT_PING";
}

/** Favicon 徽章消息 */
export interface FaviconBadgeMessage {
  type: "TAB_FAVICON_BADGE";
  badge?: "active" | "deliverable" | "handoff";
  faviconDataUrl?: string;
}

/** Favicon 徽章批量消息 */
export interface FaviconBadgesMessage {
  type: "TAB_FAVICON_BADGES";
  badges: Record<number, { badge: string; faviconDataUrl?: string }>;
}

// --- 会话相关 ---

/** AI 会话标识 */
export interface SessionInfo {
  sessionId: string;
  turnId?: string;
  tabId?: number;
  windowId?: number;
}

// --- 辅助类型 ---

/** JWT 令牌载荷 (推测) */
export interface JwtPayload {
  sub?: string;
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

/** CDP 事件 (从 debugger.onEvent 接收) */
export interface CDPEvent {
  tabId: number;
  sessionId: string;
  method: string;
  params: Record<string, unknown>;
}

/** 标签租约信息 (Codex 标签所有权机制) */
export interface TabLease {
  tabId: number;
  sessionId: string;
  acquiredAt: number;
}
