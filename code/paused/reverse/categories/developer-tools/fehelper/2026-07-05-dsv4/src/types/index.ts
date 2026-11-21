// ============================================================================
// FeHelper dsv4 — 反向工程类型定义
// 数据源：manifest.json v2026.7.3 / background.js / tools.js / awesome.js
// 用途：文档与类型检查（不实现运行逻辑）
// ============================================================================

// ---------------------------------------------------------------------------
// Manifest 信息
// ---------------------------------------------------------------------------

export interface FeHelperManifest {
  name: string;
  short_name: string;
  version: string;
  manifest_version: 3;
  description: string;
  icons: {
    "16": string;
    "48": string;
    "128": string;
  };
  author: string; // "nicetool.net"
  homepage_url: string; // "https://fehelper.com/"
  update_url: string; // Google CWS update
}

// ---------------------------------------------------------------------------
// 消息类型枚举（MSG_TYPE，定义于 static/js/common.js）
// ---------------------------------------------------------------------------

export enum MsgType {
  STABLE_EXTENSION_ID = "pkgccpejnmalmdinmhkkfafefagiiiad",
  DOWNLOAD_FROM_GITHUB = "https://github.com/zxlie/FeHelper/tree/master/apps/static/screenshot/crx",
  MENU_SAVED = "menu_saved",
  JSON_FORMAT = "json-format",
  DYNAMIC_TOOL = "dynamic",
  TAB_CREATED_OR_UPDATED = "TAB_CREATED_OR_UPDATED",
  CAPTURE_VISIBLE_PAGE = "capture-visible-page",
  OPEN_DYNAMIC_TOOL = "open-dynamic-tool",
  OPEN_PAGE = "open-page",
  DYNAMIC_TOOL_INSTALL_OR_OFFLOAD = "dynamic-tool-install-or-offload",
  DYNAMIC_ANY_THING = "fh-dynamic-any-thing",
}

// ---------------------------------------------------------------------------
// 工具定义（tools.js toolMap）
// ---------------------------------------------------------------------------

export type ToolKey =
  | "json-format"
  | "json-diff"
  | "qr-code"
  | "image-base64"
  | "en-decode"
  | "code-beautify"
  | "code-compress"
  | "aiagent"
  | "timestamp"
  | "byte-unit"
  | "password"
  | "uuid-gen"
  | "sticky-notes"
  | "html2markdown"
  | "postman"
  | "websocket"
  | "regexp"
  | "trans-radix"
  | "trans-color"
  | "crontab"
  | "loan-rate"
  | "devtools"
  | "page-monkey"
  | "screenshot"
  | "mock-data"
  | "color-picker"
  | "naotu"
  | "grid-ruler"
  | "page-timing"
  | "excel2json"
  | "chart-maker"
  | "svg-converter"
  | "poster-maker"
  | "datetime-calc";

/** 菜单配置项（右键菜单、popup 快捷入口） */
export interface MenuConfigItem {
  icon: string;
  text: string;
  contexts?: ("page" | "selection" | "editable" | "link" | "image")[];
}

/** 原始工具定义（来自 tools.js toolMap） */
export interface ToolDef {
  name: string; // 中文名称
  tips: string; // 中文描述
  contentScriptJs?: boolean; // 是否存在 content-script.js
  contentScriptCss?: boolean; // 是否存在 content-script.css
  systemInstalled?: boolean; // 系统内置（json-format）
  noPage?: boolean; // 不打开独立页面（screenshot、color-picker 等）
  _devTool?: boolean; // 是否为第三方开发工具
  _enable?: boolean; // _devTool 的启用标记
  menuConfig?: MenuConfigItem[];
}

/** 工具注册表映射 */
export type ToolMap = Record<ToolKey, ToolDef>;

// ---------------------------------------------------------------------------
// 工具运行时状态
// ---------------------------------------------------------------------------

export interface ToolRuntimeState {
  /** 工具键名 */
  key: ToolKey | string;
  /** 是否已安装 */
  installed: boolean;
  /** 是否在右键菜单中 */
  inContextMenu: boolean;
  /** 是否系统内置 */
  systemInstalled: boolean;
  /** 是否收藏 */
  favorite: boolean;
  /** 安装时间（时间戳，毫秒） */
  installTime: number;
}

