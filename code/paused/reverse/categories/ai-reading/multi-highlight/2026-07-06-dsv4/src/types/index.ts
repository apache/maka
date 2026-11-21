// ============================================================
// Multi Highlight - TypeScript 类型定义
// 基于 Multi Highlight v2.11.1 Chrome 扩展逆向工程
// 源文件：原生 JavaScript（无打包器/无框架）
// ============================================================

// ============================================================
// 核心数据实体
// ============================================================

/**
 * 关键词对象
 * 每个关键词关联一个颜色分组 (kwGrp)，用于在页面中区分不同关键词的高亮颜色
 */
export interface Keyword {
  /** 颜色分组编号 (0-19)，对应 highlight.css 中定义的 20 种颜色 */
  kwGrp: number;
  /** 关键词字符串 */
  kwStr: string;
}

// ============================================================
// 标签页状态
// ============================================================

/**
 * 标签页信息
 * 每个标签页独立维护自己的关键词列表和状态
 * 通过 storage key `multi-highlight_{tabId}` 存储
 */
export interface TabInfo {
  /** Chrome 标签页 ID */
  id: number;
  /** 当前标签页的关键词列表 */
  keywords: Keyword[];
}

// ============================================================
// 扩展设置
// ============================================================

/**
 * Multi Highlight 核心设置
 * 存储在 chrome.storage.local 的 `settings` key 下
 */
export interface Settings {
  /** 可用高亮颜色数量 */
  CSS_COLORS_COUNT: number;
  /** CSS 类名前缀 1: 顶层容器类 */
  CSSprefix1: string;
  /** CSS 类名前缀 2: 颜色样式类前缀 */
  CSSprefix2: string;
  /** CSS 类名前缀 3: 关键词编码类 */
  CSSprefix3: string;

  // ---- 搜索设置 ----

  /** 关键词分隔符（默认为 ","） */
  delim: string;
  /** 是否在页面内容变化时自动重新高亮 */
  isAlwaysSearch: boolean;
  /** 扩展是否启用 */
  isOn: boolean;
  /** 是否区分大小写搜索 */
  isCasesensitive: boolean;
  /** 是否即时搜索（输入时实时高亮） */
  isInstant: boolean;
  /** 是否按换行切换高亮颜色（否则按每个关键词切换颜色） */
  isNewlineNewColor: boolean;
  /** 是否在新标签页中保留关键词列表 */
  isSaveKws: boolean;
  /** 是否全词匹配 */
  isWholeWord: boolean;
  /** 最近的关键词列表 */
  latest_keywords: Keyword[];
  /** jQuery highlight 插件使用的 DOM 元素标签名 */
  element: string;

  // ---- 右键菜单设置 ----

  /** 是否启用右键菜单"添加关键词" */
  enableAddKw: boolean;
  /** 是否启用右键菜单"移除关键词" */
  enableRemoveKw: boolean;
}

/**
 * 设置默认值（安装时初始化）
 */
export const DEFAULT_SETTINGS: Partial<Settings> = {
  CSS_COLORS_COUNT: 20,
  CSSprefix1: "chrome-extension-FindManyStrings",
  CSSprefix2: "chrome-extension-FindManyStrings-style-",
  CSSprefix3: "CE-FMS-",
  delim: ",",
  isAlwaysSearch: true,
  isOn: true,
  isCasesensitive: false,
  isInstant: true,
  isNewlineNewColor: false,
  isSaveKws: true,
  isWholeWord: false,
  latest_keywords: [],
  element: "mh",
  enableAddKw: true,
  enableRemoveKw: true,
};

/**
 * Popup 窗口尺寸配置
 * 存储在 chrome.storage.local 的 `popupConfig` key 下
 */
export interface PopupConfig {
  /** Popup 窗口宽度 (px)，允许范围 [400, 760] */
  popup_width: number;
  /** Popup 文本域高度 (px)，允许范围 [40, 500] */
  popup_height: number;
}

/**
 * Popup 默认尺寸
 */
export const DEFAULT_POPUP_CONFIG: PopupConfig = {
  popup_width: 400,
  popup_height: 100,
};

// ============================================================
// 消息通信类型
// ============================================================

/**
 * 后台 Service Worker 消息类型
 * 使用 chrome.runtime.sendMessage / chrome.tabs.sendMessage 传递
 */
export const BackgroundAction = {
  /** 获取当前标签页 ID */
  GET_TAB_ID: "getTabId",
  /** 切换"添加关键词"上下文菜单 */
  HANDLE_ADD_KW_CHANGE: "handle_addKw_change",
  /** 切换"移除关键词"上下文菜单 */
  HANDLE_REMOVE_KW_CHANGE: "handle_removeKw_change",
  /** 调整 Popup 窗口尺寸 */
  HANDLE_POPUP_SIZE_CHANGE: "handle_popupSize_change",
} as const;

/**
 * Content Script 操作类型
 * 从 background/popup 发往 content script
 */
export const ContentAction = {
  /** 清除当前标签页所有高亮 */
  HL_CLEARALL: "hl_clearall",
  /** 刷新高亮（先清除再全部重建） */
  HL_REFRESH: "hl_refresh",
  /** 使用现有关键词刷新高亮 */
  HL_REFRESH_EXISTING: "hl_refresh_existing",
  /** 增量添加高亮（仅对新增关键词执行高亮） */
  HL_SEARCH: "_hl_search",
  /** 增量移除高亮（仅移除指定关键词的高亮） */
  HL_CLEAR: "_hl_clear",
} as const;

