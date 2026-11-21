// ============================================================
// ContextSearch web-ext v1.48.4.13 - 逆向类型定义
// 基于 MV3 Chrome Extension 源码提取
// ============================================================

// ---- 节点树核心类型 ----

/** 上下文类型位掩码 (与 contexts.js contextCodes 一致) */
export enum ContextCode {
  Audio = 1,
  Frame = 2,
  Image = 4,
  Link = 8,
  Page = 16,
  Selection = 32,
  Video = 64,
}

/** 上下文名称 */
export type ContextName = 'audio' | 'frame' | 'image' | 'link' | 'page' | 'selection' | 'video';

/** 打开方式枚举 */
export type OpenMethod =
  | 'openCurrentTab'
  | 'openNewTab'
  | 'openBackgroundTab'
  | 'openBackgroundTabKeepOpen'
  | 'openNewWindow'
  | 'openNewIncognitoWindow'
  | 'openSideBarAction'
  | 'openPopup'
  | 'noAction'
  | 'openFolder'
  | 'keepMenuOpen';

/** 节点基础类型 */
export interface NodeBase {
  id: string;
  title: string;
  hidden: boolean;
  icon?: string;
  iconCache?: string;
  keyword?: string;
  parentId?: string;
  hotkey?: number | null;
  shortcut?: ShortcutKey | null;
  parent?: NodeBase;
  toJSON?: () => object;
}

// ---- 搜索引擎 ----

/** POST 参数 */
export interface SearchParam {
  name: string;
  value: string;
}

/** 搜索引擎节点 */
export interface SearchEngine extends NodeBase {
  type: 'searchEngine';
  template: string;                    // 搜索 URL 模板，支持 {searchTerms} 占位符
  method: 'GET' | 'POST';            // HTTP 方法
  params: SearchParam[];              // POST 参数
  queryCharset: string;               // 编码字符集 (默认 UTF-8)
  searchForm?: string;                // 搜索表单/落地页 URL
  searchRegex?: string;               // 搜索词替换正则
  matchRegex?: string;                // 匹配正则 (用于自动关联)
  searchCode?: string;                // 页面加载后执行的 JS 代码
  description?: string;              // 描述
  order?: number;                    // 排序
  contexts: number;                   // 上下文位掩码
  iconCache?: string;                // Base64 缓存的图标
}

/** Firefox 一键搜索引擎 (原生 search API) */
export interface OneClickSearchEngine extends NodeBase {
  type: 'oneClickSearchEngine';
  contexts: number;
}

/** 书签脚本 / Bookmarklet */
export interface BookmarkletNode extends NodeBase {
  type: 'bookmarklet';
  searchCode: string;                 // JavaScript 代码
  contexts: number;
  description?: string;
}

/** 外部程序节点 (通过 Native Messaging 调用) */
export interface ExternalProgramNode extends NodeBase {
  type: 'externalProgram';
  path: string;                       // 命令行路径模板
  cwd?: string;                       // 工作目录
  searchRegex?: string;               // 搜索词替换正则
  postScript?: string;                // 执行后回调脚本
  contexts: number;
  description?: string;
}

/** 分隔符 */
export interface SeparatorNode extends NodeBase {
  type: 'separator';
}

/** 工具节点 */
export interface ToolNode extends NodeBase {
  type: 'tool';
  tool: string;                       // 工具名称，对应 QMtools 键
}

/** 文件夹节点 */
export interface FolderNode extends NodeBase {
  type: 'folder';
  children: AnyNode[];
  displayType?: 'grid' | 'text' | '';     // 显示方式
  groupFolder?: 'inline' | 'block' | '';   // 分组方式
  groupColor?: string;                      // 分组背景色
  groupColorText?: string;                  // 分组文字色
  groupLimit?: number;                      // 分组显示上限
  groupHideMoreTile?: boolean;              // 隐藏更多按钮
}

// ---- 节点联合类型 ----

export type AnyNode =
  | SearchEngine
  | OneClickSearchEngine
  | BookmarkletNode
  | ExternalProgramNode
  | SeparatorNode
  | ToolNode
  | FolderNode;

export type NodeType = AnyNode['type'];

/** 节点树根 */
export interface NodeTree {
  children: AnyNode[];
  [key: string]: unknown;
}

// ---- 快捷菜单 ----