// ---------------------------------------------------------------------------
// 工具分类
// ---------------------------------------------------------------------------

export type ToolCategoryKey = "dev" | "encode" | "image" | "productivity" | "calculator" | "other";

export interface ToolCategory {
  key: ToolCategoryKey;
  name: string; // 中文分类名，例如 "开发工具类"
  tools: ToolKey[];
}

export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    key: "dev",
    name: "开发工具类",
    tools: [
      "json-format", "json-diff", "code-beautify", "code-compress",
      "postman", "websocket", "regexp", "page-timing",
    ],
  },
  {
    key: "encode",
    name: "编解码转换类",
    tools: ["en-decode", "trans-radix", "timestamp", "trans-color"],
  },
  {
    key: "image",
    name: "图像处理类",
    tools: [
      "qr-code", "image-base64", "svg-converter",
      "chart-maker", "poster-maker", "screenshot", "color-picker",
    ],
  },
  {
    key: "productivity",
    name: "效率工具类",
    tools: ["aiagent", "sticky-notes", "html2markdown", "page-monkey"],
  },
  {
    key: "calculator",
    name: "计算工具类",
    tools: ["crontab", "loan-rate", "password", "uuid-gen"],
  },
  {
    key: "other",
    name: "其他工具",
    tools: [],
  },
];

// ---------------------------------------------------------------------------
// 运行时消息（Background ← 各组件通信）
// ---------------------------------------------------------------------------

/**
 * 基础消息格式
 * 所有消息至少包含 type 字段
 */
interface BaseMessage {
  type: string;
}

/** 动态工具安装/卸载消息 */
export interface DynamicToolInstallMessage extends BaseMessage {
  type: "dynamic-tool-install-or-offload";
  toolName: ToolKey | string;
  action: "install" | "offload" | "menu-install" | "menu-offload" | "menu-change";
  showTips?: boolean;
  menuOnly?: boolean;
}

/** 打开动态工具页面 */
export interface OpenDynamicToolMessage extends BaseMessage {
  type: "open-dynamic-tool";
  page: ToolKey | string;
  noPage?: boolean;
  query?: string;
  withContent?: unknown;
}

/** 打开页面（非工具） */
export interface OpenPageMessage extends BaseMessage {
  type: "open-page";
  page: string;
}

/** 动态任意操作（DYNAMIC_ANY_THING） */
export interface DynamicAnyThingMessage extends BaseMessage {
  type: "fh-dynamic-any-thing";
  thing: DynamicThingType;
  /** 其他参数视 thing 而定 */
  [key: string]: unknown;
}

export type DynamicThingType =
  | "save-options"
  | "trigger-screenshot"
  | "request-jsonformat-options"
  | "save-jsonformat-options"
  | "toggle-jsonformat-options"
  | "code-beautify"
  | "close-beautify"
  | "qr-decode"
  | "request-page-content"
  | "set-page-timing-data"
  | "color-picker-capture"
  | "add-screen-shot-by-pages"
  | "page-screenshot-done"
  | "request-monkey-start"
  | "page-monkey-log"
  | "page-monkey-require-fetch"
  | "inject-content-css"
  | "open-options-page"
  | "open-donate-modal"
  | "inject-scripts-to-tab"
  | "load-local-script"
  | "statistics-tool-usage"
  | "fetch-hotfix-json"
  | "fh-get-tool-patch";

/** Popup 已打开通知 */
export interface PopupOpenedMessage extends BaseMessage {
  type: "fh-popup-opened";
}

/** 截取可见页面 */
export interface CaptureVisiblePageMessage extends BaseMessage {
  type: "capture-visible-page" | "fh-screenshot-capture-visible";
}

/** Client 信息上报 */
export interface ClientInfoMessage extends BaseMessage {
  type: "clientInfo";
  data: ClientInfo;
}

