// ============================================================
// Tampermonkey v5.5.0 — TypeScript 类型定义 (dsv4 逆向工程)
// ============================================================

// ---------- User Script 元数据 ----------

/** 脚本运行时机 */
export type RunAt = 'document-start' | 'document-end' | 'document-idle';

/** @grant 权限声明（GM API 白名单） */
export type GrantApiName =
  | 'GM_addElement'
  | 'GM_addStyle'
  | 'GM_addValueChangeListener'
  | 'GM_cookie'
  | 'GM_deleteValue'
  | 'GM_deleteValues'
  | 'GM_download'
  | 'GM_getResourceText'
  | 'GM_getResourceURL'
  | 'GM_getTab'
  | 'GM_getTabs'
  | 'GM_getValue'
  | 'GM_getValues'
  | 'GM_info'
  | 'GM_listValues'
  | 'GM_log'
  | 'GM_notification'
  | 'GM_openInTab'
  | 'GM_registerMenuCommand'
  | 'GM_removeValueChangeListener'
  | 'GM_saveTab'
  | 'GM_setClipboard'
  | 'GM_setValue'
  | 'GM_setValues'
  | 'GM_unregisterMenuCommand'
  | 'GM_webRequest'
  | 'GM_xmlhttpRequest'
  // GM.* 别名
  | 'GM.addElement'
  | 'GM.addStyle'
  | 'GM.addValueChangeListener'
  | 'GM.cookie'
  | 'GM.deleteValue'
  | 'GM.deleteValues'
  | 'GM.download'
  | 'GM.getResourceText'
  | 'GM.getResourceUrl'
  | 'GM.getTab'
  | 'GM.getTabs'
  | 'GM.getValue'
  | 'GM.getValues'
  | 'GM.info'
  | 'GM.listValues'
  | 'GM.log'
  | 'GM.notification'
  | 'GM.openInTab'
  | 'GM.registerMenuCommand'
  | 'GM.removeValueChangeListener'
  | 'GM.saveTab'
  | 'GM.setClipboard'
  | 'GM.setValue'
  | 'GM.setValues'
  | 'GM.unregisterMenuCommand'
  | 'GM.webRequest'
  | 'GM.xmlHttpRequest'
  // 特殊权限
  | 'unsafeWindow'
  | 'window.close'
  | 'window.focus'
  | 'window.onurlchange'
  | 'none';

/** 用户脚本元数据头 */
export interface UserScriptMeta {
  name: string;
  name_i18n?: Record<string, string>;
  description: string;
  description_i18n?: Record<string, string>;
  version: string;
  author?: string;
  namespace?: string;
  license?: string;
  copyright?: string;
  homepage?: string;
  homepageURL?: string;
  supportURL?: string;
  downloadURL?: string;
  updateURL?: string;
  icon?: string;
  iconURL?: string;
  icon64?: string;
  icon64URL?: string;
  defaulticon?: string;
  website?: string;
  source?: string;
  include: string[];
  exclude: string[];
  match: string[];
  require: string[];
  resource: Array<{ name: string; url: string }>;
  grant: GrantApiName[];
  connect: string[];
  'run-at'?: RunAt;
  noframes?: boolean;
  nocompat?: string;
  unwrap?: boolean;
  sandbox?: string;
  antifeature?: string[];
  developer?: string;
  contributor?: string[];
  contributors?: string[];
  tag?: string[];
  history?: string;
}

// ---------- 用户脚本运行时对象 ----------

/** 脚本来源类型 */
export type ScriptSource = 'local' | 'remote' | 'sync' | 'cloud';

/** 脚本存储状态 */
export interface ScriptStorage {
  /** 脚本唯一ID (UUID) */
  uuid: string;
  /** 脚本名称 */
  name: string;
  /** 脚本元数据 */
  meta: UserScriptMeta;
  /** 脚本源代码 */
  source: string;
  /** 是否启用 */
  enabled: boolean;
  /** 安装来源 URL */
  sourceUrl?: string;
  /** 上次更新时间 */
  lastUpdate: number;
  /** 安装时间 */
  installed: number;
  /** 位置序号 */
  position: number;
  /** 是否已删除（回收站） */
  removed?: boolean;
  /** 同步状态 */
  sync?: ScriptSyncInfo;
  /** 自定义 include/exclude 覆盖 */
  customIncludes?: string[];
  customExcludes?: string[];
  customMatches?: string[];
}

/** 脚本同步信息 */
export interface ScriptSyncInfo {
  provider: SyncProvider;
  lastSync: number;
  remoteId?: string;
  status: 'ok' | 'conflict' | 'error';
}

/** 云同步提供商 */
export type SyncProvider = 'gdrive' | 'onedrive' | 'dropbox' | 'webdav' | 'yandex';

/** 脚本更新检查策略 */
export type UpdateCheckMode =
  | 'only_manual'       // 仅手动检查
  | 'some_secs'         // 定时检查（以秒为单位）
  | 'not_succeeded';    // 上次检查失败时不自动重试

// ---------- 扩展配置 ----------

