/**
 * uBlock Origin Lite — TypeScript 类型定义
 * 从 JS 源码变量使用模式、API 调用、存储键名、消息类型反向推断
 * 版本: 2026.628.2035 | MV3 | GPL-3.0
 */

// ============================================================================
// 过滤模式 (Filtering Modes)
// ============================================================================

/** 过滤级别枚举 — 对应 mode-manager.js */
export const enum FilteringLevel {
  /** 无过滤 */
  NONE = 0,
  /** 基础过滤 (仅 DNR 网络规则, 无需 host 权限) */
  BASIC = 1,
  /** 最优过滤 (DNR + 特定站点 cosmetic 过滤) */
  OPTIMAL = 2,
  /** 完整过滤 (DNR + 特定站点 + 通用 cosmetic 过滤, 需 <all_urls>) */
  COMPLETE = 3,
}

/** 过滤模式详情 — 每级别包含一组 hostname */
export interface FilteringModeDetails {
  none: Set<string>;
  basic: Set<string>;
  optimal: Set<string>;
  complete: Set<string>;
}

/** 序列化版本的 FilteringModeDetails (字符串数组) */
export interface FilteringModeDetailsSerialized {
  none: string[];
  basic: string[];
  optimal: string[];
  complete: string[];
}

// ============================================================================
// 配置 (Configuration)
// ============================================================================

/** 规则集配置 — storage key: "rulesetConfig" (local + session) */
export interface RulesetConfig {
  /** 扩展版本号 */
  version: string;
  /** 已启用的规则集 ID 列表 */
  enabledRulesets: string[];
  /** 授予权限后是否自动重载标签页 */
  autoReload: boolean;
  /** 工具栏图标是否显示拦截计数 */
  showBlockedCount: boolean;
  /** 严格拦截模式 */
  strictBlockMode: boolean;
  /** 弹窗拦截模式 */
  popupBlockMode: boolean;
  /** 开发者模式 */
  developerMode: boolean;
  /** 是否拥有广泛 host 权限 */
  hasBroadHostPermissions: boolean;
  /** userScripts 权限是否可用 */
  userScripts?: boolean;
}

/** 默认配置值 */
export const defaultConfig: RulesetConfig = {
  version: '',
  enabledRulesets: [],
  autoReload: true,
  showBlockedCount: true,
  strictBlockMode: true,
  popupBlockMode: true,
  developerMode: false,
  hasBroadHostPermissions: true,
};

// ============================================================================
// 规则集 (Rulesets)
// ============================================================================

/** 单个规则集详情 */
export interface RulesetDetails {
  /** 规则集唯一标识 (如 "ublock-filters", "easylist") */
  id: string;
  /** 规则集显示名称 (i18n key) */
  name: string;
  /** 是否默认启用 */
  defaultEnabled: boolean;
  /** 是否推荐 */
  recommended: string;
  /** 规则集分组 (ads, privacy, annoyances, multipurpose, regions, custom) */
  group: string;
  /** 过滤模式要求 (basic/optimal/complete 三者之一) */
  requiring: string;
  /** 描述 (i18n key) */
  desc: string;
  /** 主页 URL */
  homeURL?: string;
  /** 所包含的 DNR 规则数 */
  ruleCount?: number;
  /** 所包含的 CSS generic 规则数 */
  cssGenericCount?: number;
  /** 所包含的 CSS specific 规则数 */
  cssSpecificCount?: number;
  /** 该规则集覆盖的 hostname 列表 */
  hostnames?: string[];
  /** 是否来自导入列表 */
  imported?: boolean;
}

/** 规则集详情列表 (Map<id, RulesetDetails>) */
export type RulesetDetailsMap = Map<string, RulesetDetails>;

// ============================================================================
// DNR 规则相关
// ============================================================================

