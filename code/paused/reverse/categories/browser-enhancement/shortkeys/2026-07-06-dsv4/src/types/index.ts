// ========================================
// Shortkeys v5.0.1 — TypeScript 类型定义
// 从 Vite 打包的 JS 中推断还原
// ========================================

// ========================================
// 快捷键核心类型
// ========================================

/** 快捷键实体的完整定义 */
export interface Shortcut {
  /** 唯一标识符 (UUID v4) */
  id: string;
  /** 快捷键组合 (如 "ctrl+shift+k") */
  key: string;
  /** 绑定的操作标识符 */
  action: ShortcutActionType;
  /** 用户自定义标签 (显示在 cheat sheet 中) */
  label?: string;
  /** 是否启用 */
  enabled?: boolean;
  /** 是否在输入框中激活 */
  activeInInputs?: boolean;
  /** 所属分组名称 */
  group?: string;

  // === 操作特定配置 ===
  /** JavaScript 代码 (action=javascript 时) */
  code?: string;
  /** 目标 URL (action=openurl/gototab 时) */
  openurl?: string;
  /** 匹配 URL 模式 (action=gototab 时) */
  matchurl?: string;
  /** 匹配标题模式 (action=gototabbytitle 时) */
  matchtitle?: string;
  /** 匹配索引 (action=gototabbyindex 时) */
  matchindex?: string;
  /** 书签标题 (action=openbookmark* 时) */
  bookmark?: string;
  /** Chrome App ID (action=openapp 时) */
  openappid?: string;
  /** 插入文本 (action=inserttext 时) */
  inserttext?: string;
  /** 触发的其他快捷键 (action=trigger 时) */
  trigger?: string;
  /** CSS 选择器 (action=buttonnexttab 时) */
  button?: string;
  /** 标签页组名称 (action=grouptab/togglegrouptab/namegroup 时) */
  groupname?: string;
  /** 是否仅当前窗口匹配 (action=gototab 时) */
  currentWindow?: boolean;
  /** 是否启用平滑滚动 (action=scroll* 时) */
  smoothScrolling?: boolean;
  /** 宏步骤列表 (action=macro 时) */
  macroSteps?: MacroStep[];

  // === 站点过滤 ===
  /** 黑名单模式: true=黑名单, false=白名单, "true"/"false" 字符串 */
  blacklist?: boolean | string;
  /** 站点过滤规则列表 (glob 或正则) */
  sitesArray?: string[];
}

// ========================================
// 操作类型枚举
// ========================================

/** 所有内建操作的标识符联合类型 */
export type ShortcutActionType =
  // === 标签页操作 (Tabs) ===
  | "newtab" | "newtabright" | "closetab" | "onlytab"
  | "closelefttabs" | "closerighttabs" | "closeduplicatetabs"
  | "clonetab" | "movetabtonewwindow" | "reopentab"
  | "nexttab" | "prevtab" | "firsttab" | "lasttab"
  | "lastusedtab" | "audibletab" | "togglepin" | "togglemute"
  | "movetableft" | "movetabright" | "movetabtofirst" | "movetabtolast"
  | "sorttabs" | "discardtab"
  | "grouptab" | "ungrouptab" | "togglegrouptab"
  | "namegroup" | "collapsegroup"
  | "selecttableft" | "selecttabright"
  | "gototab" | "gototabbytitle" | "gototabbyindex"

  // === 窗口操作 (Windows) ===
  | "newwindow" | "newprivatewindow" | "closewindow" | "fullscreen"

  // === 缩放操作 (Zooming) ===
  | "zoomin" | "zoomout" | "zoomreset"

  // === 导航操作 (Location) ===
  | "back" | "forward" | "reload" | "hardreload"
  | "copyurl" | "copypagetitle" | "copytitleurl" | "copytitleurlmarkdown"
  | "openclipboardurl" | "openclipboardurlnewtab" | "openurl"
  | "opensettings" | "openextensions" | "openshortcuts"
  | "urlup" | "urlroot" | "urlinc" | "urldec" | "editurl"
  | "nextpage" | "prevpage"
  | "searchgoogle" | "searchyoutube" | "searchwikipedia" | "searchgithub"

  // === 滚动操作 (Scrolling) ===
  | "top" | "bottom"
  | "scrolldown" | "scrolldownmore" | "pagedown"
  | "scrollup" | "scrollupmore" | "pageup"
  | "scrollright" | "scrollrightmore"
  | "scrollleft" | "scrollleftmore"

  // === 书签操作 (Bookmarks) ===
  | "openbookmark" | "openbookmarknewtab"
  | "openbookmarkbackgroundtab" | "openbookmarkbackgroundtabandclose"

  // === 视频控制 (Video Controls) ===
  | "videoplaypause" | "videomute" | "videofullscreen"
  | "videospeedup" | "videospeeddown" | "videospeedreset"
  | "videoskipforward" | "videoskipback"

  // === 页面工具 (Page Tools) ===
  | "showcheatsheet" | "toggledarkmode"
  | "linkhints" | "linkhintsnew"

  // === 脚本操作 ===
  | "javascript" | "macro"
  | `script-${string}`

  // === 杂项 ===
  | "showlatestdownload" | "cleardownloads" | "viewsource" | "print"
  | "disable" | "trigger" | "inserttext" | "buttonnexttab"
  | "openapp" | "togglebookmark" | "openincognito"
  | "capturescreenshot" | "capturefullsizescreenshot"
  | "forcecapturefullsizescreenshot"
  | "focusinput";