/** 快捷键定义 */
export interface ShortcutKey {
  key: string;
  keyCode: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

/** 快捷菜单全局对象 (inject.js 中定义) */
export interface QuickMenuObject {
  keyDownTimer: number;
  mouseDownTimer: number | null;
  mouseCoords: { x: number; y: number };
  screenCoords: { x: number; y: number };
  mouseCoordsInit: { x: number; y: number };
  mouseLastClickTime: number;
  lastSelectTime: number;
  lastSelectText: string;
  locked: boolean;
  searchTerms: string;
  searchTermsObject: Record<string, string>;
  disabled: boolean;
  mouseDownTargetIsTextBox: boolean;
  mouseLastContextMenuTime: number;
  contexts: string[];
}

/** 快捷菜单布局位置 */
export type QuickMenuPosition =
  | 'top left' | 'top center' | 'top right'
  | 'middle left' | 'middle center' | 'middle right'
  | 'bottom left' | 'bottom center' | 'bottom right';

/** 快捷菜单配置 */
export interface QuickMenuConfig {
  enabled: boolean;
  /** 自动弹出配置 */
  auto: {
    enabled: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
  };
  /** 拖拽打开配置 */
  onDrag: {
    enabled: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
  };
  /** 鼠标按键打开配置 */
  onMouse: {
    enabled: boolean;
    method: 'click' | 'hold';
    button: 1 | 2 | 3;
    altKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    openWithoutSelection: boolean;
  };
  /** 悬浮图标配置 */
  icon: {
    enabled: boolean;
    url: string;
    x: number;
    y: number;
  };
  /** 键盘打开配置 */
  onKey: {
    enabled: boolean;
    key: ShortcutKey | null;
  };
  /** 简单点击打开配置 */
  onSimpleClick: {
    enabled: boolean;
    button: number;
    alt: boolean;
    ctrl: boolean;
    shift: boolean;
  };
  /** 布局 */
  position: QuickMenuPosition;
  offset: { x: number; y: number };
  columns: number;
  columnsMinimum: number;
  rows: number;
  rowsSingleColumn: number;
  scale: number;
  iconScale: number;
  defaultView: 'grid' | 'text';
  useCascadingFolders: boolean;
  /** 关闭行为 */
  closeOnClick: boolean;
  closeOnScroll: boolean;
  closeOnTabChange: boolean;
  closeOnEdit: boolean;
  /** 搜索动作 */
  leftClick: OpenMethod;
  middleClick: OpenMethod;
  rightClick: OpenMethod;
  shift: OpenMethod;
  ctrl: OpenMethod;
  alt: OpenMethod;
  folderLeftClick: OpenMethod;
  folderMiddleClick: OpenMethod;
  folderRightClick: OpenMethod;
  folderShift: OpenMethod;
  folderCtrl: OpenMethod;
  folderAlt: OpenMethod;
  /** 工具栏 */
  toolsPosition: 'top' | 'bottom' | 'hidden';
  toolsAsToolbar: boolean;
  /** 搜索栏 */
  searchBarFocus: boolean;
  searchBarSelect: boolean;
  /** 上下文布局 */
  useContextualLayout: boolean;
  contextualLayoutFlattenLimit: number;
  contextualLayoutToolbar: boolean;
  /** 启用场景（上下文类型开关） */
  autoOnInputs: boolean;
  onLinks: boolean;
  onImages: boolean;
  onAudios: boolean;
  onVideos: boolean;
  /** 快捷键 */
  searchHotkeys: OpenMethod;
  searchHotkeysFolders: OpenMethod;
}

// ---- 右键菜单 ----

/** 右键菜单规则 */
export interface ContextMenuRule {
  /** 启用右键菜单 */
  enabled: boolean;
  /** 显示设置子菜单 */
  showSettingsFolder: boolean;
  /** 显示添加自定义搜索 */
  showAddCustomSearch: boolean;
  /** 显示搜索整个文件夹 */
  showFolderSearch: boolean;
  /** 链接搜索方式 (text | url) */
  searchLinksAs: 'text' | 'url';
  /** 最近使用的引擎 */
  showRecentlyUsed: boolean;
  showRecentlyUsedAsFolder: boolean;
  showRecentlyUsedIcon: boolean;
  recentlyUsedListLength: number;
  /** 上下文感知布局 */
  useContextualLayout: boolean;
  contextualLayoutFlattenLimit: number;
  /** 正则匹配引擎 */
  regexMatchedEngines: boolean;
  /** 同步 Firefox 搜索 */
  syncWithFirefoxSearch: boolean;
  /** 热键 */
  key: string | null;
  /** 搜索动作 */
  click: OpenMethod;
  middleClick: OpenMethod;
  rightClick: OpenMethod;
  shift: OpenMethod;
  ctrl: OpenMethod;
  folderClick: OpenMethod;
  folderMiddleClick: OpenMethod;
  folderRightClick: OpenMethod;
  folderShift: OpenMethod;
  folderCtrl: OpenMethod;
  /** 标题模板 */
  title: string;
  /** 使用 innerText */
  useInnerText: boolean;
  /** 启用场景 */
  hotkeys: boolean;
  onLinks: boolean;
  onImages: boolean;
}

// ---- 高亮/查找栏 ----

/** 高亮标记选项 */
export interface MarkOptions {
  accuracy: 'partially' | 'exactly';
  separateWordSearch: boolean;
  ignorePunctuation: boolean;
  caseSensitive: boolean;
  limit: number;
}

/** 高亮配置 */
export interface HighlightConfig {
  enabled: boolean;
  followDomain: boolean;
  followExternalLinks: boolean;
  showFindBar: boolean;
  highlightStyle: 'background' | 'underline';
  /** 背景色数组 (4个 + active) */
  backgroundColors: string[];
  /** 文字色数组 (4个 + active) */
  textColors: string[];
  flashSelected: boolean;
  markOptions: MarkOptions;
  navBar: {
    enabled: boolean;
  };
  findBar: {
    startOpen: boolean;
    openInAllTabs: boolean;
    searchInAllTabs: boolean;
    highlightAllTabs: boolean;
    position: 'top' | 'bottom';
    windowType: 'docked' | 'undocked';
    scale: number;
    showNavBar: boolean;
    keyboardTimeout: number;
    markOptions: MarkOptions;
  };
}

// ---- 侧边栏 ----

/** 侧边栏配置 */
export interface SideBarConfig {
  startOpen: boolean;
  closeAfterSearch: boolean;
  openOnResults: boolean;
  openOnResultsMinimized: boolean;
  columns: number;
  scale: number;
  defaultView: 'grid' | 'text';
  widget: {
    enabled: boolean;
    position: 'left' | 'right';
  };
}

// ---- 搜索栏/Toolbar ----

/** 工具栏搜索栏配置 */
export interface SearchBarConfig {
  defaultView: 'grid' | 'text';
  columns: number;
  closeAfterSearch: boolean;
  icon: string;
  enableHistory: boolean;
  historyLength: number;
  suggestions: boolean;
  displayLastSearch: boolean;
}

// ---- Page Tiles ----

/** Page Tiles 配置 */
export interface PageTilesConfig {
  enabled: boolean;
  closeOnShake: boolean;
  closeOnBorder: boolean;
  rows: number;
  columns: number;
  paletteString: string;
  openMethod: OpenMethod;
}

// ---- 用户选项全集 ----

/** userOptions 顶层对象 (从 defaultUserOptions.js / storage.local 加载) */
export interface UserOptions {
  // 节点树
  nodeTree: NodeTree;

