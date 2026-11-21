// ============================================================
// SimpleUndoClose v3.0.1 — 类型定义 (dsv4 reverse engineering)
// ============================================================

// --------------------------------------------------
// 1. 用户设置
// --------------------------------------------------

/**
 * 用户可配置的设置项。
 * 默认值在 `defaultSettings` 中定义，使用 `chrome.storage.local` 持久化，
 * key 为 `"settings"`。
 */
export interface SimpleUndoCloseSettings {
  /** 是否在 popup 工具栏显示"清空"按钮 */
  showClear: boolean;
  /** 是否在工具栏图标上显示 badge (已关闭标签页计数) */
  showBadge: boolean;
  /** 是否显示每个标签页的关闭时间 */
  showTime: boolean;
  /** 是否在 popup 中显示搜索栏 */
  showSearch: boolean;
  /**
   * 搜索模式:
   *   1 — 仅在标题中搜索
   *   2 — 仅在 URL 中搜索
   *   3 — 在标题和 URL 中搜索
   */
  searchMode: 1 | 2 | 3;
  /** 是否使用粗体字体显示标题 */
  boldFont: boolean;
  /** 是否在浏览器关闭后保留已关闭标签页记录 (关闭后保存) */
  saveHistory: boolean;
  /** 搜索栏和按钮是否放在 popup 顶部 (true) 还是底部 (false) */
  menuTop: boolean;
  /** 是否禁用双击工具栏图标恢复最近关闭标签页的功能 */
  disableDClick: boolean;
  /** 悬浮提示显示页面标题而非 URL */
  tooltipText: boolean;
  /** 已关闭标签页的最大保存数量 (5–99994 指数映射) */
  numLimit: number;
  /** 每页最多显示的已关闭标签页条目数 (3–250) */
  numItems: number;
  /**
   * 每个条目最多显示的文字行数:
   *   0 — 不限制
   *   1—6 — 固定行数
   */
  numLines: number;
  /** 是否使用替代风格的工具栏按钮图标 */
  altBut: boolean;
  /** popup 窗口宽度 (px, 300–800) */
  wPop: number;
  /** 是否启用"移动时间到右端" (与 showTime 联动) */
  sexy: boolean;
  /**
   * 条目删除按钮样式:
   *   1 — 默认 (右侧叠层 X 按钮)
   *   2 — 经典 (左侧 X 按钮)
   *   3 — 无删除按钮
   */
  style: 1 | 2 | 3;
  /** 长按延迟时间 (秒, ≥1) */
  lpDelay: number;
  /** 中键点击后是否自动关闭 popup */
  mClickClose: boolean;
  /**
   * 主题:
   *   "1" — 跟随系统
   *   "2" — 强制亮色
   *   "3" — 强制暗色
   */
  theme: "1" | "2" | "3";
}

/**
 * 默认设置 — 在 Service Worker 内定义、安装时写入 storage.local。
 */
export const DEFAULT_SETTINGS: SimpleUndoCloseSettings = {
  showClear: true,
  showBadge: false,
  showTime: true,
  showSearch: true,
  searchMode: 1,
  boldFont: false,
  saveHistory: true,
  menuTop: false,
  disableDClick: true,
  tooltipText: true,
  numLimit: 10,
  numItems: 10,
  numLines: 1,
  altBut: false,
  wPop: 300,
  sexy: false,
  style: 1,
  lpDelay: 3,
  mClickClose: false,
  theme: "1",
};

// --------------------------------------------------
// 2. 存储 Schema
// --------------------------------------------------

/**
 * `chrome.storage.local` 中除 settings 外的所有持久化键。
 *
 * 键名 = 前缀:后缀 格式:
 *   - `TabList-{tabId}`          当前打开的标签页快照
 *   - `ClosedTab-{randomId}`     已关闭的标签页快照
 *   - `TabListIndex`             当前打开标签页的 tabId 索引
 *   - `ClosedTabIndex`           已关闭标签页的 randomId 索引
 *   - `dcTime`                   上次记录的日期时间戳
 *   - `updatedTill`              上次完成设置迁移的版本号
 */
export interface StorageSchema {
  /** 用户设置对象 */
  settings: SimpleUndoCloseSettings;
  /** 已关闭标签页的 ID 索引 (按关闭时间升序) */
  ClosedTabIndex: string[];
  /** 当前打开标签页的 Chrome tabId 索引 */
  TabListIndex: number[];
  /** 上次记录时间戳 (ms) */
  dcTime: number;
  /** 上次完成应用的设置迁移版本号 */
  updatedTill: string;

