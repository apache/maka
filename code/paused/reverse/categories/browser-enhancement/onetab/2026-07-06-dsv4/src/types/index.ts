// ============================================================
// OneTab v2.18 — TypeScript 类型定义（从 minified JS 推断）
// ============================================================

// ---- 核心实体 ----

/** 标签页快照（存储在 OneTab 列表中） */
export interface TabItem {
  type: "tab";
  id: string; // 唯一 ID（22 字符 base64url）
  url: string;
  title: string;
  favicon?: string; // base64 PNG data URL
  /** 原始 tab 的 Chrome tab ID */
  tabId?: number;
  /** 原始 tab 的 group ID */
  groupId?: number;
  /** 在父组中的索引 */
  index?: number;
  /** tab 存储时间 */
  createdDate?: number;
  /** tab 域名 */
  domain?: string;
  /** 是否已读 */
  read?: boolean;
}

/** 项目组基础字段 */
export interface GroupItemBase {
  type: "group";
  id: string;
  label?: string;
  /** 子元素 ID 列表（有序） */
  childIds: string[];
  /** 父组 ID 列表（从根到直接父） */
  parentIds: string[];
  /** 创建时间 */
  createdDate?: number;
  /** 排序索引 */
  index?: number;
  /** 颜色标签（用于 tabGroup 类型） */
  color?: GroupColor;
  /** 是否归档 */
  archived?: boolean;
}

/** 文件夹组 */
export interface FolderGroup extends GroupItemBase {
  groupType: "folder";
}

/** 标签页组（对应 Chrome Tab Group） */
export interface TabGroup extends GroupItemBase {
  groupType: "tabGroup";
  color: GroupColor;
  /** Chrome tab group ID */
  chromeGroupId?: number;
}

/** 窗口组（存储一个窗口中的所有标签页） */
export interface WindowGroup extends GroupItemBase {
  groupType: "window";
}

/** 快速列表（固定显示的快捷入口） */
export interface QuickList extends GroupItemBase {
  groupType: "quickList";
}

/** 所有分组类型 */
export type GroupItem = FolderGroup | TabGroup | WindowGroup | QuickList;

/** 任意列表项 */
export type ListItem = TabItem | GroupItem;

/** 特殊的根节点（ID 固定为 "root"） */
export interface RootNode extends GroupItemBase {
  id: "root";
  groupType: "folder";
}

/** 特殊的回收站节点（ID 固定为 "trash"） */
export interface TrashNode extends GroupItemBase {
  id: "trash";
  groupType: "folder";
}

// ---- 任务与提醒 ----

export interface TaskInfo {
  task?: boolean;
  done?: boolean;
  notifyDate?: number;
  notify?: boolean;
  dueDate?: number;
  doneDate?: number;
  recurrence?: RecurrenceRule;
  recurrenceHistory?: RecurrenceHistory[];
}

export interface RecurrenceRule {
  type: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  days?: number[]; // day of week (0-6)
}

export interface RecurrenceHistory {
  date: number;
  action: "done" | "skip";
}

// ---- 分享功能 ----

export interface ShareInfo {
  shared?: boolean;
  shareExpiryDate?: number;
  shareIncludeNotes?: boolean;
  shareIncludeRatings?: boolean;
}

// ---- 笔记与标签 ----

export interface NotesInfo {
  notes?: {
    text?: string;
    format?: "plain" | "markdown";
  };
  ratings?: number;
}

// ---- 未提交变更（离线暂存） ----

export interface UncommittedChanges {
  [itemId: string]: {
    modifyDate: number;
    uncommittedChanges: Record<string, unknown>;
  };
}

// ---- 拖放操作类型 ----

export interface DropTarget {
  itemId: string;
  sourceParentId?: string;
  occurrence?: number;
}

// ---- 选项配置 ----

