/**
 * 网页万能复制 (Universal Copy - Enable Copy) v1.0.28
 * Chrome Extension Manifest V3 类型定义
 */

// ============================================================
// Chrome Extension API 类型 (子集)
// ============================================================

/** Chrome Storage 存储键值映射 */
export interface StorageMap {
  /** 域名白名单列表 */
  hostList: string[];
  /** 域名列表最后更新时间戳 */
  updateTime: number;
  /** 扩展安装类型 (normal/development/sideload) */
  installType: string;
  /** 用户唯一标识 (UUID v4) */
  uid: string;
  /** 安装时间戳 (秒) */
  install_time: string;
  /** 复制操作计数 */
  copyTimes: number;
  /** 弹窗提示计数 */
  alertTimes: number;
  /** IP 信息对象 */
  ipInfo: IpInfo | null;
  /** 日志发送缓冲区 */
  arr: LogEntry[];
  /** 评分对话框状态 */
  rate_dialog: RateDialogState;
  /** 预置书签菜单列表 */
  menuList: MenuItem[] | null;
  /** UI 语言设置 */
  zbaseLanguage: string;
  /** 是否显示 AI logo */
  isShowAiLogo: boolean;
  /** 是否显示 PDF logo */
  isShowPdfLogo: boolean;
  /** 全文复制内容缓存 */
  allcopy: string;
}

/** IP 信息 (来自 ipinfo.io 或 ip-api.com) */
export interface IpInfo {
  ip?: string;
  query?: string;
  country?: string;
  city?: string;
  region?: string;
  org?: string;
  status?: number;
}

/** 日志条目 (发送至阿里云 SLS) */
export interface LogEntry {
  extension_name: string;
  version: string;
  user_ip: string;
  uuid: string;
  install_time: string;
  event_time: string;
  event_category: string;
  event_operate: string;
  event_tag: string;
  browser_type: 'chrome' | 'edge';
  operate_system: string;
  region: string;
  language: string;
  url: string;
}

/** 评分对话框状态 */
export interface RateDialogState {
  masterSwitch: boolean;
  useCount: number;
  openLater: string | null;
}

/** 书签菜单项 */
export interface MenuItem {
  menuName: string;
  id: number;
  bookmarks: ChromeTabInfo[];
}

/** Chrome Tab 简约信息 */
export interface ChromeTabInfo {
  active: boolean;
  audible: boolean;
  autoDiscardable: boolean;
  discarded: boolean;
  favIconUrl: string;
  groupId: number;
  height: number;
  highlighted: boolean;
  id: number;
  incognito: boolean;
  index: number;
  mutedInfo: { muted: boolean };
  pinned: boolean;
  selected: boolean;
  status: string;
  title: string;
  url: string;
  width: number;
  windowId: number;
}

// ============================================================
// 消息通信类型
// ============================================================

/** 消息动作类型枚举 */
export type MessageAction =
  | 'sendAli'
  | 'confirmCopy'
  | 'doc88'
  | 'saveUseCount'
  | 'jmpEx';

/** 后台消息命令类型 */
export type BackgroundCmd = 'isNormalCrack';

/** 内容脚本消息类型 */
export type ContentMsgType =
  | 'isCrack'
  | 'web_crack'
  | 'showAlertBox';

/** Content Script -> Background 消息 */
export interface ContentToBackgroundMessage {
  action?: MessageAction;
  type?: 'copy' | 'crack' | 'deleteUrl' | 'ext_to_pdf' | 'ext_to_ai' | 'click';
  control?: boolean | string;
  lable?: string;
  cmd?: BackgroundCmd;
  zbaseType?: string;
  msg?: string;
}

/** Background -> Content Script 消息 */
export interface BackgroundToContentMessage {
  msg: ContentMsgType;
}

/** Message 响应 */
export interface MessageResponse {
  isCrack?: boolean;
  webcopy_result?: boolean;
  status?: number;
}

// ============================================================
// 站点适配器类型
// ============================================================

/** 站点适配器接口 */
export interface SiteAdapter {
  /** 匹配 URL 的正则表达式 */
  regexp: RegExp;
  /** 初始化方法 (注入 CSS/JS) */
  init(): void;
  /** 获取选中文本 (可选，默认走通用逻辑) */
  getSelectedText?(): string;
}

/** 破解配置 */
export interface CrackConfig {
  /** 是否初始化复制事件监听 */
  initCopyEvent: boolean;
}

// ============================================================
// 日志/遥测类型
// ============================================================

/** SLS Logger 配置 */
export interface SlsConfig {
  host: string;
  project: string;
  logstore: string;
  time: number;
  count: number;
}

/** 远程配置 API 响应 */
export interface RemoteConfig {
  masterSwitch: boolean;
  // 其他远程配置项...
}

// ============================================================
// 扩展元数据类型
// ============================================================

/** Manifest 扩展信息 */
export interface ExtensionManifest {
  name: string;
  version: string;
  description: string;
  homepage_url: string;
  manifest_version: 3;
  permissions: string[];
  host_permissions: string[];
  background: { service_worker: string };
  content_scripts: ContentScriptConfig[];
  action: ExtensionAction;
  options_page: string;
  web_accessible_resources: WebAccessibleResource[];
  default_locale: string;
}

/** Content Script 配置 */
export interface ContentScriptConfig {
  js: string[];
  css: string[];
  matches: string[];
  exclude_matches: string[];
  run_at: 'document_start' | 'document_end' | 'document_idle';
}

/** Extension Action (工具栏按钮) */
export interface ExtensionAction {
  default_icon: string;
  default_popup: string;
  default_title: string;
}

/** Web 可访问资源 */
export interface WebAccessibleResource {
  resources: string[];
  matches: string[];
}
