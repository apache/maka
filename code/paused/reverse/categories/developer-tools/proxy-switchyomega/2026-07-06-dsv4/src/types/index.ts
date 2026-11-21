// ========================================
// Proxy SwitchyOmega (V3) v3.0.5 — TypeScript 类型定义
// 从 JS 源码的运行时变量使用模式、API 调用和存储键名推断
// ========================================

// ========================================
// 1. 配置类型 (Profile)
// ========================================

/** 配置类型枚举 */
export enum ProfileType {
  DirectProfile = 'DirectProfile',
  SystemProfile = 'SystemProfile',
  AutoDetectProfile = 'AutoDetectProfile',
  FixedProfile = 'FixedProfile',
  PacProfile = 'PacProfile',
  VirtualProfile = 'VirtualProfile',
  SwitchProfile = 'SwitchProfile',
  RuleListProfile = 'RuleListProfile',
}

/** 配置名称键 (存储中以 '+' 为前缀, 如 "+proxy") */
export type ProfileKey = `+${string}`;

/** 配置基础字段 */
export interface ProfileBase {
  /** 配置名称 */
  name: string;
  /** 配置类型 */
  profileType: ProfileType;
  /** 颜色 (hex) */
  color: string;
  /** 是否为内置配置 (不可删除) */
  builtin?: boolean;
  /** 修订版本号 (变更时自动递增) */
  revision?: string;
  /** 格式标识 (用于 RuleListProfile 格式识别) */
  format?: string;
}

// ---- 固定代理配置 ----

/** 代理协议 */
export type ProxyScheme = 'http' | 'https' | 'socks4' | 'socks5';

/** 代理服务器配置 */
export interface ProxyConfig {
  /** 代理协议 */
  scheme: ProxyScheme;
  /** 代理主机 */
  host: string;
  /** 代理端口 */
  port: number;
}

/** 代理认证凭据 */
export interface ProxyAuth {
  /** 用户名 */
  username: string;
  /** 密码 */
  password: string;
}

/** 按 URL scheme 分离的代理配置 */
export interface ProxyForScheme {
  /** 默认回退代理 */
  fallbackProxy?: ProxyConfig;
  /** HTTP 协议专用代理 */
  proxyForHttp?: ProxyConfig;
  /** HTTPS 协议专用代理 */
  proxyForHttps?: ProxyConfig;
  /** FTP 协议专用代理 */
  proxyForFtp?: ProxyConfig;
}

/** 固定代理配置 (FixedProfile) */
export interface FixedProfile extends ProfileBase, ProxyForScheme {
  profileType: ProfileType.FixedProfile;
  /** 绕行列表 (不走代理的域名/IP) */
  bypassList?: BypassCondition[];
  /** 代理认证信息 (按 scheme 分离) */
  auth?: {
    fallbackProxy?: ProxyAuth;
    proxyForHttp?: ProxyAuth;
    proxyForHttps?: ProxyAuth;
    proxyForFtp?: ProxyAuth;
  };
}

// ---- PAC 代理配置 ----

/** PAC 代理配置 (PacProfile) */
export interface PacProfile extends ProfileBase {
  profileType: ProfileType.PacProfile;
  /** PAC 脚本 URL (可选, 用于远程 PAC) */
  pacUrl?: string;
  /** PAC 脚本内容 */
  pacScript?: string;
  /** 最近更新时间 */
  lastUpdate?: string;
  /** PAC 认证 */
  auth?: {
    all?: ProxyAuth;
  };
}

// ---- 虚拟配置 ----

/** 虚拟配置 (VirtualProfile, 指向另一个配置) */
export interface VirtualProfile extends ProfileBase {
  profileType: ProfileType.VirtualProfile;
  /** 默认指向的配置名 */
  defaultProfileName: string;
}

// ---- 切换配置 ----

/** 切换配置 (SwitchProfile, 按条件选择不同配置) */
export interface SwitchProfile extends ProfileBase {
  profileType: ProfileType.SwitchProfile;
  /** 默认指向的配置名 */
  defaultProfileName: string;
  /** 条件规则列表 (通常存储在附加的 RuleListProfile 中) */
  rules?: Rule[];
}

// ---- 规则列表配置 ----

/** 规则列表配置 (RuleListProfile) */
export interface RuleListProfile extends ProfileBase {
  profileType: ProfileType.RuleListProfile;
  /** 默认回退配置名 */
  defaultProfileName: string;
  /** 规则列表内容 (内联格式) */
  ruleList?: string;
  /** 远程规则列表 URL */
  sourceUrl?: string;
  /** 最近更新时间 */
  lastUpdate?: string;
  /** 规则列表格式 */
  format?: 'Switchy' | 'AutoProxy' | string;
}

/** 配置联合类型 */
export type Profile =
  | FixedProfile
  | PacProfile
  | VirtualProfile
  | SwitchProfile
  | RuleListProfile;

// ========================================
// 2. 条件匹配类型 (Condition)
// ========================================

