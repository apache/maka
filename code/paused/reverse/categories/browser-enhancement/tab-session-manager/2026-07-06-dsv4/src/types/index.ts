// ========================================
// Tab Session Manager v7.3.0 — TypeScript 类型定义
// 基于 Webpack bundle 中的变量使用模式、存储键名
// 和 Chrome API 调用推断
// ========================================

// ========================================
// 核心数据实体
// ========================================

/** 会话标签页 */
export interface SessionTab {
  /** 页面 URL */
  url: string;
  /** 页面标题 */
  title: string;
  /** 网站图标 URL */
  favIconUrl: string;
  /** 标签页在窗口中的索引位置 */
  index: number;
  /** 是否固定 */
  pinned: boolean;
  /** 是否为活跃标签页 */
  active: boolean;
  /** 加载状态: loading | complete */
  status: string;
  /** Cookie 存储分区 ID (用于隐私窗口隔离) */
  cookieStoreId?: string;
  /** 所在窗口 ID */
  windowId?: number;
  /** 是否被静音 */
  mutedInfo?: { muted: boolean };
  /** 是否被丢弃 (lazy loading) */
  discarded?: boolean;
  /** 是否被选中 */
  selected?: boolean;
}

/** 会话窗口 */
export interface SessionWindow {
  /** 窗口数据库 ID */
  id: number;
  /** 窗口中的标签页列表 */
  tabs: SessionTab[];
  /** 窗口位置和尺寸 */
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  /** 窗口状态: normal | maximized | minimized | fullscreen */
  state?: string;
  /** 是否聚焦 */
  focused?: boolean;
  /** 标签组信息 */
  tabGroups?: TabGroup[];
  /** Tree Style Tab 树结构 */
  tstTree?: TSTNode;
}

/** 会话主体 */
export interface Session {
  /** 唯一标识符 (UUID v4) */
  id: string;
  /** 会话名称 */
  name: string;
  /** 窗口列表 */
  windows: SessionWindow[];
  /** 创建/保存日期 (ISO 8601) */
  date: string;
  /** 主标签 (单个) */
  tag?: string;
  /** 标签列表 */
  tags?: string[];
  /** 是否来自自动保存 */
  isAutoSave?: boolean;
  /** Google Drive 文件 ID (云端同步) */
  driveFileId?: string;
}

// ========================================
// 标签组与 Tree Style Tab
// ========================================

/** Chrome 标签组 */
export interface TabGroup {
  /** 标签组 ID */
  id: number;
  /** 标签组标题 */
  title: string;
  /** 颜色标识 */
  color: string;
  /** 是否折叠 */
  collapsed: boolean;
}

/** Tree Style Tab 节点 */
export interface TSTNode {
  id: number;
  children?: TSTNode[];
}

// ========================================
// 存储相关
// ========================================

/** chrome.storage.local 中的设置键名 */
export const SETTINGS_STORAGE_KEY = 'settings';

/** IndexedDB 数据库名称 */
export const DB_NAME = 'sessions';

/** IndexedDB Object Store 名称 */
export const DB_STORE_NAME = 'sessions';

/** 设置数据类型 */
export interface Settings {
  // === 通用 ===
  /** 是否在新窗口中打开会话 */
  ifOpenNewWindow: boolean;
  /** 是否启用标签页延迟加载 */
  ifLazyLoading: boolean;
  /** 使用 discarded 属性实现延迟加载 */
  isUseDiscarded: boolean;
  /** 恢复窗口位置 */
  isRestoreWindowPosition: boolean;
  /** 保存隐私窗口 */
  ifSavePrivateWindow: boolean;
  /** 忽略 URL 列表 (支持 * 通配符) */
  ignoreUrlList: string[];
  /** 保存设备名称到会话 */
  shouldSaveDeviceName: boolean;
  /** 设备名称 */
  deviceName: string;
  /** 支持 Tree Style Tab */
  ifSupportTst: boolean;
  /** TST 恢复延迟 (毫秒) */
  tstDelay: number;
  /** 保存标签组 */
  saveTabGroups: boolean;
  /** 截断标题到单行 */
  truncateTitle: boolean;
  /** 压缩 favicon URL */
  compressFaviconUrl: boolean;

  // === 启动行为 ===
  /** 启动行为: 'openPreviousSession' | 'openStartupSession' | 'doNothing' */
  startupBehavior: StartupBehavior;
  /** 启动时打开上次会话 */
  ifOpenLastSessionWhenStartUp: boolean;

  // === 自动保存 ===
  /** 定期保存会话 */
  ifAutoSave: boolean;
  /** 自动保存间隔 (分钟) */
  autoSaveInterval: number;
  /** 定期保存最大数量 */
  autoSaveLimit: number;
  /** 关闭窗口时保存 */
  ifAutoSaveWhenClose: boolean;
  /** 关闭窗口保存最大数量 */
  autoSaveWhenCloseLimit: number;
  /** 关闭窗口保存最小标签数 */
  autoSaveWhenCloseMinTabs: number;
  /** 退出浏览器时保存 */
  ifAutoSaveWhenExitBrowser: boolean;
  /** 退出浏览器保存最大数量 */
  autoSaveWhenExitBrowserLimit: number;
  /** 使用页面标题作为自动保存会话名 */
  useTabTitleforAutoSave: boolean;

  // === 追踪 ===
  /** 追踪新打开的窗口 */
  shouldTrackNewWindow: boolean;

  // === 备份 ===
  /** 启用备份 */
  ifBackup: boolean;
  /** 单独备份每个会话 */
  individualBackup: boolean;
  /** 备份保存文件夹 */
  backupFolder: string;
  /** 最大备份文件数 */
  backupFilesLimit: number;
  /** 日期格式 */
  dateFormat: string;