export interface OneTabOptions {
  /** 启动行为 */
  startupLaunch: "displayOneTab" | "none";
  /** 点击图标行为 */
  browserAction: "sendTabsInWindow" | "displayOneTab" | "sendCurrentTab" | "sendAllTabs";
  /** 固定标签页策略 */
  pinnedTabs: "ignore" | "include";
  /** 重复标签页策略 */
  duplicates: "allow" | "deduplicate";
  /** 重复时更新标题 */
  updateTitleOnDuplicate: "true" | "false";
  /** Popup 中最后选中的 section */
  lastManualPopupSectionSelection: "tabGroup" | "window" | "all";
  /** Popup: 包含固定标签页 */
  popupIncludePinnedTabs: "true" | "false";
  /** Popup: 包含已分组标签页 */
  popupIncludeGroupedTabs: "true" | "false";
  /** Popup: 包含已在列表中的标签页 */
  popupIncludeAlreadyStoredTabs: "true" | "false";
  /** Popup: 存储后打开 OneTab 页面 */
  popupOpenOneTabAfterStoringTabs: "true" | "false";
  /** Popup: 不关闭固定标签页 */
  popupDontClosePinnedTabs: "true" | "false";
  /** Popup: 不关闭已分组标签页 */
  popupDontCloseGroupedTabs: "true" | "false";
  /** Popup: 不关闭排除域名列表中的标签页 */
  popupDontCloseTabsFromExcludedDomains: "true" | "false";
  /** Popup: 关闭标签页后合并重复 */
  popupMergeCloseTabsAfter: "true" | "false";
  /** 导航列宽度 (px) */
  navColWidth: string;
  /** 导航列是否展开 */
  navColExpanded: "true" | "false";
  /** 快速访问列宽度 (px) */
  quickAccessColWidth: string;
  /** 快速访问列是否展开 */
  quickAccessColExpanded: "true" | "false";
  /** 快速访问列 section */
  quickAccessColSection: "quickList" | "all";
  /** OneTab 标签页是否固定 */
  oneTabTabPinned: "true" | "false";
  /** 新建组位置策略 */
  "popupCreateNewGroupInside-tab": "true" | "false";
  "popupCreateNewGroupInside-tabGroup": "true" | "false";
  "popupCreateNewGroupInside-window": "true" | "false";
  /** URL 显示方式 */
  urlDisplay: "none" | "domain" | "full";
  /** 主题 */
  theme: "auto" | "light" | "dark";
  /** 默认窗口组打开方式 */
  defaultWindowGroupOpenType: "newWindow" | "currentWindow";
  /** 打开后自动操作 */
  autoActionOnOpen: "trash" | "none";
  /** 切换到打开的标签页 */
  switchToOpenedTab: "true" | "false";
  /** 显示右键菜单 */
  displayContextMenu: "true" | "false";
  /** 打开时丢弃非活跃标签页 */
  discardNonActiveTabOnOpen: "false" | "true";
  /** 组标题点击行为 */
  groupTitleClickAction: "edit" | "expand";
  /** 导航树过滤 */
  navColTreeFilter: NavColTreeFilter;
  /** 复制到剪贴板的格式 */
  copyToClipboardFormat: "richText" | "plainText";
  /** 打开时将 OneTab 移至当前窗口 */
  moveOneTabToCurrentWindowOnOpen: "false" | "true";
  /** 分享过期时间 */
  shareExpiryPeriod: string;
  /** 分享时包含笔记 */
  shareIncludeNotes: "true" | "false";
  /** 分享时包含评分 */
  shareIncludeRatings: "true" | "false";
  /** v2 帮助是否显示过 */
  v2HelpShown: "true" | "false";
}

export interface NavColTreeFilter {
  namedOnly: boolean;
  foldersOnly: boolean;
  hideArchived: boolean;
}

// ---- 导出的存储 Schema ----

export interface OneTabStore {
  /** 主数据对象：所有 tab 和 group 的扁平映射（ID → item） */
  items?: Record<string, ListItem>;
  /** 根节点 */
  root?: RootNode;
  /** 回收站节点 */
  trash?: TrashNode;
  /** 快速列表 */
  quickList?: QuickList;
  /** 版本号 */
  version?: number;
  /** 选项 */
  options?: Partial<OneTabOptions>;
  /** 未提交变更暂存 */
  uncommittedChangesStore?: UncommittedChanges;
  /** 排除的域名列表（不自动存储的域名） */
  excludedDomains?: string[];
  /** 标签页排除域名 */
  tabExcludedDomains?: string[];
}

// ---- Chrome API 消息类型 ----

/** 从页面向 background service worker 发送的 RPC 消息 */
export interface PageToBackgroundMessage {
  type: string;
  Hp: boolean; // 内部标记（hard-protocol）
  args: unknown[];
  [key: string]: unknown;
}

/** Background 返回的 RPC 响应 */
export interface BackgroundResponse {
  result?: unknown;
  pong?: string; // 版本检查
  zp?: string; // 错误消息
}

/** State change 广播消息 */
export interface StateChangeMessage {
  type: "stateChange";
  s0: unknown; // state diff
}

// ---- Group Color（Chrome Tab Group 色彩） ----

export type GroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";

// ---- 主题 ----

export type Theme = "auto" | "light" | "dark";

// ---- 辅助类型 ----

export type ItemId = string;
export type ItemType = "tab" | "group";
export type GroupType = "folder" | "tabGroup" | "window" | "quickList";