/** 条件类型枚举 */
export enum ConditionType {
  HostWildcardCondition = 'HostWildcardCondition',
  HostRegexCondition = 'HostRegexCondition',
  HostLevelsCondition = 'HostLevelsCondition',
  IpCondition = 'IpCondition',
  UrlWildcardCondition = 'UrlWildcardCondition',
  UrlRegexCondition = 'UrlRegexCondition',
  KeywordCondition = 'KeywordCondition',
  WeekdayCondition = 'WeekdayCondition',
  TimeCondition = 'TimeCondition',
  FalseCondition = 'FalseCondition',
  TrueCondition = 'TrueCondition',
  BypassCondition = 'BypassCondition',
}

/** 基础条件接口 */
export interface ConditionBase {
  conditionType: ConditionType;
}

/** 主机通配符条件 */
export interface HostWildcardCondition extends ConditionBase {
  conditionType: ConditionType.HostWildcardCondition;
  /** 通配符匹配模式, 如 "*.google.com" */
  pattern: string;
}

/** 主机正则条件 */
export interface HostRegexCondition extends ConditionBase {
  conditionType: ConditionType.HostRegexCondition;
  pattern: string;
}

/** 主机层级条件 */
export interface HostLevelsCondition extends ConditionBase {
  conditionType: ConditionType.HostLevelsCondition;
  /** 主机层级数 */
  hostLevels: number;
}

/** IP 条件 */
export interface IpCondition extends ConditionBase {
  conditionType: ConditionType.IpCondition;
  /** IP 地址 */
  ip: string;
  /** 前缀长度 (CIDR) */
  prefixLength: number;
}

/** URL 通配符条件 */
export interface UrlWildcardCondition extends ConditionBase {
  conditionType: ConditionType.UrlWildcardCondition;
  pattern: string;
}

/** URL 正则条件 */
export interface UrlRegexCondition extends ConditionBase {
  conditionType: ConditionType.UrlRegexCondition;
  pattern: string;
}

/** 关键字条件 */
export interface KeywordCondition extends ConditionBase {
  conditionType: ConditionType.KeywordCondition;
  pattern: string;
}

/** 星期条件 (按星期几匹配) */
export interface WeekdayCondition extends ConditionBase {
  conditionType: ConditionType.WeekdayCondition;
  /** 7 字符字符串, 每位代表一天, 格式: "SMTWtFs" */
  days: string;
  startDay?: number;
  endDay?: number;
}

/** 时间条件 (按时间段匹配) */
export interface TimeCondition extends ConditionBase {
  conditionType: ConditionType.TimeCondition;
  /** 起始时间 (分钟) */
  startMinute: number;
  /** 结束时间 (分钟) */
  endMinute: number;
}

/** 始终为假条件 (永不匹配) */
export interface FalseCondition extends ConditionBase {
  conditionType: ConditionType.FalseCondition;
}

/** 绕行条件 (Bypass) */
export interface BypassCondition extends ConditionBase {
  conditionType: ConditionType.BypassCondition;
  /** 不经过代理的主机/IP 模式 */
  pattern: string;
}

/** 条件联合类型 */
export type Condition =
  | HostWildcardCondition
  | HostRegexCondition
  | HostLevelsCondition
  | IpCondition
  | UrlWildcardCondition
  | UrlRegexCondition
  | KeywordCondition
  | WeekdayCondition
  | TimeCondition
  | FalseCondition
  | BypassCondition;

// ========================================
// 3. 规则类型 (Rule)
// ========================================

/** 匹配规则 (将条件映射到配置) */
export interface Rule {
  /** 匹配条件 */
  condition: Condition;
  /** 目标配置名 */
  profileName: string;
  /** 是否为临时规则 */
  isTempRule?: boolean;
  /** 规则来源 (原始匹配源) */
  source?: string;
  /** 备注 */
  note?: string;
}

// ========================================
// 4. 全局选项类型 (Options / 根配置状态)
// ========================================

/** 全局选项接口 — 存储中的完整配置 */
export interface OmegaOptions {
  /** 所有用户自定义配置, 键格式 "+profileName" */
  [key: ProfileKey]: Profile;

  /** 当前活动配置名 */
  '-currentProfileName'?: string;

  /** 启动时默认配置名 */
  '-startupProfileName'?: string;

  /** 快速切换配置列表 */
  '-quickSwitchProfiles': string[];

  /** 是否显示高级条件类型 */
  '-showConditionTypes'?: number;

  /** 是否确认删除 */
  '-confirmDeletion'?: boolean;

  /** 是否确认切换 */
  '-confirmSwitch'?: boolean;

  /** 自定义 CSS */
  '-customCss'?: string;

  /** 是否使用旧版规则导出格式 */
  '-exportLegacyRuleList'?: boolean;

  /** 主题键名 */
  '-theme'?: string;
}

// ========================================
// 5. 运行时状态类型 (State)
// ========================================