// ========================================
// 内建操作分类元数据
// ========================================

/** 操作分类元数据 */
export interface ActionMeta {
  /** 操作标识符 */
  value: ShortcutActionType;
  /** 显示标签 */
  label: string;
  /** 描述文字 */
  description: string;
  /** 是否为内建操作 (非用户自定义) */
  builtin?: boolean;
}

/** 操作分类目录 */
export type ActionCategory =
  | "Scrolling" | "Location" | "Bookmarks" | "Tabs"
  | "Windows" | "Zooming" | "Miscellaneous"
  | "Video Controls" | "Search Providers"
  | "Page Tools" | "Link Hints" | "Page Scripts";

/** 所有内建操作分类表 */
export type BuiltinActions = Record<ActionCategory, ActionMeta[]>;

// ========================================
// 页面脚本定义
// ========================================

/** 内建页面脚本 (用户可绑定到快捷键的预置脚本) */
export interface PageScript {
  /** 脚本唯一标识 (如 "dark-mode") */
  id: string;
  /** 脚本名称 */
  name: string;
  /** 脚本描述 */
  description: string;
  /** 所属分类 */
  category: string;
  /** IIFE 格式的 JavaScript 代码 */
  code: string;
}

// ========================================
// 宏系统
// ========================================

/** 宏步骤定义 */
export interface MacroStep {
  /** 操作类型 */
  action: ShortcutActionType;
  /** JavaScript 代码 (action=javascript 时) */
  code?: string;
  /** 延迟时间 (毫秒) */
  delay?: number;
}

/** 宏执行最大步骤数限制 */
export const MACRO_MAX_STEPS = 10;

// ========================================
// 快捷键分组
// ========================================

/** 快捷键分组设置 */
export interface GroupSettings {
  [groupName: string]: GroupConfig;
}

/** 单个分组的配置 */
export interface GroupConfig {
  /** 激活域名列表 (每行一个, glob 或正则) */
  activateOn?: string;
  /** 停用域名列表 (每行一个, glob 或正则) */
  deactivateOn?: string;
}

// ========================================
// 存储 Schema
// ========================================

/** chrome.storage 键名常量 */
export const STORAGE_KEYS = {
  /** 快捷键数据 (JSON 字符串) */
  KEYS: "keys",
  /** 分组设置 (JSON 字符串) */
  GROUP_SETTINGS: "groupSettings",
  /** 使用统计 (JSON 对象) */
  USAGE: "usage",
  /** 每日使用统计 (JSON 数组) */
  USAGE_DAILY: "usageDaily",
  /** 使用统计开关 */
  USAGE_ENABLED: "usageEnabled",
  /** 同步迁移标记 */
  MIGRATED_TO_SYNC: "__shortkeys_migrated_to_sync",
} as const;

