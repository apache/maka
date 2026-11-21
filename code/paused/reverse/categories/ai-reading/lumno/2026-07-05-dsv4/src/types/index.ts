// ============================================================================
// Lumno - 聚焦搜索新标签页 (v0.9.14) — TypeScript 类型定义
// 此文件基于对已解包扩展源码的逆向分析生成，仅供学习和参考。
// ============================================================================

// ---- 搜索源 -----------------------------------------------------------------

/** 搜索引擎类别 */
export type SearchSourceType = 'google' | 'baidu' | 'bing' | 'duckduckgo';

/** 站点搜索提供商（快捷网站搜索） */
export interface SiteSearchProvider {
  key: string;                    // 短键，如 "yt", "gh"
  aliases: string[];              // 别名列表
  name: string;                   // 显示名称
  template: string;               // 搜索 URL 模板，{query} 占位
  action?: string;                // 特殊动作，如 "openAndSubmit"
  submitStrategy?: string;        // AI 对话网站的提交策略
  iconUrl?: string;               // 图标 URL
  icon?: string;                  // 内联图标
  disabled?: boolean;
  disabledReason?: string;
}

/** 搜索结果来源类型 */
export type SuggestionSourceType = 'topSite' | 'bookmark' | 'history' | 'directUrl' | 'browserPage' | 'autocomplete';

/** 搜索意图分类 */
export type SearchIntentType = 'navigation' | 'brand' | 'path' | 'revisit' | 'object';

/** 搜索建议项 */
export interface SearchSuggestion {
  type: SuggestionSourceType;
  title: string;
  url: string;
  favicon: string;
  score: number;
  lastVisitTime: number;
  visitCount: number;
  typedCount: number;
  reasons: string[];
  isTopSite?: boolean;
  isSyntheticDirect?: boolean;
  _xMatchedTabId?: number;
  selectionBoost?: number;
}

/** 搜索查询上下文 */
export interface SearchQueryContext {
  lookupQuery: string;
  queryLower: string;
  normalizedPinyinQuery: string;
  useTitlePinyinMatch: boolean;
  coreQueryTerms: string[];
  queryTerms: string[];
  intentType: SearchIntentType;
  hasSettingsIntent: boolean;
  hasInformationalIntent: boolean;
}

/** 搜索结果选择统计条目 */
export interface SearchSelectionEntry {
  url: string;
  title: string;
  type: SuggestionSourceType;
  count: number;
  lastSelectedAt: number;
}

/** 搜索结果选择统计 */
export interface SearchSelectionStats {
  version: number;
  updatedAt: number;
  queries: Record<string, {
    updatedAt: number;
    entries: Record<string, SearchSelectionEntry>;
  }>;
}

// ---- 壁纸 -----------------------------------------------------------------

/** 壁纸对象 */
export interface Wallpaper {
  id: string;
  name: string;
  theme: 'light' | 'dark';
  url: string;
  thumbUrl: string;
  artist?: string;
  source?: string;
  tags?: string[];
}

/** 壁纸效果 */
export type WallpaperEffect = 'none' | 'halftone' | 'ascii';

/** 壁纸存储状态 */
export interface WallpaperState {
  activeId: string | null;
  overlayOpacity: number;
  effect: WallpaperEffect;
  customUrl?: string;
}

// ---- 快捷方式 ---------------------------------------------------------------

/** 浏览器内部页面快捷方式 */
export interface BrowserPageShortcut {
  type: 'browserPage';
  keys: string[];      // 匹配关键词（多语言）
  path: string;        // chrome:// 路径片段
}

/** URL 快捷方式 */
export interface UrlShortcut {
  type: 'url';
  keys: string[];
  url: string;
}

export type ShortcutRule = BrowserPageShortcut | UrlShortcut;

// ---- 书签 -----------------------------------------------------------------

/** 扩展使用的书签节点（扁平化） */
export interface BookmarkNode {
  id: string;
  parentId: string;
  title: string;
  url?: string;
  children?: BookmarkNode[];
  dateAdded?: number;
  dateGroupModified?: number;
  index?: number;
}

// ---- 最近访问站点 -----------------------------------------------------------

/** 最近访问/常用站点 */
export interface RecentSite {
  title: string;
  url: string;
  favicon?: string;
  lastVisitTime?: number;
  isPinned?: boolean;
  isHidden?: boolean;
}

// ---- 标签页切换器 -----------------------------------------------------------

/** 标签页切换器的标签项 */
export interface SwitcherTabItem {
  id: number;
  title: string;
  url: string;
  favicon: string;
  windowId: number;
  active: boolean;
  thumbnail: string;           // base64 缩略图
  thumbnailStatus: string;     // 'ok' | 'missing' | 'restricted' | 'pending' | 'stale' | 'failed'
  thumbnailReason: string;
  lastAccessed: number;
}

// ---- 标签页切换统计 ---------------------------------------------------------

export interface TabSwitchStat {
  events: number[];            // 切换时间戳数组
  lastSwitchAt: number;
}

export interface TabSwitchRank {
  score: number;
  shortCount: number;          // 近 30 分钟切换次数
  dayCount: number;            // 近 24 小时切换次数
  highFreq: boolean;
  hint: string;
  lastSwitchAt: number;
}

// ---- PiP（画中画）相关 -------------------------------------------------------

/** PiP 所有权状态 */
export interface PipOwnershipState {
  ownerTabId: number | null;
  ownerKind: string;
  grantedAt: number;
}