/** 用户环境信息（上报给统计服务） */
export interface ClientInfo {
  language: string;
  timezone: string;
  userAgent: string;
  platform: string;
  vendor: string;
  colorDepth: number;
  screenWidth: number;
  screenHeight: number;
  deviceMemory: number | string;
  hardwareConcurrency: number | string;
  networkType: string;
  downlink: number | string;
  rtt: number | string;
  online: boolean;
  touchSupport: boolean;
  cookieEnabled: boolean;
  doNotTrack: string | null;
  appVersion: string;
  appName: string;
  product: string;
  vendorSub: string;
  screenOrientation: string;
  memoryJSHeapSize: number;
}

/** 联合消息类型 */
export type RuntimeMessage =
  | DynamicToolInstallMessage
  | OpenDynamicToolMessage
  | OpenPageMessage
  | DynamicAnyThingMessage
  | PopupOpenedMessage
  | CaptureVisiblePageMessage
  | ClientInfoMessage
  | { type: "fh-screenshot-start" }
  | { type: "fh-dynamic-any-thing"; thing: string; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// 动态工具渲染消息（sandbox 通信）
// ---------------------------------------------------------------------------

export interface DynamicRenderPayload {
  html: string;
  css: string[];
  js: string[];
}

export interface DynamicRenderMessage {
  type: "fh-dynamic-render";
  payload: DynamicRenderPayload;
}

// ---------------------------------------------------------------------------
// 选项/设置
// ---------------------------------------------------------------------------

export type UiMode = "lite" | "omni";

export type DarkModePreference = "off" | "system" | "always";

export interface FeHelperOptions {
  FH_UI_MODE?: UiMode;
  FH_POPUP_UI_MODE?: UiMode;
  FH_OPTIONS_UI_MODE?: UiMode;

  // JSON 格式化
  JSON_PAGE_FORMAT?: boolean;
  JSON_TOOL_BAR_ALWAYS_SHOW?: boolean;
  STATUS_BAR_ALWAYS_SHOW?: boolean;
  AUTO_TEXT_DECODE?: boolean;
  FIX_ERROR_ENCODING?: boolean;
  ENABLE_JSON_KEY_SORT?: boolean;
  KEEP_KEY_VALUE_DBL_QUOTE?: boolean;
  NESTED_ESCAPE_PARSE?: boolean;
  JSON_FORMAT_COMPACT_MODE?: boolean;
  JSON_FORMAT_UI_MODE?: UiMode;
  JSON_FORMAT_EXCLUDED_ORIGINS?: string;
  MAX_JSON_KEYS_NUMBER?: number;
  JSON_FORMAT_THEME?: number;

  // 外观
  AUTO_DARK_MODE?: boolean;
  ALWAYS_DARK_MODE?: boolean;

  // 行为
  OPT_ITEM_CONTEXTMENUS?: boolean;
  FORBID_OPEN_IN_NEW_TAB?: boolean;
  CONTENT_SCRIPT_ALLOW_ALL_FRAMES?: boolean;
  FORBID_STATISTICS?: boolean;
  JS_CSS_PAGE_BEAUTIFY?: string;

  // 迁移标记
  FH_JSONFORMAT_DEFAULTS_MIGRATED?: boolean;
  FH_JSONFORMAT_FIX_ENCODING_RESTORED?: boolean;
}

// ---------------------------------------------------------------------------
// Storage 键名
// ---------------------------------------------------------------------------

export enum StorageKey {
  /** 动态工具安装标记：DYNAMIC_TOOL:<toolName> */
  DYNAMIC_TOOL_PREFIX = "DYNAMIC_TOOL:",
  /** 动态工具 content-script：DYNAMIC_TOOL:CS:<toolName> */
  DYNAMIC_TOOL_CS_PREFIX = "DYNAMIC_TOOL:CS:",
  /** 动态工具 content-script CSS：DYNAMIC_TOOL:CS:CSS:<toolName> */
  DYNAMIC_TOOL_CS_CSS_PREFIX = "DYNAMIC_TOOL:CS:CSS:",
  /** 动态工具右键菜单：DYNAMIC_MENU:<toolName> */
  DYNAMIC_MENU_PREFIX = "DYNAMIC_MENU:",
  /** 第三方开发工具列表 */
  DEV_TOOLS_MY_TOOLS = "DEV-TOOLS:MY-TOOLS",
  /** 用户收藏工具列表 */
  FAVORITES = "favorites",
  /** Popup 最近使用工具列表 */
  POPUP_RECENT_TOOLS = "popup_recent_tools",
  /** 用户使用数据 */
  USER_USAGE_DATA = "FH_USER_USAGE_DATA",
  /** UI 模式 */
  FH_UI_MODE = "FH_UI_MODE",
  /** Popup UI 模式 */
  FH_POPUP_UI_MODE = "FH_POPUP_UI_MODE",
  /** Options UI 模式 */
  FH_OPTIONS_UI_MODE = "FH_OPTIONS_UI_MODE",
  /** 工具自定义排序 */
  TOOL_CUSTOM_ORDER = "tool_custom_order",
  /** 页面油猴脚本存储 */
  PAGE_MONKEY_LOCAL = "PAGE-MODIFIER-LOCAL-STORAGE-KEY",
  /** 页面油猴运行日志 */
  PAGE_MONKEY_LOG = "PAGE-MODIFIER-LOG-KEY",
  /** 页面内容缓存（session storage） */
  FH_CONTENT_PREFIX = "fh-content-",
  /** 视图模式 */
  VIEW_MODE = "fehelper_view_mode",
  /** 最新版本信息 */
  LATEST_VERSION = "fehelper_latest_version_data",
  /** 打赏来源 */
  DONATE_FROM = "fehelper_donate_from",
  /** 打赏时间 */
  DONATE_TIME = "fehelper_donate_time",
  /** AI Provider */
  AI_PROVIDER = "fh_ai_provider",
  /** AI 内置模型状态快照 */
  AI_BUILTIN_STATUS = "fh_ai_builtin_status_snapshot",
}

// ---------------------------------------------------------------------------
// AI 相关类型
// ---------------------------------------------------------------------------

export type AiModelStatus = "checking" | "unsupported" | "unavailable" | "downloadable" | "downloading" | "available" | "error";

export interface AiModelStatusSnapshot {
  status: AiModelStatus;
  progress: number; // 0–1
  message: string;
  checkedAt: number;
}

export interface AiFeaturePack {
  toolKey: ToolKey | string;
  entryTask: string;
  badge: string;
  title: string;
  desc: string;
}

export interface AiInlinePanel {
  visible: boolean;
  title: string;
  subtitle?: string;
  statusText: string;
  loading: boolean;
  error?: string;
  result?: string;
  canApply?: boolean;
  applyLabel?: string;
  taskKey?: string;
}

// ---------------------------------------------------------------------------
// 油猴脚本（Page Monkey）
// ---------------------------------------------------------------------------

export type MonkeyRunAt = "document-start" | "document-end" | "document-idle";
export type MonkeyWorld = "MAIN" | "ISOLATED";

export interface MonkeyScript {
  id: string;
  mName: string;
  mDescription?: string;
  mVersion?: string;
  mAuthor?: string;
  mIncludes: string[]; // URL 匹配模式
  mExcludes?: string[];
  mRunAt?: MonkeyRunAt;
  mAllFrames?: boolean;
  mWorld?: MonkeyWorld;
  mScript: string; // 用户脚本代码
  mRequireJs?: string; // @require URL 列表
  mGrants?: string[];
  mTags?: string[];
  mHits?: number;
  mDisabled?: boolean;
  mRefresh?: number; // 自动刷新间隔（秒）
  mStyle?: string;
}

export interface MonkeyLogEntry {
  id: string;
  name: string;
  level: "info" | "warn" | "error";
  msg: string;
  url: string;
  time: number;
}

// ---------------------------------------------------------------------------
// 统计与使用数据
// ---------------------------------------------------------------------------

export interface DailyUsage {
  [date: string]: {
    tools: Record<string, number>; // toolName -> 使用次数
  };
}

export interface UserUsageData {
  dailyUsage?: DailyUsage;
  totalUsage?: number;
  firstInstallDate?: string;
  lastUpdateDate?: string;
}

// ---------------------------------------------------------------------------
// 工具页面内容（session storage 传递）
// ---------------------------------------------------------------------------

export interface TabContentCache {
  content: unknown;
  /** 缓存时间，防止旧数据污染 */
  timestamp?: number;
}

// ---------------------------------------------------------------------------
// JSON 格式化相关类型
// ---------------------------------------------------------------------------

export type JsonSortMode = "0" | "1" | "-1"; // 默认 / 升序 / 降序

export type JsonFormatLayout = "left-right" | "up-down";

export interface JsonFormatConfig {
  sortMode: JsonSortMode;
  layout: JsonFormatLayout;
  jsonLint: boolean;
  autoDecode: boolean;
  overrideJson: boolean; // 节点编辑
  nestedEscapeParse: boolean;
  compactMode: boolean;
}

export interface JsonTableViewConfig {
  visible: boolean;
  title: string;
  mode: "grid" | "kv";
  sourcePath: string; // 例如 $.data.items
  columns: string[];
  rows: JsonTableRow[];
  error?: string;
}

export interface JsonTableRow {
  id: string | number;
  cells?: Record<string, unknown>; // grid 模式
  key?: string; // kv 模式
  value?: unknown; // kv 模式
}

export interface JsonPathResult {
  path: string;
  value: unknown;
  type: string;
}

// ---------------------------------------------------------------------------
// 通知
// ---------------------------------------------------------------------------

export interface NotifyConfig {
  icon?: string;
  title?: string;
  message: string;
  autoClose?: number; // 毫秒，默认 3000
  closeImmediately?: boolean;
  type?: "success" | "error" | "info";
}

// ---------------------------------------------------------------------------
// Sandbox 与 DevTool
// ---------------------------------------------------------------------------

export interface DevToolRenderOptions {
  html: string;
  css: string[];
  js: string[];
}

export interface HotfixPatch {
  css: string;
  js: string;
}

export interface ToolPatchMap {
  [toolName: string]: HotfixPatch;
}

// ---------------------------------------------------------------------------
// 事件与回调类型
// ---------------------------------------------------------------------------

export interface ChromeTab {
  id?: number;
  index?: number;
  windowId?: number;
  active?: boolean;
  highlighted?: boolean;
  url?: string;
  title?: string;
  status?: string;
  [key: string]: unknown;
}

export interface TabCreateResult {
  ok: boolean;
  action?: "create" | "reuse";
  tabId?: number;
  error?: string;
  noPage?: boolean;
}

export interface VersionInfo {
  currentVersion: string;
  latestVersion: string;
  needUpdate: boolean;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// 推荐卡片
// ---------------------------------------------------------------------------

export interface RecommendationCard {
  toolKey?: ToolKey | string;
  icon: string;
  title: string;
  desc: string;
  tag: string;
  tagClass: string;
  isAd: boolean;
  url?: string;
}

// ---------------------------------------------------------------------------
// URL 策略
// ---------------------------------------------------------------------------

export interface PopupWakeupTarget {
  ok: boolean;
  tabId?: number;
  error?: string;
}

export function isInjectableTabUrl(url?: string): boolean {
  if (!url) return false;
  return (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("file://")
  );
}

// ---------------------------------------------------------------------------
// EvalCore（安全审计关注点）
// ---------------------------------------------------------------------------

/**
 * evalCore.min.js — 注入到所有页面的内容脚本。
 * 外部 vendor 文件，用于在 content_script 上下文中执行动态代码。
 * 这是安全审计中需要重点关注的风险点。
 */
export type EvalCoreFunction = (code: string, context?: Record<string, unknown>) => unknown;

/**
 * FeHelper 沙箱页面 (dynamic/sandbox.html)
 * CSP: `sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-eval'`
 * 用于运行第三方开发工具（devtools），隔离风险。
 */
export interface SandboxContext {
  /** 接收 postMessage 渲染指令 */
  listenForRender: () => void;
  /** 执行注入的 JS */
  executeScript: (code: string) => void;
  /** 注入 CSS */
  injectStyle: (css: string) => void;
}