/**
 * 获取页面可见文本
 * getPagesSource.js 注入页面后发送此消息
 */
export const PageSourceAction = {
  GET_VISIBLE_TEXT: "getVisibleText",
} as const;

/**
 * 消息基本结构
 */
export interface MessagePayload<T = unknown> {
  action: string;
  [key: string]: T;
}

/**
 * getTabId 响应
 */
export interface GetTabIdResponse {
  tabId: number;
}

/**
 * 高亮操作请求
 */
export interface HighlightRequest {
  action: typeof ContentAction[keyof typeof ContentAction];
  /** 需要添加的关键词列表 (hl_refresh, _hl_search) */
  inputKws?: Keyword[];
  /** 需要添加的关键词列表 (_hl_search) */
  addedKws?: Keyword[];
  /** 需要移除的关键词列表 (_hl_clear) */
  removedKws?: Keyword[];
}

/**
 * Popup 尺寸变化请求
 */
export interface PopupSizeChangeRequest {
  action: "handle_popupSize_change";
  newHeight: number | null;
  newWidth: number | null;
}

/**
 * 上下文菜单开关请求
 */
export interface ContextMenuToggleRequest {
  action: "handle_addKw_change" | "handle_removeKw_change";
  enableIt: boolean;
}

// ============================================================
// 高亮操作选项
// ============================================================

/**
 * handle_highlightWords_change 函数的选项参数
 */
export interface HighlightWordsChangeOptions {
  /** 是否强制刷新（重建所有高亮） */
  refresh?: boolean;
  /** 是否使用已保存的关键词（而非 textarea 中的内容） */
  useSavedKws?: boolean;
  /** 调用来源是否为 popup 或 background（用于控制 UI 重建） */
  fromBgOrPopup?: boolean;
}

// ============================================================
// Context Menu 类型
// ============================================================

/**
 * 右键菜单 ID
 */
export const ContextMenuId = {
  ADD_KEYWORD: "addKw",
  REMOVE_KEYWORD: "removeKw",
} as const;

/**
 * 右键菜单点击信息
 */
export interface ContextMenuClickInfo {
  /** 菜单项 ID */
  menuItemId: typeof ContextMenuId[keyof typeof ContextMenuId];
  /** 选中的文本 */
  selectionText: string;
}

// ============================================================
// Storage Key 工具
// ============================================================

/**
 * 标签页存储 Key 生成函数
 * @param tabId Chrome 标签页 ID
 * @returns 存储 key，格式为 "multi-highlight_{tabId}"
 */
export type GetTabKey = (tabId: number) => string;

/**
 * 从存储 key 还原标签页 ID
 * @param tabkey 存储 key
 * @returns Chrome 标签页 ID
 */
export type GetTabId = (tabkey: string) => number;

// ============================================================
// Badge 状态
// ============================================================

/**
 * 扩展图标 Badge 状态
 */
export type BadgeStatus = "normal" | "error";

// ============================================================
// jQuery Highlight 插件配置
// ============================================================

/**
 * jQuery.fn.highlight 插件选项
 * 对应 jquery.highlight.js 中的配置
 */
export interface HighlightPluginOptions {
  /** 高亮包裹元素的 CSS 类名 */
  className: string;
  /** 高亮包裹元素的 HTML 标签名 */
  element: string;
  /** 是否区分大小写 */
  caseSensitive: boolean;
  /** 是否仅匹配全词 */
  wordsOnly: boolean;
  /** 单词边界正则模式 */
  wordsBoundary?: string;
  /** 单词边界起始模式 */
  wordsBoundaryStart?: string;
  /** 单词边界结束模式 */
  wordsBoundaryEnd?: string;
  /** 是否忽略变音符号 */
  ignoreDiacritics?: boolean;
}

/**
 * jQuery.fn.unhighlight 插件选项
 */
export interface UnhighlightPluginOptions {
  /** 需要移除高亮的 CSS 类名（支持通配符匹配） */
  className: string;
  /** 高亮包裹元素的 HTML 标签名 */
  element: string;
}

// ============================================================
// MutationObserver 配置
// ============================================================

/**
 * Content Script 中 MutationObserver 的配置
 */
export const MUTATION_OBSERVER_CONFIG: MutationObserverInit = {
  /** 监听子节点变化 */
  childList: true,
  /** 监听整个子树 */
  subtree: true,
  /** 监听文本内容变化 */
  characterData: true,
};

// ============================================================
// 扩展常量
// ============================================================

/**
 * 扩展数据存储相关常量
 */
export const EXTENSION_CONSTANTS = {
  /** 可用高亮颜色数 */
  COLORS_COUNT: 20,
  /** Popup 最小宽度 (px) */
  POPUP_MIN_WIDTH: 400,
  /** Popup 最大宽度 (px) */
  POPUP_MAX_WIDTH: 760,
  /** Popup 最小高度 (px) */
  POPUP_MIN_HEIGHT: 40,
  /** Popup 最大高度 (px) */
  POPUP_MAX_HEIGHT: 500,
  /** 右键菜单初始化延迟 (ms) */
  INACTIVITY_TIMEOUT: 300,
  /** Storage key 前缀 */
  STORAGE_KEY_PREFIX: "multi-highlight_",
  /** 默认存储 key：设置 */
  STORAGE_KEY_SETTINGS: "settings",
  /** 默认存储 key：Popup 配置 */
  STORAGE_KEY_POPUP_CONFIG: "popupConfig",
} as const;