/** 快捷键存储格式 (JSON 字符串, 存储在 keys 键下) */
export type ShortcutStorage = Shortcut[];

/** 同步存储大小上限 (字节) */
export const SYNC_STORAGE_QUOTA = 102400; // 100KB
/** 安全余量 (字节) */
export const SYNC_STORAGE_SAFETY_MARGIN = 1024;

// ========================================
// 使用统计
// ========================================

/** 单个快捷键的使用统计 */
export interface UsageStats {
  /** 使用次数 */
  count: number;
  /** 首次使用时间 (Unix ms) */
  firstUsed: number;
  /** 最后使用时间 (Unix ms) */
  lastUsed: number;
}

/** 全局使用统计 (快捷键 ID → 统计) */
export type UsageMap = Record<string, UsageStats>;

/** 每日使用统计条目 */
export interface DailyUsageEntry {
  /** 日期 (YYYY-MM-DD) */
  date: string;
  /** 当日记数 (快捷键 ID → 次数) */
  counts: Record<string, number>;
}

/** 每日使用统计 (保留最近 90 天) */
export type DailyUsage = DailyUsageEntry[];

// ========================================
// 消息通信类型
// ========================================

/** 后台 ↔ 内容脚本消息类型 */
export type RuntimeMessage =
  | { action: "getKeys"; url: string }
  | { action: "refreshKeys" }
  | { action: "showcheatsheet" }
  | { action: "toggledarkmode" }
  | { action: "linkhints" }
  | { action: "linkhintsnew" }
  | { action: "editurl" }
  | { action: "trackUsage"; shortcutId: string }
  | { action: "fetchUrl"; url: string }
  | { action: "lastusedtab" }
  | { action: "capturescreenshot" }
  | { action: "capturefullsizescreenshot" }
  | { action: "forcecapturefullsizescreenshot" }
  | { action: ShortcutActionType; id?: string; [key: string]: unknown };

/** 外部消息 (从 shortkeys.app 或 localhost 接收) */
export interface ExternalMessage {
  action: "importShortcuts";
  shortcuts: Shortcut[];
}

/** 外部消息响应 */
export interface ExternalMessageResponse {
  success: boolean;
  count?: number;
}

// ========================================
// Chrome Commands API
// ========================================

/** manifest.json 中声明的 commands 键名 */
export type ChromeCommandId =
  | `01-newtab` | `02-closetab` | `03-nexttab` | `04-prevtab`
  | `05-togglepin` | `06-togglemute` | `07-onlytab`
  | `08-closelefttabs` | `09-closerighttabs` | `10-closeduplicatetabs`
  | `11-clonetab` | `12-movetabtonewwindow` | `13-reopentab`
  | `14-firsttab` | `15-lasttab` | `16-lastusedtab`
  | `17-movetableft` | `18-movetabright` | `19-movetabtofirst`
  | `20-movetabtolast` | `21-sorttabs` | `22-discardtab`
  | `23-newwindow` | `24-newprivatewindow` | `25-closewindow`
  | `26-fullscreen`
  | `27-zoomin` | `28-zoomout` | `29-zoomreset`
  | `30-back` | `31-forward` | `32-reload` | `33-hardreload`
  | `34-copyurl` | `35-copypagetitle` | `36-copytitleurl`
  | `37-copytitleurlmarkdown` | `38-openclipboardurl`
  | `39-openclipboardurlnewtab` | `40-searchgoogle`
  | `41-opensettings` | `42-openextensions` | `43-openshortcuts`
  | `44-top` | `45-bottom` | `46-scrolldown` | `47-scrolldownmore`
  | `48-pagedown` | `49-scrollup` | `50-scrollupmore` | `51-pageup`
  | `52-scrollright` | `53-scrollrightmore`
  | `54-scrollleft` | `55-scrollleftmore`
  | `56-cleardownloads` | `57-showlatestdownload`
  | `58-viewsource` | `59-print` | `60-togglebookmark`
  | `61-openincognito` | `62-capturescreenshot`
  | `63-capturefullsizescreenshot` | `64-forcecapturefullsizescreenshot`
  | `65-disable` | `66-disable` | `67-disable` | `68-disable`
  | `69-disable` | `70-disable`
  | `71-videoplaypause` | `72-videomute` | `73-videofullscreen`
  | `74-videospeedup` | `75-videospeeddown` | `76-videospeedreset`
  | `77-videoskipforward` | `78-videoskipback`
  | `79-searchyoutube` | `80-searchwikipedia` | `81-searchgithub`
  | `82-newtabright` | `83-audibletab`
  | `84-grouptab` | `85-ungrouptab` | `86-togglegrouptab`
  | `87-namegroup` | `88-collapsegroup`
  | `91-selecttableft` | `92-selecttabright`;