/** RPC Core API 接口（根据代码中的代理推断） */
export interface CoreAPI {
  /** 获取 items */
  getItems(ids: string[]): Promise<ListItem[]>;
  /** 根据 groupId 获取树 */
  getTree(groupId: string): Promise<{ childIds: string[] }>;
  /** 移动 item */
  move(params: { dt: DropTarget[]; G: string; _?: number }): Promise<void>;
  /** 删除 item */
  deleteItems(ids: string[]): Promise<void>;
  /** 恢复 item */
  restoreItems(ids: string[]): Promise<void>;
  /** 创建空窗口组 */
  createWindowGroup(params: { G: string; _?: number }): Promise<string>;
  /** 获取子元素 */
  getChildren(groupId: string): Promise<ListItem[]>;
  /** 获取导航树 */
  getNavTree(): Promise<GroupItem[]>;
  /** 获取未提交变更 */
  getUncommittedChanges(key: string): Promise<Record<string, unknown> | undefined>;
  /** 设置未提交变更 */
  setUncommittedChanges(key: string, changes: Record<string, unknown>): Promise<void>;
  /** 清除未提交变更 */
  clearUncommittedChanges(): Promise<void>;
  /** 获取选项 */
  getOption(key: string): Promise<unknown>;
  /** 设置选项 */
  setOption(key: string, value: unknown): Promise<void>;
  /** 同步到服务器 */
  syncToServer(): Promise<void>;
  /** 从服务器同步 */
  syncFromServer(): Promise<void>;
  /** 分享 */
  share(params: { itemId: string }): Promise<string>;
  /** 取消分享 */
  unshare(itemId: string): Promise<void>;
  /** 导出 */
  exportData(): Promise<string>;
  /** 导入 */
  importData(data: string): Promise<void>;
  /** 版本检查 */
  corePing(): Promise<{ pong: string }>;
  /** 重启 */
  restart(): Promise<void>;
  /** 获取 locale */
  getLocale(): string;
  /** 获取 tabGroups API 可用性 */
  tabGroupsAvailable(): Promise<boolean>;
  /** 请求 tabGroups 权限 */
  requestTabGroupsPermission(): Promise<boolean>;
  /** 获取 tabGroup 中标签页数 */
  getTabGroupTabCount(groupId: number): Promise<number>;
  /** 获取 favicon */
  getFavicon(url: string): Promise<string>;
  /** 获取父路径 */
  getBreadcrumbs(groupId: string): Promise<GroupItem[]>;
  /** 获取 tab 的 groupId */
  getTabGroupId(tabId: number): Promise<number>;
  /** 批量操作确认 */
  confirmBulkAction(ids: string[]): Promise<string[]>;
  /** 设置 theme */
  setTheme(theme: Theme): Promise<void>;
  /** 获取 theme */
  getTheme(): Promise<Theme>;
  /** 检查更新 */
  checkForUpdate(): Promise<boolean>;
  /** 获取 tab 标签页数量统计 */
  getTabCount(groupId: string): Promise<number>;
  /** 获取 storage 使用量 */
  getStorageUsage(): Promise<number>;
  /** 获取 readingList */
  getReadingList(): Promise<TabItem[]>;
  /** 获取 bookmarks 树 */
  getBookmarkTree(): Promise<unknown>;
  /** 获取 placeholder URL */
  getPlaceholderUrl(url: string): Promise<string>;
  /** 操作 tabGroups 折叠状态 */
  collapseTabGroup(groupId: number, collapsed: boolean): Promise<void>;
  /** 获取存储的 tabGroups */
  getStoredTabGroups(): Promise<TabGroup[]>;
  /** 将 tabs 移入 group */
  addTabsToGroup(params: { tabIds: number[]; groupId: number }): Promise<void>;
  /** 发送所有标签页到 OneTab */
  sendAllTabs(params: { windowId?: number; includePinned?: boolean }): Promise<void>;
  /** 发送当前标签页到 OneTab */
  sendCurrentTab(): Promise<void>;
  /** 从回收站清除 */
  emptyTrash(): Promise<void>;
  [key: string]: (...args: unknown[]) => Promise<unknown>;
}

// ---- Manifest 类型 ----

export interface OneTabManifest {
  manifest_version: 3;
  name: string;
  description: string;
  version: string;
  default_locale: string;
  commands: Record<string, {
    suggested_key?: { default: string };
    description: string;
  }>;
  options_ui: { page: string; open_in_tab: boolean };
  optional_permissions: string[];
  permissions: string[];
  optional_host_permissions: string[];
  action: { default_icon: Record<string, string>; default_popup: string };
  omnibox: { keyword: string };
  background: { service_worker: string };
  content_security_policy: {
    extension_pages: string;
  };
}