  // 动态键 (运行时创建，不在 settings 中)
  [key: `TabList-${number}`]: string;   // `url|!|title`
  [key: `ClosedTab-${string}`]: string; // `timestamp|!|url|!|title`
}

// --------------------------------------------------
// 3. 存储数据值的内部格式
// --------------------------------------------------

/**
 * TabList 记录值的内部格式。
 *
 * 格式: `{url}|!|{title}`
 * 分隔符: `|!|` (避免与 URL/标题中的特殊字符冲突)
 */
export type TabListValue = `${string}|!|${string}`;

/**
 * ClosedTab 记录值的内部格式。
 *
 * 格式: `{timestamp_ms}|!|{url}|!|{title}`
 * timestamp_ms: Date.now() (毫秒时间戳)
 */
export type ClosedTabValue = `${number}|!|${string}|!|${string}`;

// --------------------------------------------------
// 4. 消息协议
// --------------------------------------------------

/**
 * Popup / Options 向 Service Worker 发送的消息动作。
 */
export type MessageAction =
  | "getSettings"
  | "createTab"
  | "removeClosedTab"
  | "resetData"
  | "setBadge"
  | "updateIcon";

/**
 * popup.js → background.js 的 createTab 请求。
 */
export interface CreateTabMessage {
  action: "createTab";
  /** ClosedTab- 的随机 ID */
  id: string;
  /** 是否激活新标签页 (true) 还是后台打开 (false) */
  selected: boolean;
}

/**
 * popup.js → background.js 的 removeClosedTab 请求。
 */
export interface RemoveClosedTabMessage {
  action: "removeClosedTab";
  /** ClosedTab- 的随机 ID */
  id: string;
}

/**
 * options.js / popup.js → background.js 的 resetData 请求。
 */
export interface ResetDataMessage {
  action: "resetData";
}

/**
 * options.js → background.js 的 setBadge / updateIcon 请求。
 */
export interface UtilityMessage {
  action: "setBadge" | "updateIcon";
}

/**
 * dclick 简化消息 (仅传递字面量字符串)。
 */
export type DClickMessage = "dclick";

/**
 * 所有可能的运行时消息联合类型。
 */
export type RuntimeMessage =
  | DClickMessage
  | CreateTabMessage
  | RemoveClosedTabMessage
  | ResetDataMessage
  | UtilityMessage
  | { action: "getSettings" };

// --------------------------------------------------
// 5. UI 状态
// --------------------------------------------------

/**
 * popup.js 内部使用的运行时状态 (非持久化)。
 */
export interface PopupState {
  settings: SimpleUndoCloseSettings;
  /** 当前页码 (0 起始) */
  pageNo: number;
  /** 当前搜索关键词数组 */
  filterStrings: string[] | null;
  /** 是否处于长按/批量选择模式 */
  longpress: boolean;
  /** 长按模式下选中的条目 ID 集合 */
  chkArray: string[];
  /** 条目删除样式 (缓存自 settings.style) */
  delType: number;
  /** 长按延迟 (ms, 缓存自 settings.lpDelay) */
  lpdVal: number;
}

// --------------------------------------------------
// 6. 标签页快照数据结构
// --------------------------------------------------

/**
 * 由 addClosedTab 构造的标签页快照。
 * 存储在 `ClosedTab-{randomId}` 键下。
 */
export interface ClosedTabSnapshot {
  /** 6 字符随机 ID (Math.random().toString(36)) */
  id: string;
  /** 关闭时刻的时间戳 (ms) */
  timestamp: number;
  /** 标签页 URL */
  url: string;
  /** 标签页标题 (HTML 转义后) */
  title: string;
}

/**
 * 从 storage 值解析 ClosedTab 快照。
 * @param key   storage 键名 (如 "ClosedTab-abc123")
 * @param value storage 值 (如 "1700000000000|!|https://example.com|！|页面标题")
 */
export function parseClosedTabValue(key: string, value: ClosedTabValue): ClosedTabSnapshot {
  const parts = value.split("|!|");
  return {
    id: key.replace("ClosedTab-", ""),
    timestamp: Number(parts[0]),
    url: parts[1],
    title: parts[2],
  };
}

/**
 * 从 storage 值解析 TabList 记录。
 * @param value storage 值 (如 "https://example.com|！|页面标题")
 */
export function parseTabListValue(value: TabListValue): { url: string; title: string } {
  const parts = value.split("|!|");
  return { url: parts[0], title: parts[1] };
}
