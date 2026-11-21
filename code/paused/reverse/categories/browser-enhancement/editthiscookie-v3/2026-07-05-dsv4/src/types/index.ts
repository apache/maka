// ============================================================
// EditThisCookie V3 — 类型定义 (dsv4 reverse engineering)
// ============================================================

/**
 * Chrome Cookie 对象的扩展类型。
 * 基于 chrome.cookies.Cookie，附加了扩展内部使用的字段。
 */
export interface Cookie {
  /** Cookie 名称 */
  name: string;
  /** Cookie 值 */
  value: string;
  /** Cookie 所属域名 */
  domain: string;
  /** Cookie 路径 */
  path: string;
  /** 是否仅 HTTPS */
  secure: boolean;
  /** 是否仅 HTTP (不可被 JS 访问) */
  httpOnly: boolean;
  /** 是否为会话 Cookie (浏览器关闭后过期) */
  session: boolean;
  /** 是否为 host-only (不可设置子域) */
  hostOnly: boolean;
  /** 过期时间 (Unix 秒, session 为 true 时无意义) */
  expirationDate?: number;
  /** Cookie Store ID (用于区分隐身/普通模式) */
  storeId: string;
  /** SameSite 属性: no_restriction | lax | strict | unspecified */
  sameSite: string;

  // --- 扩展内部字段 ---

  /** 列表中的序号 (用于 UI 定位) */
  id?: number;
  /** 是否被只读规则保护 */
  isProtected?: boolean;

  // --- 导入兼容字段 (蛇形命名) ---
  expiration_date?: number;
  http_only?: boolean;
  store_id?: string;
  same_site?: string;
}

/**
 * 用户偏好设置。
 * 所有字段通过 chrome.storage.local 持久化，键名前缀为 "options_"。
 */
export interface Preferences {
  /** 是否显示确认对话框 */
  showAlerts: boolean;
  /** 是否显示命令标签文本 */
  showCommandsLabels: boolean;
  /** 是否在 Cookie 列表中显示域名 */
  showDomain: boolean;
  /** 是否将域名显示在名称之前 */
  showDomainBeforeName: boolean;
  /** 是否显示"标记并删除全部"按钮 */
  showFlagAndDeleteAll: boolean;
  /** 是否在右键菜单中显示 */
  showContextMenu: boolean;
  /** 提交修改后是否刷新页面 */
  refreshAfterSubmit: boolean;
  /** 刷新时是否跳过缓存 */
  skipCacheRefresh: boolean;
  /** 是否启用最大 Cookie 存活时间 */
  useMaxCookieAge: boolean;
  /** 最大存活时间单位 (秒) */
  maxCookieAgeType: number;
  /** 最大存活时间数值 */
  maxCookieAge: number;
  /** 是否使用自定义语言 */
  useCustomLocale: boolean;
  /** 自定义语言代码 */
  customLocale: string;
  /** 导出格式: json | netscape | semicolonPairs | lpw */
  copyCookiesType: string;
  /** 是否在圣诞期间显示圣诞图标 */
  showChristmasIcon: boolean;
  /** Cookie 排序方式 */
  sortCookiesType: string;
  /** 是否显示 DevTools 面板 */
  showDevToolsPanel: boolean;
}

/**
 * 扩展的运行时统计数据。
 * 所有字段通过 chrome.storage.local 持久化，键名前缀为 "data_"。
 */
export interface AppState {
  /** 拦截/过滤规则列表 */
  filters: FilterRule[];
  /** 只读保护规则列表 */
  readOnly: ReadOnlyRule[];
  /** 累计创建的 Cookie 数 */
  nCookiesCreated: number;
  /** 累计修改的 Cookie 数 */
  nCookiesChanged: number;
  /** 累计删除的 Cookie 数 */
  nCookiesDeleted: number;
  /** 累计被保护的 Cookie 数 */
  nCookiesProtected: number;
  /** 累计被标记/拦截的 Cookie 数 */
  nCookiesFlagged: number;
  /** 累计被缩短生命周期的 Cookie 数 */
  nCookiesShortened: number;
  /** 累计点击 Popup 次数 */
  nPopupClicked: number;
  /** 累计点击 DevTools Panel 次数 */
  nPanelClicked: number;
  /** 累计导入 Cookie 数 */
  nCookiesImported: number;
  /** 累计导出 Cookie 数 */
  nCookiesExported: number;
  /** 上次运行的版本号 (用于检测首次安装/更新) */
  lastVersionRun?: string;
}

/**
 * Cookie 拦截/过滤规则。
 * 匹配的 Cookie 会被自动删除。
 */
export interface FilterRule {
  /** 域名匹配正则 (空/undefined = 任意) */
  domain?: string;
  /** 名称匹配正则 (空/undefined = 任意) */
  name?: string;
  /** 值匹配正则 (空/undefined = 任意) */
  value?: string;
}

/**
 * Cookie 只读保护规则。
 * 匹配的 Cookie 被删除时会被自动恢复。
 */
export interface ReadOnlyRule {
  /** 域名 */
  domain: string;
  /** Cookie 名称 */
  name: string;
  /** 路径 */
  path: string;
  /** 是否 secure */
  secure: boolean;
  /** Cookie Store ID */
  storeId: string;
}

/**
 * Cookie 导出/导入数据格式。
 * 支持单个 Cookie 或 Cookie 数组的 JSON 格式。
 */
export type ExportData = Cookie | Cookie[];

/**
 * 后台消息动作类型 (用于 devtools -> background 通信)。
 */
export type BackgroundAction =
  | "getall"
  | "submitCookie"
  | "refresh";

/**
 * 后台响应消息。
 */
export interface BackgroundMessage {
  action: BackgroundAction;
  tabId?: number;
  url?: string;
  cks?: Cookie[];
  cookie?: Cookie;
  origName?: string;
}

/**
 * Popup URL 参数 (通过查询字符串传递)。
 */
export interface PopupUrlParams {
  url?: string;
  id?: string;
  incognito?: string;
}