  // === 云端同步 ===
  /** 启用云端同步 (Beta) */
  enabledCloudSync: boolean;
  /** 自动同步 */
  enabledAutoSync: boolean;
  /** 同步自动保存的会话 */
  includesAutoSaveToSync: boolean;

  // === 弹窗 ===
  /** 打开按钮行为 */
  openButtonBehavior: OpenBehavior;
  /** 保存按钮行为 */
  saveButtonBehavior: SaveBehavior;
  /** 在会话列表中显示打开/删除按钮 */
  isShowOpenButtons: boolean;
  /** 弹窗宽度 */
  popupWidth: number;
  /** 弹窗高度 */
  popupHeight: number;
  /** 侧边栏宽度 */
  sidebarWidth: number;
  /** 在标签页中打开会话列表 */
  isSessionListOpenInTab: boolean;

  // === 主题 ===
  /** 主题: 'light' | 'dark' */
  theme: ThemeType;

  // === 其他 ===
  /** 更新时显示选项页 */
  isShowOptionsPageWhenUpdated: boolean;
  /** 启用调试模式 */
  isDebugMode: boolean;
}

/** 启动行为枚举 */
export type StartupBehavior =
  | 'openPreviousSession'
  | 'openStartupSession'
  | 'doNothing';

/** 打开行为枚举 */
export type OpenBehavior =
  | 'openInNewWindow'
  | 'openInCurrentWindow'
  | 'addToCurrentWindow';

/** 保存行为枚举 */
export type SaveBehavior =
  | 'saveAllWindows'
  | 'saveOnlyCurrentWindow';

/** 主题类型枚举 */
export type ThemeType = 'light' | 'dark';

// ========================================
// 自动保存类型
// ========================================

/** 自动保存来源 */
export type AutoSaveType =
  | 'windowClosed'
  | 'browserExited'
  | 'regular';

/** 自动保存类型的会话名称映射 */
export const AUTO_SAVE_NAMES: Record<AutoSaveType, string> = {
  windowClosed: 'Auto Save - Window closed',
  browserExited: 'Auto Save - Browser exited',
  regular: 'Auto Save - Regularly',
};

/** 自动保存简短名称映射 */
export const AUTO_SAVE_SHORT_NAMES: Record<AutoSaveType, string> = {
  windowClosed: 'Window closed',
  browserExited: 'Browser exited',
  regular: 'Regularly',
};

// ========================================
// 会话分类与排序
// ========================================

/** 会话分类过滤器 */
export type SessionFilter = 'all' | 'user' | 'auto';

/** 会话排序方式 */
export type SessionSort =
  | 'newest'
  | 'oldest'
  | 'aToZ'
  | 'zToA'
  | 'tabsDes'  // 最多标签
  | 'tabsAsc'; // 最少标签

// ========================================
// 消息通信
// ========================================

/** 后台 Service Worker 接收的消息类型 */
export type BackgroundMessage =
  | { message: 'requestAllSessions' }
  | { message: 'responseAllSessions'; sessions: Session[] }
  | { message: 'saveSession'; session: Session }
  | { message: 'deleteSession'; sessionId: string }
  | { message: 'updateSession'; session: Session }
  | { message: 'getCurrentSession' }
  | { message: 'saveCurrentSession'; name: string; allWindows: boolean }
  | { message: 'backupAllSessions' }
  | { message: 'backupIndividualSessions' }
  | { message: 'compressAllSessions'; port: number }
  | { message: 'updateCompressStatus'; status: CompressStatus; port: number }
  | { message: 'signInGoogle' }
  | { message: 'signOutGoogle' }
  | { message: 'updateSyncStatus'; status: SyncStatus; port: number }
  | { message: 'updateTrackingStatus'; status: TrackingStatus; port: number }
  | { message: 'updateUndoStatus'; status: UndoStatus; port: number }
  | { message: 'applyDeviceName' }
  | { message: 'importSessions'; sessions: Session[] }
  | { message: 'exportSessions' }
  | { message: 'deleteAllSessions' }
  | { message: 'migrateSessionsFromStorage' }
  | { message: 'startTracking'; sessionId: string }
  | { message: 'stopTracking'; sessionId: string }
  | { message: 'registerStartup'; sessionId: string }
  | { message: 'removeStartup'; sessionId: string };

/** Offscreen 文档消息 */
export type OffscreenMessage =
  | { message: 'offscreen_createObjectUrl'; sessions: Session[] }
  | { message: 'offscreen_revokeObjectUrl'; downloadUrl: string };

/** 压缩状态 */
export interface CompressStatus {
  status: 'idle' | 'compressing' | 'complete';
  count?: number;
  maxCount?: number;
  beforeSessionsSize?: number;
  afterSessionsSize?: number;
}

/** 同步状态 */
export type SyncStatus = 'syncing' | 'downloading' | 'uploading' | 'deleting';

/** 追踪状态 */
export type TrackingStatus = 'tracking' | 'stopped';

/** 撤销状态 */
export interface UndoStatus {
  sessionId: string;
  session: Session;
}

// ========================================
// Google Drive 云端同步
// ========================================

/** Google OAuth 令牌 */
export interface GoogleToken {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

/** Google Drive 文件元数据 */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
  modifiedTime: string;
}

/** Google 用户信息 */
export interface GoogleUserInfo {
  email: string;
}

// ========================================
// 导入/导出
// ========================================

/** 会话导出文件格式 (JSON) */
export interface ExportData {
  version: string;
  sessions: Session[];
  exportDate: string;
}

/** 导入支持的格式 */
export type ImportFormat =
  | 'tab-session-manager-json'   // 本扩展导出的 JSON
  | 'session-buddy-json'        // Session Buddy 格式
  | 'url-list';                 // 纯 URL 列表