/** Action 菜单脚本排序方式 */
export type ActionMenuSort =
  | 'position'    // 按位置排序
  | 'name'        // 按名称排序
  | 'executions'; // 按执行次数排序

/** 下载模式 */
export type DownloadsMode = 'native' | 'browser' | 'disabled';

/** 沙箱模式 */
export type SandboxMode = 'raw' | 'js' | 'default';

/** 上下文菜单执行模式 */
export type ContextExecMode = 0 | 1 | 2;  // 0=page, 1=iframe, 2=both

/** 页面过滤模式 */
export type PageFilterMode = 'all' | 'whitelist' | 'blacklist';

/** 脚本包含模式 */
export type ScriptIncludeMode = 'enabled' | 'disabled';

/** Editor Linter 配置 */
export interface EditorLinterConfig {
  eslint?: boolean;
  rules?: Record<string, unknown>;
}

/** 全局扩展设置 */
export interface GlobalSettings {
  // 外观
  action_menu_scripts_sort: ActionMenuSort;
  action_menu_scripts_hide_disabled: boolean;
  action_menu_columns: number;
  appearance_badges: boolean;
  appearance_badge_color: string;
  appearance_badge_text_color: string;
  layout_user_css: string;

  // 编辑器
  editor_enabled: boolean;
  editor_theme: string;
  editor_linter_config: EditorLinterConfig;
  script_templates: string;

  // 脚本管理
  scripts_new: string;
  scripts_right: string;
  trash_mode: boolean;
  tags_enabled: boolean;

  // 更新
  script_update: UpdateCheckMode;
  script_search: boolean;
  scriptUpdateCheckPeriod: number;
  scriptUpdateCheckDisabled: boolean;
  scriptUpdateHideNotificationAfter: number;
  scriptUpdateAutomaticInstall: boolean;
  apply_script_update: boolean;

  // 安全
  script_include_mode: ScriptIncludeMode;
  script_blacklist_type: 'none' | 'blacklist' | 'whitelist';
  script_blacklist_severity: number;
  script_blacklist_server: string;
  script_download: boolean;
  script_file_access: boolean;
  script_cookie_access: boolean;
  require_blacklist: string[];
  require_sri_mode: boolean;
  sandbox_mode: SandboxMode;

  // 注入
  runtime_strict_mode: boolean;
  runtime_content_mode: string;
  runtime_run_in: string;
  runtime_top_level_await: boolean;
  page_filter_mode: PageFilterMode;
  page_whitelist: string;
  blacklist_page: string;

  // 上下文菜单
  context_menu_enabled: boolean;
  context_menu_scripts: boolean;
  context_menu_commands: boolean;
  ctx_exec: ContextExecMode;

  // 通知
  disable_stats: boolean;
  enable_stats: boolean;
  disable_update: boolean;

  // 下载
  downloads_mode: DownloadsMode;
  downloads_extension_whitelist: string[];

  // 同步
  sync_enabled: boolean;
  sync_type: SyncProvider;
  sync_status: 'ok' | 'error';

  // 统计
  statistics_enabled: boolean;
  disable_stats: boolean;

  // 实验性
  developer_mode: boolean;

  // 云服务配置
  gd_config?: CloudProviderConfig;
  od_config?: CloudProviderConfig;
  ya_config?: CloudProviderConfig;
  db_config?: CloudProviderConfig;

  // 外部脚本源
  external_connect: boolean;
  external_update_interval: number;

  // 高级
  incognito_mode: 'split' | 'span';
  background_control: boolean;
  android_hint: boolean;
  focus_tab: boolean;
  event_bindings: boolean;
  mtm_visitor: boolean;
}

/** 云服务提供商配置 */
export interface CloudProviderConfig {
  access_token?: string;
  cloud_user?: string;
  cloud_pass?: string;
  cloud_url?: string;
  auth_failed?: boolean;
}

// ---------- 消息通信 ----------

/** 消息动作类型（Service Worker 端） */
export type MessageMethod =
  | 'scriptEvent'
  | 'scriptStorage'
  | 'script_update'
  | 'script_add'
  | 'script_sync'
  | 'script_download'
  | 'script_search'
  | 'edit_add'
  | 'update'
  | 'delete'
  | 'install'
  | 'contextmenu'
  | 'notification'
  | 'openInTab'
  | 'download'
  | 'xhr'
  | 'webRequest'
  | 'registerMenuCommand'
  | 'connect'
  | 'disconnect'
  | 'message.response'
  | 'ack'
  | 'refresh'
  | 'commid'
  | 'config'
  | 'getState'
  | 'getVersion'
  | 'openOptions'
  | 'setMute'
  | 'toggle_tagged_scripts'
  | 'reload'
  | 'permissions'
  | 'badge'
  | 'ping'
  | 'factory'
  | 'options'
  | 'init'
  | 'sync'
  | 'storage'
  | 'userscripts'
  | 'resources';

/** Service Worker 内部消息 */
export interface BackgroundMessage {
  method: MessageMethod;
  [key: string]: unknown;
}