/** DNR 规则 ID 范围常量 */
export const DNR_RULE_RANGES = {
  /** 特殊规则起始 ID */
  SPECIAL_RULES_REALM: 5_000_000,
  /** 用户自定义规则起始 ID */
  USER_RULES_BASE_RULE_ID: 9_000_000,
  /** 用户规则优先级 */
  USER_RULES_PRIORITY: 1_000_000,
  /** 可信指令起始 ID */
  TRUSTED_DIRECTIVE_BASE_RULE_ID: 8_000_000,
  /** 可信指令优先级 */
  TRUSTED_DIRECTIVE_PRIORITY: 2_000_000,
  /** 严格拦截优先级 */
  STRICTBLOCK_PRIORITY: 29,
} as const;

// ============================================================================
// 托管存储 (Managed Storage)
// ============================================================================

/** 管理员策略配置 — managed_storage.json schema */
export interface ManagedStorageConfig {
  /** 默认过滤模式: "none" | "basic" | "optimal" | "complete" */
  defaultFiltering?: string;
  /** 禁用的 UI 功能 token 列表 */
  disabledFeatures?: string[];
  /** 禁用首次运行页 */
  disableFirstRunPage?: boolean;
  /** 不进行过滤的域名列表 */
  noFiltering?: string[];
  /** 要添加/移除的规则集 (前缀 "+" 添加, "-" 移除, "-*" 禁用所有非默认列表) */
  rulesets?: string[];
  /** 弹窗拦截开关 */
  popupBlockMode?: boolean;
  /** 工具栏图标计数徽标 */
  showBlockedCount?: boolean;
  /** 严格拦截模式 */
  strictBlockMode?: boolean;
}

// ============================================================================
// 消息类型 (Message Passing)
// ============================================================================

/**
 * 扩展内部消息类型 — 所有 `request.what` 的可能值
 * 路由: runtime.onMessage → onMessage(request, sender)
 */
export type MessageWhat =
  // 无需完全初始化
  | 'insertCSS'
  | 'removeCSS'
  | 'injectCSSProceduralAPI'
  // 需要完全初始化, 不验证来源
  | 'toggleToolbarIcon'
  | 'startCustomFilters'
  | 'terminateCustomFilters'
  | 'injectCustomFilters'
  // 需要可信来源 (UBOL_ORIGIN)
  | 'applyRulesets'
  | 'getDefaultConfig'
  | 'getCurrentConfig'
  | 'getOptionsPageData'
  | 'getEnabledRulesets'
  | 'getRulesetDetails'
  | 'getEnabledRulesetsDetails'
  | 'getRulesetRules'
  | 'hasBroadHostPermissions'
  | 'setAutoReload'
  | 'setShowBlockedCount'
  | 'setStrictBlockMode'
  | 'setPopupBlockMode'
  | 'setDeveloperMode'
  | 'popupPanelData'
  | 'getFilteringMode'
  | 'gotoURL'
  | 'setFilteringMode'
  | 'setPendingFilteringMode'
  | 'getDefaultFilteringMode'
  | 'setDefaultFilteringMode'
  | 'getFilteringModeDetails'
  | 'setFilteringModeDetails'
  | 'excludeFromStrictBlock'
  | 'getMatchedRules'
  | 'showMatchedRules'
  | 'getAllDynamicRules'
  | 'getAllSessionRules'
  | 'getEffectiveUserRules'
  | 'updateUserDnrRules'
  | 'getAllCustomFilters'
  | 'addCustomFilters'
  | 'addManyCustomFilters'
  | 'removeCustomFilters'
  | 'removeAllCustomFilters'
  | 'getSandboxFilters'
  | 'setSandboxFilters'
  | 'customFiltersFromHostname'
  | 'getRegisteredContentScripts'
  | 'getConsoleOutput'
  | 'importFilterList'
  | 'getImportedLists'
  | 'updateImportedLists'
  | 'pruneCSSCache'
  | 'keepAlive';

/** 通用消息对象 (从 background.ts 接收的消息) */
export interface UBOLMessage {
  what: MessageWhat;
  [key: string]: unknown;
}