  // 搜索引擎列表 (旧版兼容)
  searchEngines: SearchEngine[];

  // 最近使用
  lastUsedId: string;
  lastOpeningMethod: OpenMethod;
  recentlyUsedList: string[];
  recentlyUsedListLength: number;

  // 快捷菜单
  quickMenu: boolean;
  quickMenuTools: QuickMenuToolConfig[];
  quickMenuAuto: boolean;
  quickMenuAutoAlt: boolean;
  quickMenuAutoCtrl: boolean;
  quickMenuAutoShift: boolean;
  quickMenuOnDrag: boolean;
  quickMenuDragAlt: boolean;
  quickMenuDragCtrl: boolean;
  quickMenuDragShift: boolean;
  quickMenuIcon: { enabled: boolean; url: string; x: number; y: number };
  quickMenuOnKey: boolean;
  quickMenuKey: ShortcutKey | null;
  quickMenuOnMouse: boolean;
  quickMenuOnMouseMethod: 'click' | 'hold';
  quickMenuMouseButton: 1 | 2 | 3;
  quickMenuOnMouseAlt: boolean;
  quickMenuOnMouseCtrl: boolean;
  quickMenuOnMouseShift: boolean;
  quickMenuOnMouseOpenWithoutSelection: boolean;
  quickMenuOnSimpleClick: { enabled: boolean; button: number; alt: boolean; ctrl: boolean; shift: boolean };
  quickMenuPosition: QuickMenuPosition;
  quickMenuOffset: { x: number; y: number };
  quickMenuColumns: number;
  quickMenuColumnsMinimum: number;
  quickMenuRows: number;
  quickMenuRowsSingleColumn: number;
  quickMenuScale: number;
  quickMenuIconScale: number;
  quickMenuDefaultView: 'grid' | 'text';
  quickMenuUseCascadingFolders: boolean;
  quickMenuCloseOnClick: boolean;
  quickMenuCloseOnScroll: boolean;
  quickMenuCloseOnTabChange: boolean;
  quickMenuCloseOnEdit: boolean;
  quickMenuLeftClick: OpenMethod;
  quickMenuMiddleClick: OpenMethod;
  quickMenuRightClick: OpenMethod;
  quickMenuShift: OpenMethod;
  quickMenuCtrl: OpenMethod;
  quickMenuAlt: OpenMethod;
  quickMenuFolderLeftClick: OpenMethod;
  quickMenuFolderMiddleClick: OpenMethod;
  quickMenuFolderRightClick: OpenMethod;
  quickMenuFolderShift: OpenMethod;
  quickMenuFolderCtrl: OpenMethod;
  quickMenuFolderAlt: OpenMethod;
  quickMenuToolsPosition: 'top' | 'bottom' | 'hidden';
  quickMenuToolsAsToolbar: boolean;
  quickMenuSearchBarFocus: boolean;
  quickMenuSearchBarSelect: boolean;
  quickMenuUseContextualLayout: boolean;
  quickMenuContextualLayoutFlattenLimit: number;
  quickMenuContextualLayoutToolbar: boolean;
  quickMenuAutoOnInputs: boolean;
  quickMenuOnLinks: boolean;
  quickMenuOnImages: boolean;
  quickMenuOnAudios: boolean;
  quickMenuOnVideos: boolean;
  quickMenuSearchHotkeys: OpenMethod;
  quickMenuSearchHotkeysFolders: OpenMethod;
  quickMenuTheme: string;
  quickMenuMoveContextMenuMethod: '' | 'alt' | 'ctrl' | 'shift' | 'dblclick';