/** Port 通信消息 */
export interface PortMessage {
  response_id?: string;
  connect?: boolean;
  disconnect?: boolean;
  destination?: string;
  value?: unknown;
}

/** 内容脚本与 Service Worker 之间的消息 */
export interface ContentBridgeMessage {
  m: MessageMethod;       // method
  a: unknown;             // args
  r?: string;             // response callback ID
  n?: unknown;            // node/context
}

// ---------- GM API 类型 ----------

/** GM_info 返回值 */
export interface ScriptInfo {
  script: {
    name: string;
    namespace?: string;
    version: string;
    description: string;
    author?: string;
    homepage?: string;
    supportURL?: string;
    downloadURL?: string;
    updateURL?: string;
    icon?: string;
    icon64?: string;
    grant: string[];
    includes: string[];
    excludes: string[];
    matches: string[];
    requires: string[];
    resources: Array<{ name: string; url: string }>;
    runAt: RunAt;
    noframes: boolean;
    unwrap: boolean;
  };
  scriptMetaStr: string;
  scriptSource: string;
  scriptUpdateURL?: string;
  scriptWillUpdate: boolean;
  scriptHandler: string;
  version: string;
}

/** GM_xmlhttpRequest 参数 */
export interface GMXHRDetails {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  url: string;
  headers?: Record<string, string>;
  data?: string | FormData | Blob | ArrayBuffer;
  binary?: boolean;
  timeout?: number;
  context?: unknown;
  responseType?: 'arraybuffer' | 'blob' | 'json' | 'text' | 'document';
  overrideMimeType?: string;
  anonymous?: boolean;
  user?: string;
  password?: string;
  onabort?: () => void;
  onerror?: (resp: GMXHRResponse) => void;
  onload?: (resp: GMXHRResponse) => void;
  onloadend?: (resp: GMXHRResponse) => void;
  onloadstart?: (resp: GMXHRResponse) => void;
  onprogress?: (resp: GMXHRResponse) => void;
  onreadystatechange?: (resp: GMXHRResponse) => void;
  ontimeout?: () => void;
}

/** GM_xmlhttpRequest 响应 */
export interface GMXHRResponse {
  readyState: number;
  responseHeaders: string;
  responseText: string;
  responseXML?: Document;
  status: number;
  statusText: string;
  finalUrl: string;
  context?: unknown;
  response?: ArrayBuffer | Blob | Document | object | string;
}

/** GM_download 参数 */
export interface GMDownloadDetails {
  url: string;
  name: string;
  headers?: Record<string, string>;
  saveAs?: boolean;
  conflictAction?: 'uniquify' | 'overwrite' | 'prompt';
  onload?: () => void;
  onerror?: (error: { error: string; details?: string }) => void;
}

/** GM_notification 参数 */
export interface GMNotificationDetails {
  text?: string;
  title?: string;
  image?: string;
  highlight?: boolean;
  silent?: boolean;
  timeout?: number;
  url?: string;
  onclick?: () => void;
  ondone?: () => void;
}

/** GM_webRequest 规则 */
export interface GMWebRequestRule {
  selector: string | { include?: string[]; exclude?: string[]; match?: string[] };
  action:
    | 'cancel'
    | 'redirect'
    | { redirect: string }
    | { cancel: boolean };
}

/** GM_cookie 操作 */
export interface GMCookieDetails {
  url: string;
  name: string;
  value?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'strict' | 'lax' | 'no_restriction' | 'unspecified';
  expirationDate?: number;
  storeId?: string;
  partitionKey?: { topLevelSite: string };
}

// ---------- 注入相关 ----------

/** 注入模式 */
export type InjectionMode = 'js' | 'css' | 'both';

/** 用户脚本注入目标 */
export interface InjectionTarget {
  tabId: number;
  frameId: number;
  url: string;
  script: ScriptStorage;
}

/** Vault/Sandbox 上下文（内容脚本注入到页面） */
export interface PageVaultContext {
  unsafeWindow: Window & typeof globalThis;
  unsafeThis: Window & typeof globalThis;
  pageWindow: undefined;
  contextId: string;
  fSend: (id: string, data: unknown) => void;
  fOnMessage: (cb: (listener: unknown, clone: unknown) => void) => void;
  cloneInto: undefined;
  exportFunction: undefined;
}

// ---------- 事件类型 ----------

/** 脚本事件 */
export interface ScriptEvent {
  type: 'install' | 'update' | 'delete' | 'enable' | 'disable' | 'edit' | 'sync';
  script: ScriptStorage;
  timestamp: number;
}

/** 脚本更新检查结果 */
export interface UpdateCheckResult {
  uuid: string;
  hasUpdate: boolean;
  currentVersion: string;
  newVersion?: string;
  downloadURL?: string;
  error?: string;
}

// ---------- Chrome 扩展上下文 ----------

/** Service Worker 全局状态 */
export interface ExtensionState {
  scripts: Map<string, ScriptStorage>;
  settings: GlobalSettings;
  syncProvider?: SyncProvider;
  activeTab?: number;
  installInProgress: Set<string>;
  pendingUpdates: Map<string, UpdateCheckResult>;
}