/** chrome.storage.local 中存储的运行时状态鍵 */
export enum StateKey {
  /** 当前配置名 */
  currentProfileName = 'currentProfileName',
  /** 首次运行标记 */
  firstRun = 'firstRun',
  /** 自定义 CSS */
  customCss = 'customCss',
  /** 同步选项配置 */
  syncOptions = 'syncOptions',
  /** 在线恢复 URL */
  'web.restoreOnlineUrl' = 'web.restoreOnlineUrl',
  /** 最后访问的 URL */
  'web.last_url' = 'web.last_url',
  /** 切换引导状态 */
  'web.switchGuide' = 'web.switchGuide',
  /** 配置编辑器状态 */
  'web._profileEditor.{name}' = 'web._profileEditor',
  /** 代理实现特性 */
  proxyImplFeatures = 'proxyImplFeatures',
  /** 检查 URL */
  inspectUrl = 'inspectUrl',
  /** 刷新选项 */
  'omega.local.refreshOnProfileChange' = 'omega.local.refreshOnProfileChange',
  /** 同步选项 */
  'omega.local.syncOptions' = 'omega.local.syncOptions',
}

// ========================================
// 6. 消息通信类型 (Message)
// ========================================

/** 后台消息请求 */
export interface BackgroundRequest {
  /** 方法名 */
  method: string;
  /** 方法参数 */
  args: unknown[];
  /** 是否无需回复 */
  noReply?: boolean;
  /** 是否刷新活动页面 */
  refreshActivePage?: boolean;
}

/** 后台消息响应 */
export interface BackgroundResponse {
  /** 成功结果 */
  result?: unknown;
  /** 错误信息 */
  error?: EncodedError;
}

/** 序列化的错误对象 */
export interface EncodedError {
  _error: 'error';
  name: string;
  message: string;
  stack: string;
  original?: Error;
}

/** URL 变更消息 (content_scripts.js -> background) */
export interface UrlChangeMessage {
  type: 'url-change';
  hasTransition: boolean;
}

// ========================================
// 7. 代理决策结果类型
// ========================================

/** 单个 URL 的匹配结果 */
export interface MatchResult {
  /** 匹配到的配置名 */
  profileName: string;
  /** 是否为临时规则 */
  isTempRule?: boolean;
  /** 匹配条件 */
  condition?: Condition;
  /** 匹配来源 */
  source?: string;
}

/** 代理决策结果 */
export interface ProxyAction {
  /** 最终匹配配置 */
  profile: Profile;
  /** 详细匹配结果列表 */
  results: (MatchResult | [string, unknown[] | string | Condition])[];
}

/** 代理操作 (用于 Chrome API) */
export interface ChromeProxyConfig {
  mode: 'direct' | 'system' | 'auto_detect' | 'fixed_servers' | 'pac_script';
  rules?: {
    singleProxy?: {
      scheme: ProxyScheme;
      host: string;
      port: number;
    };
    bypassList?: string[];
  };
  pacScript?: {
    url?: string;
    data?: string;
    mandatory?: boolean;
  };
}

// ========================================
// 8. 页面信息类型
// ========================================

/** 活动标签页信息 */
export interface PageInfo {
  /** 标签页 ID */
  tabId: number;
  /** 页面 URL */
  url: string;
  /** 页面域名 */
  domain?: string;
  /** 错误原因 */
  errorReason?: string;
}

// ========================================
// 9. UI 相关类型
// ========================================

/** UI 图标信息 */
export interface IconInfo {
  /** 图标 ImageData */
  [size: number]: ImageData;
}

/** UI 警告信息 */
export interface AlertInfo {
  type: 'success' | 'warning' | 'error' | 'danger';
  message?: string;
  i18n?: string;
}

/** 主题定义 */
export interface ThemeDefinition {
  /** 是否为暗色主题 */
  dark: boolean;
  /** 显示名称 */
  displayName?: string;
  /** 主题键名 */
  key?: string;
}

// ========================================
// 10. 同步选项类型
// ========================================

/** 选项同步配置 */
export interface SyncOptions {
  /** 是否启用同步 */
  enabled: boolean;
  /** 同步间隔 (分钟) */
  syncInterval?: number;
  /** 是否强制同步 */
  force?: boolean;
}

// ========================================
// 11. 代理级别控制信息
// ========================================

/** Chrome proxy.onProxyError / 代理变更详情 */
export interface ProxyChangeDetails {
  /** 代理控制级别 */
  levelOfControl?:
    | 'controlled_by_this_extension'
    | 'controlled_by_other_extensions'
    | 'not_controllable'
    | 'controllable_by_this_extension';
  /** 错误信息 */
  error?: string;
  /** 是否为致命错误 */
  fatal?: boolean;
}

// ========================================
// 12. 页面统计 (Analytics) 类型
// ========================================

/** 分析上报的数据结构 */
export interface AnalyticsPayload {
  /** 事件名称 */
  name: 'SO';
  /** 页面 URL */
  url: string;
  /** 来源 URL */
  referrer?: string;
  /** 时间戳 */
  timestamp: number;
  /** 用户唯一标识 */
  user_id: string;
}
