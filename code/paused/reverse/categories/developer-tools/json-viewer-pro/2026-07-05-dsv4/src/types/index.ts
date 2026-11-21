// ============================================================
// JSON Viewer Pro — TypeScript 类型定义（逆向工程，dsv4）
// 基于 manifest.json v1.0.6 与源码分析还原
// ============================================================

// ---------------------------------------------------------------------------
// 存储键
// ---------------------------------------------------------------------------

/** chrome.storage.local 中使用的数据库键名 */
export const STORAGE_KEY = 'rb-awesome-json-ver-options';

// ---------------------------------------------------------------------------
// 主题
// ---------------------------------------------------------------------------

/** 支持的主题 ID */
export type ThemeId = 'default' | 'mdn';

/** 主题到 CSS 文件名的映射 */
export const THEME_TO_CSS: Record<ThemeId, string> = {
  default: 'dark-pro.css',
  mdn: 'mdn-light.css',
};

/** 深色主题 ID 集合（用于判断 UI 中的 isDarkMode） */
export const DARK_THEME_IDS: ReadonlyArray<string> = ['default', 'dark-pro'];

// ---------------------------------------------------------------------------
// JSON 检测配置
// ---------------------------------------------------------------------------

/** JSON 检测方法 */
export type DetectionMethod = 'contentType' | 'jsonContent';

/** content-type 检测模式下可选的内容类型 */
export type ContentType =
  | 'application/json'
  | 'text/json'
  | 'application/javascript'
  | 'application/x-javascript'
  | 'application/vnd.api+json'
  | 'text/x-json'
  | 'text/x-javascript';

/** JSON 检测配置 */
export interface JsonDetectionConfig {
  /** 检测方式 */
  method: DetectionMethod;
  /** contentType 模式下勾选的内容类型 */
  selectedContentTypes: ContentType[];
}

// ---------------------------------------------------------------------------
// 扩展选项
// ---------------------------------------------------------------------------

/** 完整的扩展选项 */
export interface ExtensionOptions {
  /** 主题 ID */
  theme: ThemeId;
  /** 自定义 CSS 原文 */
  css: string;
  /**
   * 折叠层级
   * - 0: 不折叠
   * - N: 深度 >= N 的节点默认折叠
   */
  collapsed: number;
  /** URL 过滤列表（前缀匹配，禁用渲染的网站） */
  filteredURL: string[];
  /** JSON 检测配置 */
  jsonDetection: JsonDetectionConfig;
  /** 选项页 URL（由 background 动态注入） */
  optionPageURL?: string;
}

/** 默认选项 */
export const DEFAULT_OPTIONS: ExtensionOptions = {
  theme: 'default',
  css: `\n/**Write your CSS style **/\n#json-viewer {\n    font-size: 15px;\n}\n`,
  collapsed: 0,
  filteredURL: [],
  jsonDetection: {
    method: 'contentType',
    selectedContentTypes: [
      'application/json',
      'text/json',
      'application/javascript',
    ],
  },
};

// ---------------------------------------------------------------------------
// 消息通信
// ---------------------------------------------------------------------------

/** 后台脚本可发出的 action */
export type BackgroundAction =
  | 'options_received'
  | 'settings_updated';

/** 内容脚本可发出的 action */
export type ContentScriptAction =
  | 'give_me_options';

/** 右键菜单触发的 action */
export type ContextMenuAction = 'rb_download_json';

/** runtime.sendMessage 的消息体 */
export interface RuntimeMessage {
  action: BackgroundAction | ContentScriptAction | ContextMenuAction;
  options?: ExtensionOptions;
}

/** tabs.sendMessage 的消息体（由后台向内容脚本发送） */
export interface TabMessage {
  action: BackgroundAction | ContextMenuAction;
  options?: ExtensionOptions;
}

// ---------------------------------------------------------------------------
// 右键菜单
// ---------------------------------------------------------------------------

/** 右键菜单 ID */
export const CONTEXT_MENU_IDS = {
  DOWNLOAD_JSON: 'RB_DOWNLOAD_JSON_MENU',
  OPEN_SETTINGS: 'RB_OPEN_SETTINGS',
} as const;

export type ContextMenuId =
  | typeof CONTEXT_MENU_IDS.DOWNLOAD_JSON
  | typeof CONTEXT_MENU_IDS.OPEN_SETTINGS;

// ---------------------------------------------------------------------------
// 内容脚本注入
// ---------------------------------------------------------------------------

/** 注入到宿主页面的 <link>/<style>/<script> 标签 ID */
export const INJECTED_ELEMENT_IDS = {
  BASE_STYLE: 'main-css',
  COLOR_THEME: 'color-theme-css',
  CUSTOM_CSS: 'custom-css',
  MAIN_SCRIPT: 'main-script',
} as const;

/** 宿主页面根容器 ID */
export const APP_ROOT_ID = 'rbrahul-awesome-json';

// ---------------------------------------------------------------------------
// 应用状态（由 main.js 中的 React 组件管理）
// ---------------------------------------------------------------------------

/** JSON 查看器主 UI 的 Tab */
export type ViewerTab = 'tree' | 'chart' | 'jsonInput';

/** 主应用（React）的状态概要 */
export interface ViewerState {
  selectedTab: ViewerTab;
  json: unknown;
  selectedJSON: unknown;
  isSearchBarVisible: boolean;
  isDarkMode: boolean;
}