/** PiP 所有权请求结果 */
export interface PipOwnershipResult {
  ok: boolean;
  granted: boolean;
  reason: string;
}

// ---- 主题 -----------------------------------------------------------------

export type ThemeMode = 'light' | 'dark' | 'system';
export type LanguageCode = 'zh_CN' | 'zh_TW' | 'ja' | 'en';

/** 新标签页宽度模式 */
export type NewtabWidthMode = 'wide' | 'standard';

/** 覆盖层尺寸模式 */
export type OverlaySizeMode = 'compact' | 'standard' | 'large';

/** 搜索结果优先级模式 */
export type SearchResultPriority = 'search' | 'autocomplete';

// ---- 存储键 ---------------------------------------------------------------

/** 扩展存储键命名空间 */
export const STORAGE_KEYS = {
  themeMode: '_x_extension_theme_mode_2024_unique_',
  language: '_x_extension_language_2024_unique_',
  languageMessages: '_x_extension_language_messages_2024_unique_',
  recentMode: '_x_extension_recent_mode_2024_unique_',
  recentCount: '_x_extension_recent_count_2024_unique_',
  newtabWidthMode: '_x_extension_newtab_width_mode_2026_unique_',
  newtabSearchWidth: '_x_extension_newtab_search_width_2026_unique_',
  newtabWordmarkVisible: '_x_extension_newtab_wordmark_visible_2026_unique_',
  newtabThemeMode: '_x_extension_newtab_theme_mode_2026_unique_',
  newtabThemeScope: '_x_extension_newtab_theme_scope_2026_unique_',
  newtabWallpaper: '_x_extension_newtab_wallpaper_2026_unique_',
  newtabWallpaperOverlay: '_x_extension_newtab_wallpaper_overlay_2026_unique_',
  newtabWallpaperEffect: '_x_extension_newtab_wallpaper_effect_2026_unique_',
  overlaySizeMode: '_x_extension_overlay_size_mode_2026_unique_',
  bookmarkCount: '_x_extension_bookmark_count_2024_unique_',
  bookmarkColumns: '_x_extension_bookmark_columns_2024_unique_',
  pinnedRecentSites: '_x_extension_newtab_pinned_recent_sites_2026_unique_',
  hiddenRecentSites: '_x_extension_newtab_hidden_recent_sites_2026_unique_',
  restrictedAction: '_x_extension_restricted_action_2024_unique_',
  overlayTabPriority: '_x_extension_overlay_tab_priority_2024_unique_',
  tabRankScoreDebug: '_x_extension_tab_rank_score_debug_2026_unique_',
  autoPipEnabled: '_x_extension_auto_pip_enabled_2026_unique_',
  tabSwitcherEnabled: '_x_extension_tab_switcher_enabled_2026_unique_',
  documentPipEnabled: '_x_extension_document_pip_enabled_2026_unique_',
  pinnedTabRecoveryEnabled: '_x_extension_pinned_tab_recovery_enabled_2026_unique_',
  fallbackShortcut: '_x_extension_fallback_hotkey_2024_unique_',
  searchResultPriority: '_x_extension_search_result_priority_2026_unique_',
  searchResultSourceTypes: '_x_extension_search_result_source_types_2026_unique_',
  searchSelectionStats: '_x_extension_search_selection_stats_2026_unique_',
  tabSwitcherState: '_x_extension_tab_switcher_state_2026_unique_',
  tabSwitchStats: '_x_extension_tab_switch_stats_2026_unique_',
  pinnedTabSnapshot: '_x_extension_pinned_tab_snapshot_2026_unique_',
} as const;

// ---- 消息路由 ---------------------------------------------------------------

/** 后台消息动作名称 */
export type BackgroundMessageAction =
  | 'getShowSearchShortcut'
  | 'triggerShowSearchFromPageHotkey'
  | 'getLocaleMessages'
  | 'reportTabVisible'
  | 'copyCurrentPageUrlFromCommand'
  | 'registerTabSwitcherExtensionPage'
  | 'setTabSwitcherCaptureVisibility'
  | 'getOpenTabSwitcherState'
  | 'updateTabSwitcherThumbnail'
  | 'lumno:newtab-focus-input'
  | string;

/** 后台消息 */
export interface BackgroundMessage {
  action: BackgroundMessageAction;
  tabId?: number;
  source?: string;
  locale?: string;
  [key: string]: unknown;
}

/** 后台消息响应 */
export interface BackgroundMessageResponse {
  ok: boolean;
  [key: string]: unknown;
}

// ---- 扩展路由 ---------------------------------------------------------------

export const EXTENSION_ROUTES = {
  newtab: 'src/newtab/newtab.html',
  onboarding: 'src/onboarding/onboarding.html',
  options: 'src/options/options.html',
  optionsAppearance: 'src/options/options.html#appearance',
} as const;

// ---- 命令 -----------------------------------------------------------------

export const COMMANDS = {
  showSearch: 'show-search',                     // Ctrl+Shift+K
  showSearchPrefill: 'show-search-prefill',       // Ctrl+Shift+L
  showSearchPrefillV: 'show-search-prefill-v',    // Ctrl+Shift+C
  showTabSwitcher: 'show-tab-switcher',           // Alt+Q
} as const;

// ---- 覆盖层状态 -------------------------------------------------------------

export interface OverlayState {
  open: boolean;
  query: string;
  selectedIndex: number;
  mode: 'search' | 'tabSwitcher';
}