/** Chrome Command 描述 */
export interface ChromeCommand {
  description: string;
}

// ========================================
// 链接提示 (Link Hints) 系统
// ========================================

/** 链接提示字符集 (用于生成标签) */
export const HINT_CHARSET = "SADFJKLEWCMPGH";

/** 可点击元素 CSS 选择器 (用于链接提示) */
export const CLICKABLE_SELECTOR = [
  "a[href]", "button:not([disabled])",
  "input:not([type=hidden]):not([disabled])",
  "select:not([disabled])", "textarea:not([disabled])",
  '[role="button"]', '[role="link"]',
  '[role="tab"]', '[role="menuitem"]', '[role="option"]',
  "[onclick]",
  '[contenteditable="true"]', '[contenteditable=""]',
  "summary", "details > summary",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** 链接提示状态 */
export interface LinkHintsState {
  /** 提示标签映射 (标签字符 → 目标元素) */
  hints: Map<string, { overlay: HTMLElement; target: HTMLElement }>;
  /** 用户已输入的字符 */
  typed: string;
  /** 是否在新标签页中打开 */
  openInNewTab: boolean;
  /** 提示容器 DOM 元素 */
  container: HTMLElement | null;
  /** 键盘事件监听器 */
  keydownListener: ((e: KeyboardEvent) => void) | null;
}

// ========================================
// 截图系统
// ========================================

/** 截图最大高度 (Chrome 限制) */
export const SCREENSHOT_MAX_HEIGHT = 16348;

/** Chrome DevTools Protocol 版本 (用于截图) */
export const CDP_VERSION = "1.3";

/** 截图选项 */
export interface ScreenshotOptions {
  /** 是否截取完整页面 */
  fullsize?: boolean;
  /** 是否强制完整高度 (忽略限制) */
  force?: boolean;
}

// ========================================
// 键盘处理 (Mousetrap.js 集成)
// ========================================

/** 键盘修饰键 */
export type ModifierKey = "shift" | "ctrl" | "alt" | "meta";

/** 键盘组合解析结果 */
export interface KeyCombo {
  /** 主键 */
  key: string;
  /** 修饰键列表 */
  modifiers: ModifierKey[];
  /** 事件类型 (keydown/keypress/keyup) */
  action: string;
}

// ========================================
// 内容脚本跳过输入框的逻辑
// ========================================

/** 需要在输入框中阻止快捷键的 ARIA role */
export const INPUT_ROLES = new Set(["textbox", "combobox", "searchbox"]);

// ========================================
// 外部通信
// ========================================

/** 外部可连接源 */
export const EXTERNAL_ORIGINS = [
  "https://shortkeys.app/*",
  "http://localhost/*",
] as const;

// ========================================
// 内容脚本操作 (不需要后台转发的操作)
// ========================================

/** 由内容脚本直接处理的操作 (不发送到后台) */
export const CONTENT_SCRIPT_ACTIONS: ShortcutActionType[] = [
  "javascript",
  "showcheatsheet",
  "toggledarkmode",
  "trigger",
  "editurl",
  "linkhints",
  "linkhintsnew",
];

// ========================================
// 通知
// ========================================

/** 设置通知 ID */
export const SETTINGS_NOTIFICATION_ID = "settingsNotification";