  // 右键菜单
  contextMenu: boolean;
  contextMenuShowFolderSearch: boolean;
  contextMenuShowAddCustomSearch: boolean;
  contextMenuShowSettingsFolder: boolean;
  contextMenuSearchLinksAs: 'text' | 'url';
  contextMenuShowRecentlyUsed: boolean;
  contextMenuShowRecentlyUsedAsFolder: boolean;
  contextMenuShowRecentlyUsedIcon: boolean;
  recentlyUsedListLength: number;
  contextMenuUseContextualLayout: boolean;
  contextMenuContextualLayoutFlattenLimit: number;
  contextMenuRegexMatchedEngines: boolean;
  syncWithFirefoxSearch: boolean;
  contextMenuKey: string | null;
  contextMenuClick: OpenMethod;
  contextMenuMiddleClick: OpenMethod;
  contextMenuRightClick: OpenMethod;
  contextMenuShift: OpenMethod;
  contextMenuCtrl: OpenMethod;
  contextMenuFolderClick: OpenMethod;
  contextMenuFolderMiddleClick: OpenMethod;
  contextMenuFolderRightClick: OpenMethod;
  contextMenuFolderShift: OpenMethod;
  contextMenuFolderCtrl: OpenMethod;
  contextMenuTitle: string;
  contextMenuUseInnerText: boolean;
  contextMenuHotkeys: boolean;
  contextMenuOnLinks: boolean;
  contextMenuOnImages: boolean;

  // 高亮
  highLight: HighlightConfig;

  // 侧栏
  sideBar: SideBarConfig;

  // 搜索栏
  searchBar: SearchBarConfig;

  // Page Tiles
  pageTiles: PageTilesConfig;

  // 通用
  enableAnimations: boolean;
  enableAnimationsTileSlider: boolean;
  autoTheme: boolean;
  autoThemeLite: string;
  autoThemeDark: string;
  userStylesEnabled: boolean;
  userStyles: string;
  blockList: string[];
  defaultEngine: string;
  searchBarIcon: string;
  searchBarEnableHistory: boolean;
  searchBarSuggestions: boolean;
  searchBarDisplayLastSearch: boolean;
  searchBarHistory: string[];
  searchBarHistoryLength: number;
  autoCopy: boolean;
  autoCopyOnInputs: boolean;
  searchBarCloseAfterSearch: boolean;
  searchBarColumns: number;
  searchBarDefaultView: 'grid' | 'text';
  incognitoTabsForgetHistory: boolean;
  autoImportFirefoxEngines: boolean;
  multilinesAsSeparateSearches: boolean;
  multilinesAsSeparateSearchesLimit: number;
  scriptsUseBlobs: boolean;
  preventDuplicateSearchTabs: boolean;
  removeConsecutiveSeparators: boolean;
  cacheIcons: boolean;
  cacheIconsMaxSize: number;
  forceOpenResultsTabsAdjacent: boolean;
  disableNewTabSorting: boolean;
  ignoreSearchRedirects: boolean;
  modify_mycroftproject: boolean;
  toolBarMenuDisablePageClicks: boolean;
  multisearchIncludeHidden: boolean;
  searchEnginesManagerShowContexts: boolean;
  waitOnInjectionTimeout: number;
  defaultGroupColor: string;
  defaultGroupColorText: string;