/** setFilteringMode 消息 */
export interface SetFilteringModeMessage extends UBOLMessage {
  what: 'setFilteringMode';
  hostname: string;
  level: FilteringLevel;
}

/** setPendingFilteringMode 消息 */
export interface SetPendingFilteringModeMessage extends UBOLMessage {
  what: 'setPendingFilteringMode';
  hostname: string;
  url: string;
  tabId: number;
  afterLevel: FilteringLevel;
}

/** addCustomFilters 消息 */
export interface AddCustomFiltersMessage extends UBOLMessage {
  what: 'addCustomFilters';
  hostname: string;
  selectors: string[];
}

/** applyRulesets 消息 */
export interface ApplyRulesetsMessage extends UBOLMessage {
  what: 'applyRulesets';
  enabledRulesets: string[];
  toRemove?: string[];
}

/** Broadcast 消息类型 */
export interface UBOLBroadcastMessage {
  enabledRulesets?: string[];
  autoReload?: boolean;
  showBlockedCount?: boolean;
  strictBlockMode?: boolean;
  popupBlockMode?: boolean;
  developerMode?: boolean;
  defaultFilteringMode?: number;
  hasOmnipotence?: boolean;
  filteringModeDetails?: FilteringModeDetailsSerialized;
}

// ============================================================================
// Popup 面板数据
// ============================================================================

export interface PopupPanelData {
  hasOmnipotence: boolean;
  level: FilteringLevel;
  autoReload: boolean;
  isSideloaded: boolean;
  developerMode: boolean;
  disabledFeatures: string[];
  hasCustomFilters: boolean;
}

// ============================================================================
// 选项页数据
// ============================================================================

export interface OptionsPageData {
  hasOmnipotence: boolean;
  defaultFilteringMode: FilteringLevel;
  enabledRulesets: string[];
  adminRulesets: string[];
  maxNumberOfEnabledRulesets: number;
  rulesetDetails: RulesetDetails[];
  autoReload: boolean;
  showBlockedCount: boolean;
  canShowBlockedCount: boolean;
  strictBlockMode: boolean;
  popupBlockMode: boolean;
  firstRun: boolean;
  isSideloaded: boolean;
  developerMode: boolean;
  disabledFeatures: string[];
  supportsCompiledFilters: boolean;
  supportsUserScripts: boolean;
}

// ============================================================================
// 自定义过滤器 (Custom Filters / Element Picker)
// ============================================================================

/** 自定义过滤器存储结构: Map<hostname, string[]> */
export type CustomFiltersMap = Map<string, string[]>;

// ============================================================================
// 导入的过滤器列表
// ============================================================================

export interface ImportedListEntry {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  compiledData?: string;
}

// ============================================================================
// storage.local 键名常量
// ============================================================================

export const STORAGE_KEYS = {
  RULESET_CONFIG: 'rulesetConfig',
  FILTERING_MODE_DETAILS: 'filteringModeDetails',
  PERMISSIONS_HOSTNAMES: 'permissions.hostnames',
  CUSTOM_FILTERS: 'customFilters',
  IMPORTED_LISTS: 'importedLists',
  GOOD_START: 'goodStart',
  SANDBOX_FILTERS: 'sandboxFilters',
  STRICTBLOCK_EXCLUDED: 'strictblockExcluded',
} as const;

// ============================================================================
// platform / webext flavor
// ============================================================================

export type WebExtFlavor = 'chromium' | 'firefox' | 'safari';

// ============================================================================
// Compile Filters (Offscreen Document 通信)
// ============================================================================

export interface CompileFiltersMessage {
  what: 'compileFilters:result';
  scriptlets: string;
  cosmeticFilters: Record<string, string>;
  genericCosmeticFilters: Record<string, string>;
}

// ============================================================================
// Alarms
// ============================================================================

export const ALARM_NAMES = {
  DEFERRED_JOBS: 'deferredJobs',
} as const;

// ============================================================================
// Commands
// ============================================================================

export type ExtensionCommand =
  | 'enter-zapper-mode'
  | 'enter-picker-mode';