  // 快捷键
  userShortcuts: UserShortcut[];
  allowHotkeysWithoutMenu: boolean;
  allowHotkeysOnLinks: boolean;
  allowHotkeysOnImages: boolean;

  // 弹窗
  popupWindow: {
    height: string;
    width: string;
    left: string;
    top: string;
    reuse: boolean;
    rememberPosition: boolean;
  };

  // Native App
  nativeAppDownloadFolder: string;

  // 额外搜索动作
  additionalSearchActions: AdditionalSearchAction[];
}

/** 快捷菜单工具配置 */
export interface QuickMenuToolConfig {
  name: string;
  on: boolean;
  persist?: boolean;
  disabled?: boolean;
}

/** 用户自定义快捷键 */
export interface UserShortcut {
  id: string;
  key: string;
  keyCode: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  name?: string;
}

/** 额外搜索动作 */
export interface AdditionalSearchAction {
  event: 'mouseup' | 'dblclick';
  button: number;
  action: OpenMethod;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey?: boolean;
}

// ---- 消息传递 ----

/** Runtime 消息基础结构 */
export interface RuntimeMessage {
  action: string;
  [key: string]: unknown;
}

/** 搜索请求 */
export interface SearchMessage extends RuntimeMessage {
  action: 'quickMenuSearch' | 'search';
  info: {
    searchTerms?: string;
    selectionText?: string;
    tab?: chrome.tabs.Tab;
    openMethod?: OpenMethod;
    menuItemId?: string;
    node?: AnyNode;
    folder?: boolean;
    multiURL?: boolean;
    openUrl?: boolean;
    quickMenuObject?: QuickMenuObject;
    multilines?: boolean;
    temporarySearchEngine?: SearchEngine;
    domain?: string;
  };
}

/** 保存用户选项 */
export interface SaveUserOptionsMessage extends RuntimeMessage {
  action: 'saveUserOptions';
  userOptions: Partial<UserOptions>;
  source?: string;
}

/** 打开选项页 */
export interface OpenOptionsMessage extends RuntimeMessage {
  action: 'openOptions';
  hashurl?: string;
}

// ---- 图标工具 ----

/** 生成图标参数 */
export interface GeneratedIconParams {
  text?: string;
  bg?: string;
  fg?: string;
  size?: number;
  font?: string;
}

// ---- 导出/导入 ----

/** 导出的节点结构 */
export interface ExportedNodes {
  exportedNodes: AnyNode[];
}

/** 完整的设置导出 */
export interface SettingsExport {
  userOptions: UserOptions;
  version: string;
  exportDate: string;
}

// ---- 工具函数类型 ----

/** 节点查找回调 */
export type NodeFindCallback = (node: AnyNode, parent: AnyNode | null) => boolean;

/** 节点遍历回调 */
export type NodeTraverseCallback = (node: AnyNode, parent: AnyNode | null) => void;

/** 消息处理函数 */
export type MessageHandler = (
  message: RuntimeMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) => void | boolean | Promise<unknown>;

// ---- QM Tools 注册表 ----

export interface QMToolDefinition {
  title: string;
  name: string;
  icon: string;
  tooltip?: string;
  onclick?: () => void;
}

export type QMToolRegistry = Record<string, QMToolDefinition>;

// ---- CopyPaste 模块 ----

export interface CopyPasteModule {
  templateUsesClipboard(template: string): boolean;
  copy(text?: string): Promise<void>;
  read(): Promise<string>;
  setSessionClipboard(data: unknown): Promise<void>;
}

// ---- Tab Terms 追踪 ----

export interface TabTermEntry {
  id: string;
  folderId?: string;
  tabId: number;
  searchTerms: string;
  deactivated?: boolean;
}
