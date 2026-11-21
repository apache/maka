/**
 * Wappalyzer v6.12.3 — Chrome 扩展 (MV3) 类型定义
 *
 * 本文件涵盖 Wappalyzer 扩展的全部核心接口与类型别名。
 * 按域分层：核心引擎 / 分类系统 / 后台驱动 / 消息通信 /
 *           存储选项 / 内容脚本 / 弹出窗口 / 网络请求 / Manifest
 *
 * 注释使用中文，类型名使用英文。仅包含类型声明，不含实现代码。
 */

// ============================================================================
// 一、核心引擎 (wappalyzer.js)
// ============================================================================

/**
 * 原始模式字符串格式，例如：
 *   "regex\\;version:\\1"
 *   "regex\\;confidence:50\\;version:\\1"
 *   或数字字面量
 */
type RawPatternValue = string | number;

/**
 * 原始模式对象：键为匹配键（如 "main"），值为 RawPatternValue 数组。
 * 也可直接为字符串/数字/数组（此时等价于 { main: value }）。
 */
type RawPatterns =
  | RawPatternValue
  | RawPatternValue[]
  | Record<string, RawPatternValue | RawPatternValue[]>;

/**
 * 解析后的单个模式
 */
interface ParsedPattern {
  /** 原始模式值（正则源字符串或字面量） */
  value: string;
  /** 编译后的正则表达式，忽略大小写 */
  regex: RegExp;
  /** 匹配置信度 (0-100)，默认 100 */
  confidence: number;
  /** 版本号提取模板，如 "\\1" 或 "\\1.\\2" */
  version: string;
}

/**
 * DOM 属性/文本/存在性匹配的子结构
 */
interface ParsedDomPattern {
  /** 节点存在性检测（空字符串表示仅检测存在） */
  exists?: ParsedPattern;
  /** 节点文本内容匹配 */
  text?: ParsedPattern;
  /** JS 属性名 → 匹配模式 */
  properties?: Record<string, ParsedPattern>;
  /** HTML 属性名 → 匹配模式 */
  attributes?: Record<string, ParsedPattern>;
}

/**
 * 解析后的模式集合：可能是平面 ParsedPattern 数组（如 headers/cookies）
 * 或嵌套的 Record<string, ParsedPattern[]>（如有子键的 meta/headers）
 * 或 DOM 专用的 Record<string, ParsedDomPattern[]>（selector → 规则列表）
 */
type ParsedPatterns =
  | ParsedPattern[]
  | Record<string, ParsedPattern[]>
  | Record<string, ParsedDomPattern[]>;

/**
 * 技术定义所需的依赖关系
 */
interface TechnologyDependency {
  /** 依赖的技术名称 */
  name: string;
}

/**
 * imply 依赖（带置信度和版本）
 */
interface TechnologyImply extends TechnologyDependency {
  /** 隐含推定的置信度 */
  confidence: number;
  /** 隐含推定的版本模板 */
  version: string;
}

/**
 * require 依赖（技术必须已存在）
 */
interface TechnologyRequire extends TechnologyDependency {
  /** （由 setTechnologies 填充，原始数据只有 name） */
}

/**
 * requiresCategory 依赖（指定分类下的技术必须已存在）
 */
interface TechnologyCategoryRequire {
  /** 依赖的分类 ID */
  id: number;
}

/**
 * exclude 定义：若该技术被检测到则排除当前技术
 */
interface TechnologyExclude extends TechnologyDependency {
  /** （由 setTechnologies 填充，原始数据只有 name） */
}

/**
 * 原始技术数据条目（从 technologies/_a.json 等文件载入）
 */
interface RawTechnologyEntry {
  /** 分类 ID 数组 */
  cats?: number[];
  /** SSL/TLS 证书颁发者匹配 */
  certIssuer?: RawPatternValue | RawPatternValue[];
  /** Cookie 名称匹配 */
  cookies?: RawPatternValue | RawPatternValue[];
  /** CPE 标识符 */
  cpe?: string | null;
  /** CSS 内容匹配 */
  css?: RawPatternValue | RawPatternValue[];
  /** 技术描述 */
  description?: string | null;
  /** DNS 记录匹配 */
  dns?: RawPatternValue | RawPatternValue[];
  /** DOM 选择器匹配（字符串/数组 → { selector: { exists: '' } }；对象 → 原样转换） */
  dom?: string | string[] | Record<string, RawDomPatternEntry>;
  /** 排除的技术名称列表 */
  excludes?: RawPatternValue | RawPatternValue[];
  /** HTTP 响应头匹配 */
  headers?: RawPatternValue | RawPatternValue[];
  /** 图标文件名（默认 "default.svg"） */
  icon?: string;
  /** 隐含技术列表 */
  implies?: RawPatternValue | RawPatternValue[];
  /** JavaScript 属性链匹配 */
  js?: RawPatternValue | RawPatternValue[];
  /** HTML <meta> 标签匹配 */
  meta?: RawPatternValue | RawPatternValue[];
  /** 定价级别数组 */
  pricing?: PricingTier[];
  /** 主动探测 URL 路径匹配 */
  probe?: RawPatternValue | RawPatternValue[];
  /** 依赖技术列表 */
  requires?: RawPatternValue | RawPatternValue[];
  /** 依赖分类列表 */
  requiresCategory?: RawPatternValue | RawPatternValue[];
  /** robots.txt 内容匹配 */
  robots?: RawPatternValue | RawPatternValue[];
  /** <script> src 属性匹配 */
  scriptSrc?: RawPatternValue | RawPatternValue[];
  /** 内联脚本内容匹配 */
  scripts?: RawPatternValue | RawPatternValue[];
  /** 可见文本匹配 */
  text?: RawPatternValue | RawPatternValue[];
  /** 当前页面 URL 匹配 */
  url?: RawPatternValue | RawPatternValue[];
  /** 官方网站 */
  website?: string | null;
  /** XHR 目标主机名匹配 */
  xhr?: RawPatternValue | RawPatternValue[];
}

/**
 * 原始 DOM 模式条目（转换前）
 */
interface RawDomPatternEntry {
  /** 节点存在性 */
  exists?: string;
  /** 节点文本内容模式 */
  text?: string;
  /** JS 属性匹配 */
  properties?: Record<string, string>;
  /** HTML 属性匹配 */
  attributes?: Record<string, string>;
}

/**
 * 内部技术对象（由 setTechnologies 转换后存储在 Wappalyzer.technologies）
 */
interface Technology {
  /** 技术名称（原始 data key） */
  name: string;
  /** URL 友好的 slug */
  slug: string;
  /** 分类 ID 数组 */
  categories: number[];
  /** SSL/TLS 证书颁发者模式 */
  certIssuer: ParsedPattern[];
  /** Cookie 名称模式（Record<cookieName, ParsedPattern[]>） */
  cookies: ParsedPattern[] | Record<string, ParsedPattern[]>;
  /** CPE 标识符 */
  cpe: string | null;
  /** CSS 内容模式 */
  css: ParsedPattern[];
  /** 技术描述 */
  description: string | null;
  /** DNS 记录模式（Record<recordType, ParsedPattern[]>） */
  dns: ParsedPattern[] | Record<string, ParsedPattern[]>;
  /** DOM 选择器模式（Record<selector, ParsedDomPattern[]>） */
  dom: Record<string, ParsedDomPattern[]>;
  /** 排除技术列表 */
  excludes: TechnologyExclude[];
  /** HTTP 响应头模式（Record<headerName, ParsedPattern[]>） */
  headers: ParsedPattern[] | Record<string, ParsedPattern[]>;
  /** 图标文件名 */
  icon: string;
  /** 隐含技术列表 */
  implies: TechnologyImply[];
  /** JS 属性链模式（Record<propertyChain, ParsedPattern[]>） */
  js: Record<string, ParsedPattern[]>;
  /** HTML <meta> 模式（Record<metaName, ParsedPattern[]>） */
  meta: ParsedPattern[] | Record<string, ParsedPattern[]>;
  /** 定价级别 */
  pricing: PricingTier[];
  /** 主动探测模式 */
  probe: Record<string, ParsedPattern[]>;
  /** require 技术列表 */
  requires: TechnologyRequire[];
  /** requiresCategory 列表 */
  requiresCategory: TechnologyCategoryRequire[];
  /** robots.txt 模式 */
  robots: ParsedPattern[];
  /** <script> src 模式 */
  scriptSrc: ParsedPattern[];
  /** 内联脚本内容模式 */
  scripts: ParsedPattern[];
  /** 可见文本模式 */
  text: ParsedPattern[];
  /** URL 模式 */
  url: ParsedPattern[];
  /** 官方网站 */
  website: string | null;
  /** XHR 主机名模式 */
  xhr: ParsedPattern[];
}

/**
 * require 关系索引：被哪些技术需要
 */
interface RequirementIndex {
  /** 被依赖的技术名称 */
  name: string;
  /** 依赖该技术的所有技术 */
  technologies: Technology[];
}

/**
 * requiresCategory 关系索引：被哪些技术需要
 */
interface CategoryRequirementIndex {
  /** 被依赖的分类 ID */
  categoryId: number;
  /** 依赖该分类的所有技术 */
  technologies: Technology[];
}

/**
 * 定价级别
 */
type PricingTier = 'low' | 'mid' | 'high' | 'poa';

/**
 * 技术类型键（用于按检测方式分组）
 */
type TechnologyType =
  | 'certIssuer'
  | 'cookies'
  | 'css'
  | 'dns'
  | 'dom'
  | 'headers'
  | 'js'
  | 'meta'
  | 'probe'
  | 'robots'
  | 'scriptSrc'
  | 'scripts'
  | 'text'
  | 'url'
  | 'xhr';

/**
 * 检测到的模式匹配信息
 */
interface DetectedPattern {
  /** 编译后的正则表达式 */
  regex: RegExp;
  /** 匹配置信度 (0-100) */
  confidence: number;
  /** 匹配类型 */
  type: string;
  /** 被匹配的原始值 */
  value: string;
  /** 正则捕获到的完整匹配文本 */
  match: string;
  /** 版本提取模板 */
  version?: string;
}

/**
 * 单条检测结果（resolve 前）
 */
interface Detection {
  /** 对应的技术对象 */
  technology: Technology;
  /** 匹配模式详情 */
  pattern: DetectedPattern;
  /** 解析出的版本号 */
  version: string;
  /** 被检测时的页面 URL 根路径 */
  rootPath?: boolean;
  /** 最后一次匹配到该技术的 URL */
  lastUrl?: string;
}

/**
 * 序列化后的检测结果（用于持久化存储）
 */
interface SerializedDetection {
  /** 技术名称（字符串形式） */
  technology: string;
  /** 模式信息（正则转 source 字符串） */
  pattern: {
    regex: string;
    confidence: number;
    value?: string;
  };
  /** 版本号 */
  version: string;
  /** URL 根路径 */
  rootPath?: boolean;
  /** 最后匹配 URL */
  lastUrl?: string;
}

/**
 * resolve 后的最终检测结果（对外输出格式）
 */
interface ResolvedDetection {
  /** 技术名称 */
  name: string;
  /** 技术描述 */
  description: string | null;
  /** URL 友好的 slug */
  slug: string;
  /** 所属分类列表（已解析的 Category 对象） */
  categories: Category[];
  /** 综合置信度 */
  confidence: number;
  /** 版本号 */
  version: string;
  /** 图标文件名 */
  icon: string;
  /** 官方网站 */
  website: string | null;
  /** 定价信息 */
  pricing: PricingTier[];
  /** CPE 标识符 */
  cpe: string | null;
  /** URL 根路径标记 */
  rootPath?: boolean;
  /** 最后一次检测到的 URL */
  lastUrl?: string;
}

/**
 * 性能基准测试条目
 */
interface BenchmarkEntry {
  /** 单次匹配耗时 (ms) */
  duration: number;
  /** 模式正则（字符串化） */
  pattern: string;
  /** 被匹配的值（截取前 100 字符） */
  value: string;
  /** 被匹配值的完整长度 */
  valueLength: number;
  /** 所属技术名称 */
  technology: string;
}

/**
 * 基准测试汇总
 */
interface BenchmarkSummary {
  /** 总模式数 */
  totalPatterns: number;
  /** 总耗时 (ms) */
  totalDuration: number;
  /** 平均耗时 (ms) */
  averageDuration: number;
  /** 最慢技术 top 5 */
  slowestTechnologies: Record<string, number>;
  /** 最慢模式 top 5 */
  slowestPatterns: BenchmarkEntry[];
}

/**
 * Wappalyzer 静态引擎接口
 */
interface WappalyzerEngine {
  /** 所有技术定义 */
  technologies: Technology[];
  /** 按类型索引的技术缓存 */
  technologiesByType: Record<string, Technology[]>;
  /** 所有分类定义 */
  categories: Category[];
  /** require 关系索引 */
  requires: RequirementIndex[];
  /** requiresCategory 关系索引 */
  categoryRequires: CategoryRequirementIndex[];

  /**
   * 标准化版本号字符串
   * @param version - 待标准化版本号
   * @returns 标准化后的版本号（无效则返回空字符串）
   */
  normalizeVersion(version?: string): string;

  /**
   * 生成 URL 友好的 slug
   * @param string - 原始字符串
   */
  slugify(string: string): string;

  /**
   * 按名称查找技术（同时搜索 requires 和 categoryRequires）
   * @param name - 技术名称
   */
  getTechnology(name: string): Technology | undefined;

  /**
   * 按 ID 查找分类
   * @param id - 分类 ID
   */
  getCategory(id: number): Category | undefined;

  /**
   * 按检测类型获取技术列表（去重，带缓存）
   * @param types - 技术类型键数组
   */
  getTechnologiesByTypes(types?: TechnologyType[]): Technology[];

  /**
   * 设置技术定义
   * @param data - 原始技术数据（键为技术名，值为原始条目）
   */
  setTechnologies(data: Record<string, RawTechnologyEntry>): void;

  /**
   * 设置分类定义
   * @param data - 原始分类数据（键为分类 ID 字符串）
   */
  setCategories(data: Record<string, RawCategory>): void;

  /**
   * 转换原始模式为解析后的内部格式
   * @param patterns - 原始模式
   * @param caseSensitive - 是否区分大小写（用于 JS/DOM）
   * @param isRegex - 是否当作正则处理
   */
  transformPatterns(
    patterns: RawPatterns | undefined | null,
    caseSensitive?: boolean,
    isRegex?: boolean
  ): ParsedPatterns;

  /**
   * 从模式字符串提取正则、置信度、版本信息
   * @param pattern - 原始模式值
   * @param isRegex - 是否编译为正则
   */
  parsePattern(pattern: RawPatternValue, isRegex?: boolean): ParsedPattern;

  /**
   * 对采集到的数据进行技术分析
   * @param items - 采集项（url/cookies/meta 等）
   * @param technologies - 要分析的技术集合（默认全部）
   * @returns 检测结果列表
   */
  analyze(
    items: CollectedItems,
    technologies?: Technology[]
  ): Detection[];

  /**
   * 一对一分析：每个模式独立匹配一个值
   * @param technology - 技术对象
   * @param type - 检测类型
   * @param value - 要匹配的值
   */
  analyzeOneToOne(
    technology: Technology,
    type: string,
    value: string
  ): Detection[];

  /**
   * 一对多分析：每个模式对一个数组中的每个值匹配
   * @param technology - 技术对象
   * @param type - 检测类型
   * @param items - 要匹配的值数组
   */
  analyzeOneToMany(
    technology: Technology,
    type: string,
    items?: string[]
  ): Detection[];

  /**
   * 多对多分析：按子键分组进行匹配（如 headers.cookie → cookie 头值）
   * @param technology - 技术对象
   * @param types - "type.subtype" 格式的类型路径
   * @param items - Record<子键, 值数组>
   */
  analyzeManyToMany(
    technology: Technology,
    types: string,
    items?: Record<string, string[]>
  ): Detection[];

  /**
   * 解析检测结果为最终输出（合并、排序、排除、反向推断）
   * @param detections - 原始检测列表
   * @returns 最终解析结果
   */
  resolve(detections?: Detection[]): ResolvedDetection[];

  /**
   * 解析版本号（替换反向引用）
   * @param pattern - 模式（含 regex 和 version 模板）
   * @param match - 被匹配的值
   */
  resolveVersion(
    pattern: { version: string; regex: RegExp },
    match: string
  ): string;

  /**
   * 解析排除逻辑（从已解析结果中移除被排除的技术）
   * @param resolved - 已解析检测结果
   */
  resolveExcludes(resolved: Detection[]): void;

  /**
   * 解析隐含逻辑（向已解析结果中追加隐含技术）
   * @param resolved - 已解析检测结果
   */
  resolveImplies(resolved: Detection[]): void;
}

// ============================================================================
// 二、分类系统 (categories.json + groups.json)
// ============================================================================

/**
 * 原始分组数据（groups.json 中单条记录）
 */
interface RawGroup {
  /** 分组名称 */
  name: string;
}

/**
 * 内部分组对象
 */
interface Group {
  /** 分组 ID */
  id: number;
  /** 分组名称 */
  name: string;
}

/**
 * 原始分类数据（categories.json 中单条记录）
 */
interface RawCategory {
  /** 分类名称 */
  name: string;
  /** 显示优先级（数字越大越靠前） */
  priority: number;
  /** 所属分组 ID 列表 */
  groups: number[];
}

/**
 * 内部分类对象（由 setCategories 转换后存储在 Wappalyzer.categories）
 */
interface Category {
  /** 分类 ID */
  id: number;
  /** 分类名称 */
  name: string;
  /** URL 友好的 slug */
  slug: string;
  /** 显示优先级 */
  priority: number;
  /** 所属分组列表 */
  groups: Group[];
}

// ============================================================================
// 三、后台驱动 (index.js — background service worker)
// ============================================================================

/**
 * 主机名缓存条目（存储在 Driver.cache.hostnames 中）
 */
interface HostnameCacheEntry {
  /** 该主机上的检测结果 */
  detections: Detection[];
  /** 各技术的命中次数 */
  technologyHits: TechnologyHitsMap;
  /** 总命中次数 */
  hits: number;
  /** 已分析的脚本 URL 列表（最多 25 个） */
  analyzedScripts?: string[];
  /** 页面语言 */
  language?: string;
  /** 缓存时间戳 */
  dateTime: number;
  /** HTTPS 标记（序列化时删除） */
  https?: boolean;
}

/**
 * 序列化后的主机名缓存
 */
interface SerializedHostnameCacheEntry extends Omit<HostnameCacheEntry, 'detections' | 'https'> {
  detections: SerializedDetection[];
}

/**
 * 标签页请求信息
 */
interface TabRequest {
  /** 请求 URL */
  url: string;
  /** 服务器 IP 地址 */
  ip: string;
  /** HTTP 状态码 */
  statusCode: number;
  /** 是否为私有 IP */
  isPrivateIp: boolean;
  /** 请求时间戳 */
  dateTime: number;
}

/**
 * 标签页检测结果
 */
interface TabResult {
  /** 标签页 URL */
  url: string;
  /** 检测结果列表 */
  detections: Detection[];
  /** 页面语言 */
  language?: string;
  /** 是否为瞬态结果（私有 IP / 开发环境） */
  transient?: boolean;
  /** 结果时间戳 */
  dateTime: number;
}

/**
 * 标签页 Action 状态（图标/角标缓存）
 */
interface TabActionState {
  /** 当前角标文本 */
  badgeText: string;
  /** 当前图标路径键 */
  iconPathKey: string;
}

/**
 * 技术命中次数映射：技术名 → 命中次数
 */
type TechnologyHitsMap = Record<string, number>;

/**
 * 技术 ping 条目
 */
interface PingTechnologyEntry {
  /** 版本号 */
  version: string;
  /** 命中次数 */
  hits: number;
  /** 是否为根路径检测 */
  rootPath?: boolean;
}

/**
 * Ping 候选条目（用于排序和选取 top N）
 */
interface PingCandidate {
  /** 主机名 */
  hostname: string;
  /** 总命中数 */
  hits: number;
  /** 缓存时间戳 */
  dateTime: number;
  /** 平均技术命中数 */
  avgTechnologyHits: number;
  /** 技术列表 */
  technologies: Record<string, PingTechnologyEntry>;
  /** 页面语言 */
  language?: string;
}

/**
 * Ping 负载（发送给 ping.wappalyzer.com/v2/）
 */
interface PingPayload {
  /** 扩展版本号 */
  version: string;
  /** URL → 技术和元数据映射 */
  urls: {
    [url: string]: {
      technologies: Record<string, PingTechnologyEntry>;
      meta: {
        language?: string;
      };
    };
  };
}

/**
 * 内部 PingPayload（含 sentHostnames 用于去除已发送计数）
 */
interface InternalPingPayload extends PingPayload {
  /** 已被选中的主机名列表 */
  sentHostnames: Array<{ hostname: string }>;
}

/**
 * 机器人规则列表：禁爬路径数组
 */
type RobotsRules = string[];

/**
 * 驱动缓存结构
 */
interface DriverCache {
  /** 主机名 → 缓存条目 */
  hostnames: Record<string, HostnameCacheEntry>;
  /** robots.txt 缓存（主机名 → 禁爬路径列表） */
  robots: Record<string, RobotsRules>;
  /** tabId → TabResult */
  tabResults: Record<number, TabResult>;
  /** tabId → TabRequest */
  tabRequests: Record<number, TabRequest>;
  /** tabId → 已分析脚本 URL 列表 */
  tabScripts: Record<number, string[]>;
  /** tabId → TabActionState */
  tabActions: Record<number, TabActionState>;
}

/**
 * 采集到的页面数据条目（content.js 采集并传给 onContentLoad）
 */
interface CollectedItems {
  /** 页面 URL */
  url?: string;
  /** Cookie 字典：名称 → [值] */
  cookies?: Record<string, string[]>;
  /** <meta> 字典：name/property → [content] */
  meta?: Record<string, string[]>;
  /** <script src> 列表 */
  scriptSrc?: string[];
  /** 可见文本 */
  text?: string;
  /** CSS 规则文本（合并所有样式表） */
  css?: string;
  /** 内联脚本内容列表 */
  scripts?: string[];
  /** HTTP 响应头字典：名称 → [值] */
  headers?: Record<string, string[]>;
  /** XHR 请求目标主机名 */
  xhr?: string;
}

/**
 * 分析选项（onContentLoad 接收）
 */
interface AnalysisOptions {
  /** 是否在分析中包含 URL */
  includeUrl?: boolean;
  /** 是否跳过 Cookie 采集 */
  skipCookies?: boolean;
  /** 限定技术名称列表 */
  requiredTechnologyNames?: string[];
}

/**
 * 内容脚本回调选项（analyzeRequires 使用）
 */
interface ContentCallbackOptions {
  /** 技术名称（触发 requires） */
  requires?: string;
  /** 分类 ID（触发 requiresCategory） */
  categoryRequires?: number;
  /** 限定技术名称列表 */
  requiredTechnologyNames?: string[];
}

/**
 * JavaScript 变量检测条目（由 js.js 注入脚本返回）
 */
interface JsDetectionItem {
  /** 技术名称 */
  name: string;
  /** JS 属性链（如 "window.ga"） */
  chain: string;
  /** 取到的原始值 */
  value: unknown;
}

/**
 * DOM 检测条目（由 dom.js 注入脚本 + getDomDetections 返回）
 */
interface DomDetectionItem {
  /** 技术名称 */
  name: string;
  /** CSS 选择器 */
  selector: string;
  /** 节点存在性标记（空字符串表示存在） */
  exists?: string;
  /** 节点 innerText 文本 */
  text?: string;
  /** JS 属性名 */
  property?: string;
  /** JS 属性值 */
  value?: string | boolean;
  /** HTML 属性名 */
  attribute?: string;
}

/**
 * Driver 接口（background service worker 主控制器）
 */
interface DriverInstance {
  /** 驱动缓存 */
  cache: DriverCache;
  /** 持久化防抖定时器 */
  persistTimer: ReturnType<typeof setTimeout> | null;
  /** 当前 ping Promise（防止并发 ping） */
  pingPromise: Promise<void> | null;

  /** 初始化驱动（加载技术/分类/缓存） */
  init(): Promise<void>;

  /** 关闭当前标签页 */
  closeCurrentTab(tabId: number): void;

  /** 调试日志 */
  log(message: unknown, source?: string, type?: 'log' | 'error' | 'info'): void;

  /** 错误日志 */
  error(error: unknown, source?: string): void;

  /**
   * 根据采集项获取相关技术列表
   */
  getTechnologiesForItems(
    items: CollectedItems,
    requires?: string,
    categoryRequires?: number,
    requiredTechnologyNames?: string[]
  ): Technology[] | undefined;

  /** 判断 URL 是否在 ping 过滤列表中 */
  isPingFilteredUrl(url: string): boolean;

  /** 判断主机名是否为瞬态（开发环境） */
  isTransientHostname(url: string): boolean;

  /** 获取标签页请求信息 */
  getTabRequest(
    tabId: number,
    url: string,
    allowSameOrigin?: boolean
  ): TabRequest | null;

  /** 判断是否为瞬态 URL（开发环境或私有 IP） */
  isTransientUrl(
    url: string,
    tabId?: number,
    allowSameOrigin?: boolean
  ): boolean;

  /** 获取标签页检测结果 */
  getTabResult(
    tabId: number,
    url: string,
    allowSameOrigin?: boolean
  ): TabResult | null;

  /** 持久化标签页检测结果到 session storage */
  persistTabResults(): Promise<void>;

  /** 持久化标签页请求到 session storage */
  persistTabRequests(): Promise<void>;

  /** 清除标签页检测结果 */
  clearTabResult(tabId: number): Promise<void>;

  /** 清除标签页 Action 状态 */
  clearTabActionState(tabId: number): void;

  /** 清除标签页请求信息 */
  clearTabRequest(tabId: number): Promise<void>;

  /**
   * 获取已解析的检测结果（调用 Wappalyzer.resolve）
   */
  getResolvedDetections(
    url: string,
    detections?: Detection[],
    showCached?: boolean,
    opts?: { lastUrlOverride?: string }
  ): ResolvedDetection[];

  /**
   * 获取当前标签页的检测结果（从缓存或当前分析结果）
   */
  getDetectionsForTab(tab: chrome.tabs.Tab): Promise<ResolvedDetection[]>;

  /** 清理过期主机名缓存（超过 48h 或超过 100 条） */
  pruneHostnamesCache(): void;

  /** 持久化主机名缓存 */
  persistHostnames(): Promise<void>;

  /** 调度防抖后的缓存持久化 */
  scheduleCachePersist(): void;

  /** 生成 ping 负载 */
  getPingPayload(): InternalPingPayload;

  /** 加载技术定义和分类 */
  loadTechnologies(): Promise<void>;

  /** 获取所有分类 */
  getCategories(): Category[];

  /** HTTP POST 请求 */
  post(url: string, body: unknown): Promise<Response>;

  /** 分析采集数据 */
  analyze(...args: Parameters<WappalyzerEngine['analyze']>): Detection[];

  /**
   * 分析 JavaScript 变量
   */
  analyzeJs(
    url: string,
    js: JsDetectionItem[],
    requires?: string,
    categoryRequires?: number,
    requiredTechnologyNames?: string[],
    tabId?: number,
    frameId?: number
  ): Promise<void>;

  /**
   * 分析 DOM 节点
   */
  analyzeDom(
    url: string,
    dom: DomDetectionItem[],
    requires?: string,
    categoryRequires?: number,
    requiredTechnologyNames?: string[],
    tabId?: number,
    frameId?: number
  ): Promise<void>;

  /**
   * 强制检测指定技术（用于广告检测等特殊场景）
   */
  detectTechnology(
    url: string,
    name: string,
    tabId?: number,
    frameId?: number
  ): Promise<void>;

  /**
   * 消息路由（chrome.runtime.onMessage 监听器）
   */
  onMessage(
    message: WappalyzerMessage,
    sender: chrome.runtime.MessageSender,
    callback: (response?: unknown) => void
  ): boolean;

  /**
   * 向内容脚本发送消息
   */
  content(
    url: string,
    func: string,
    args?: unknown[]
  ): Promise<unknown>;

  /** 处理响应开始事件 */
  onResponseStarted(request: chrome.webRequest.WebResponseHeadersDetails): Promise<void>;

  /** 处理主框架请求完成（分析响应头） */
  onWebRequestComplete(request: chrome.webRequest.WebResponseCacheDetails): Promise<void>;

  /** 处理脚本请求完成（拉取并分析外部脚本内容） */
  onScriptRequestComplete(request: chrome.webRequest.WebResponseCacheDetails): Promise<void>;

  /** 处理 XHR 请求完成（分析 XHR 目标主机名） */
  onXhrRequestComplete(request: chrome.webRequest.WebResponseCacheDetails): Promise<void>;

  /**
   * 处理内容脚本上报的页面数据
   */
  onContentLoad(
    url: string,
    items?: CollectedItems,
    language?: string,
    requires?: string,
    categoryRequires?: number,
    options?: AnalysisOptions,
    tabId?: number,
    frameId?: number
  ): Promise<void>;

  /** 获取所有技术 */
  getTechnologies(): Technology[];

  /** 判断域名是否被禁用 */
  isDisabledDomain(url: string): Promise<boolean>;

  /**
   * 检测回调（核心：合并结果、触发 requires、更新图标、ping）
   */
  onDetect(
    url: string,
    detections?: Detection[],
    language?: string,
    incrementHits?: boolean,
    tabId?: number,
    frameId?: number
  ): Promise<void>;

  /**
   * 更新扩展图标和角标
   */
  setIcon(
    url: string,
    technologies?: ResolvedDetection[],
    tabId?: number
  ): Promise<void>;

  /** 获取当前活动标签页的检测结果 */
  getDetections(): Promise<ResolvedDetection[] | undefined>;

  /**
   * 获取 robots.txt 规则
   */
  getRobots(hostname: string, secure?: boolean): Promise<RobotsRules>;

  /**
   * 检查 URL 是否被 robots.txt 禁止
   */
  checkRobots(href: string): Promise<void>;

  /** 清除所有缓存 */
  clearCache(): Promise<void>;

  /**
   * 匿名发送检测统计到 Wappalyzer 服务器
   */
  ping(): Promise<void>;
}

// ============================================================================
// 四、消息通信
// ============================================================================

/**
 * 扩展内消息格式（content.js ↔ background ↔ popup/options）
 */
interface WappalyzerMessage {
  /** 消息来源标识 */
  source: string;
  /** 要调用的目标方法名 */
  func: string;
  /** 方法参数（所有参数打包为数组） */
  args: unknown[];
}

/**
 * 需要在后台运行的标签感知方法列表
 * （这些方法会自动附加 tabId 和 frameId）
 */
type TabAwareMethod =
  | 'analyzeDom'
  | 'analyzeJs'
  | 'detectTechnology'
  | 'onContentLoad';

// ============================================================================
// 五、存储选项
// ============================================================================

/**
 * 扩展所有存储选项
 */
interface WappalyzerOptions {
  /** 升级消息开关 */
  upgradeMessage: boolean;
  /** 动态图标开关（显示检测到的主要技术图标） */
  dynamicIcon: boolean;
  /** 角标开关（显示检测到的技术数量） */
  badge: boolean;
  /** 匿名统计开关 */
  tracking: boolean;
  /** 显示缓存结果（非当前 URL 的检测也显示） */
  showCached: boolean;
  /** Plus API 密钥 */
  apiKey: string;
  /** API 密钥更新时间戳 */
  apiKeyUpdatedAt?: number;
  /** 服务条款是否已接受 */
  termsAccepted: boolean;
  /** 已禁用的域名列表 */
  disabledDomains: string[];
  /** 扩展版本号 */
  version: string;
  /** UI 主题 */
  theme: 'light' | 'dark';
  /** 固定显示的分类 ID */
  pinnedCategory: number | null;
  /** 上次 ping 时间戳 */
  lastPing: number;
  /** 页脚是否折叠 */
  collapseFooter?: boolean;
}

/**
 * 选项键 → 默认值映射
 */
type OptionsDefaults = {
  [K in keyof WappalyzerOptions]?: WappalyzerOptions[K];
};

// ============================================================================
// 六、内容脚本 (content.js)
// ============================================================================

/**
 * 内容脚本缓存
 */
interface ContentCache {
  /** Cookie 字典 */
  cookies: Record<string, string[]>;
  /** <meta> 字典 */
  meta: Record<string, string[]>;
  /** <script src> 列表 */
  scriptSrc: string[];
  /** 可见文本 */
  text?: string;
  /** CSS 规则文本 */
  css?: string;
  /** 内联脚本内容列表 */
  scripts?: string[];
}

/**
 * 内容脚本接口
 */
interface ContentInstance {
  /** 采集缓存 */
  cache: ContentCache;
  /** 检测到的页面语言 */
  language: string;
  /** 已分析的 requires/requiresCategory ID 列表（防止重复分析） */
  analyzedRequires: string[];

  /** 上报错误 */
  error(error: unknown): Promise<unknown>;

  /** 初始化内容脚本 */
  init(): Promise<void>;

  /**
   * 消息路由
   */
  onMessage(
    message: WappalyzerMessage,
    sender: chrome.runtime.MessageSender,
    callback: (response?: unknown) => void
  ): boolean;

  /**
   * 向后台发送消息
   */
  driver(func: string, args?: unknown | unknown[] | Error): Promise<unknown>;

  /**
   * 分析 required technologies（被需要的技术回检）
   */
  analyzeRequires(
    url: string,
    requires: Array<RequirementIndex | CategoryRequirementIndex>
  ): Promise<void>;

  /**
   * 刷新元数据（页面导航时触发）
   */
  refreshMetadata(): Promise<void>;

  /**
   * 获取技术列表后的回调（执行 JS/DOM 分析）
   */
  onGetTechnologies(
    technologies?: Technology[],
    requires?: string,
    categoryRequires?: number,
    requiredTechnologyNames?: string[]
  ): Promise<void>;
}

/**
 * JS 注入消息格式（window.postMessage）
 */
interface InjectMessage<T = unknown> {
  /** Wappalyzer 命名空间 */
  wappalyzer: {
    /** 注入 ID → 数据 */
    [id: string]: T;
  };
}

/**
 * JS 检测注入请求（content.js → js.js）
 */
interface JsInjectRequest {
  /** 要检测的技术列表 */
  technologies: Array<{
    /** 技术名称 */
    name: string;
    /** JS 属性链列表 */
    chains: string[];
  }>;
}

/**
 * DOM 检测注入请求（content.js → dom.js）
 */
interface DomInjectRequest {
  /** 要检测的技术列表 */
  technologies: Array<{
    /** 技术名称 */
    name: string;
    /** DOM 规则（仅包含有 properties 的选择器） */
    dom: Record<string, ParsedDomPattern[]>;
  }>;
}

/**
 * 语言检测结果条目（chrome.i18n.detectLanguage 返回）
 */
interface LanguageDetectionResult {
  /** 语言代码 */
  language: string;
  /** 置信百分比 */
  percentage: number;
}

// ============================================================================
// 七、弹出窗口 (popup.js)
// ============================================================================

/**
 * 弹窗缓存
 */
interface PopupCache {
  /** 当前标签页 ID */
  tabId: number | null;
  /** 当前页面 URL */
  url: string;
  /** 所有分类列表 */
  categories: Category[];
  /** 当前页面检测结果 */
  detections: ResolvedDetection[];
  /** Plus API 返回的属性值 */
  attributeValues: Record<string, unknown>;
}

/**
 * 页脚 CTA 条目
 */
interface FooterItem {
  /** 标题 i18n 键 */
  heading: string;
  /** 正文 i18n 键 */
  body: string;
  /** 按钮文本 i18n 键 */
  buttonText: string;
  /** 按钮链接 */
  buttonLink: string;
}

/**
 * CSV 导出结果
 */
interface CsvExport {
  /** CSV 字符串数组（每行一个字符串） */
  csv: string[];
  /** 下载文件名 */
  filename: string;
}

/**
 * 解析后的邮箱信息
 */
interface ParsedEmail {
  /** 邮箱地址 */
  email: string;
  /** 联系人姓名 */
  name: string;
  /** 联系人职位 */
  title: string;
}

/**
 * Plus API 响应格式（GET https://api.wappalyzer.com/v2/plus/:url）
 */
interface PlusApiResponse {
  /** 公司属性（按集合分组） */
  attributes: Record<string, Record<string, unknown>>;
  /** 是否为爬取中状态 */
  crawl?: boolean;
}

/**
 * Plus API 错误对象
 */
interface PlusApiError extends Error {
  /** 错误响应体 */
  data?: unknown;
  /** HTTP 响应对象 */
  response?: Response;
  /** API 密钥是否处于激活等待期 */
  apiKeyPendingActivation?: boolean;
}

/**
 * 技术花费摘要
 */
interface TechnologySpend {
  low: number;
  poa: number;
  mid: number;
  high: number;
  xhigh?: number;
}

/**
 * 弹窗 DOM 元素引用
 */
interface PopupElements {
  body: HTMLElement;
  detections: HTMLElement;
  empty: HTMLElement;
  emptyReload: HTMLElement;
  footer: HTMLElement;
  headerSwitchDisabled: HTMLElement;
  headerSwitchEnabled: HTMLElement;
  headerSwitches: NodeListOf<HTMLElement>;
  plusDownloadLink: HTMLElement;
  plusConfigureApiKey: HTMLInputElement;
  plusConfigureSave: HTMLElement;
  plusDownload: HTMLElement;
  tabPlus: HTMLElement;
  terms: HTMLElement;
  termsButtonAccept: HTMLElement;
  termsButtonDecline: HTMLElement;
  termsPrivacyOther: HTMLElement;
  termsPrivacyFirefox: HTMLElement;
  footerButtonLink: HTMLElement;
  footerButtonText: HTMLElement;
  footerContentBody: HTMLElement;
  footerHeading: HTMLElement;
  footerHeadingText: HTMLElement;
  footerToggleClose: HTMLElement;
  footerToggleOpen: HTMLElement;
  headerSettings: HTMLElement;
  headerThemeDark: HTMLElement;
  headerThemeLight: HTMLElement;
  headerThemes: NodeListOf<HTMLElement>;
  issue: HTMLElement;
  tabItems: NodeListOf<HTMLElement>;
  tabs: NodeListOf<HTMLElement>;
  templates: NodeListOf<HTMLElement>;
  [key: string]: HTMLElement | NodeListOf<HTMLElement> | undefined;
}

/**
 * 弹窗接口
 */
interface PopupInstance {
  /** 弹窗缓存 */
  cache: PopupCache;
  /** DOM 元素引用 */
  elements?: PopupElements;
  /** HTML 模板节点映射 */
  templates?: Record<string, Node>;

  /** 打开设置页面 */
  openSettings(): Promise<void>;

  /** 初始化弹窗 */
  init(): Promise<void>;

  /**
   * 向后台发送消息
   */
  driver(func: string, args?: unknown | unknown[]): Promise<unknown>;

  /** 调试日志 */
  log(message: unknown): void;

  /**
   * 按分类分组技术
   */
  categorise(technologies: ResolvedDetection[]): Array<Category & { technologies: ResolvedDetection[] }>;

  /**
   * 检测结果回调（渲染弹窗 UI）
   */
  onGetDetections(detections?: ResolvedDetection[]): Promise<void>;

  /**
   * 获取 Plus API 数据并渲染
   */
  getPlus(url: string): Promise<void>;

  /**
   * 导出 CSV
   */
  downloadCsv(event: Event): Promise<boolean | false>;
}

// ============================================================================
// 八、网络请求
// ============================================================================

/**
 * Ping API 请求体（POST https://ping.wappalyzer.com/v2/）
 */
interface PingApiRequestBody {
  /** 扩展版本号 */
  version: string;
  /** URL → 技术/元数据映射 */
  urls: Record<string, {
    technologies: Record<string, PingTechnologyEntry>;
    meta: { language?: string };
  }>;
}

/**
 * Plus API 请求头（GET https://api.wappalyzer.com/v2/plus/:url）
 */
interface PlusApiHeaders {
  /** API 密钥 */
  'x-api-key': string;
}

/**
 * Plus API 重试延迟（毫秒）
 * [3000, 5000, 10000, 15000, 30000]
 */
type ApiKeyRetryDelays = readonly [3000, 5000, 10000, 15000, 30000];

/**
 * robots.txt 解析结果（Agent 段信息）
 */
interface RobotsAgentSection {
  /** User-agent 名称 */
  agent: string;
  /** Disallow 路径列表 */
  disallows: string[];
}

// ============================================================================
// 九、Manifest / 浏览器扩展平台
// ============================================================================

/**
 * Chrome 扩展 Agent 类型
 */
type BrowserAgent = 'chrome' | 'firefox' | 'safari';

/**
 * 扩展 Manifest V3 关键字段（Wappalyzer 使用部分）
 */
interface WappalyzerManifest {
  /** 扩展名称 */
  name: string;
  /** 短名称 */
  short_name: string;
  /** 作者 */
  author: string;
  /** 主页 */
  homepage_url: string;
  /** 描述 */
  description: string;
  /** 版本号 */
  version: string;
  /** 默认语言 */
  default_locale: string;
  /** Manifest 版本 */
  manifest_version: 3;
  /** 最低 Chrome 版本 */
  minimum_chrome_version: string;
  /** 图标 */
  icons: Record<string, string>;
  /** Action（工具栏按钮） */
  action: {
    default_icon: Record<string, string>;
    default_title: string;
    default_popup: string;
  };
  /** Service Worker */
  background: {
    service_worker: string;
    scripts: string[];
  };
  /** 内容脚本 */
  content_scripts: Array<{
    matches: string[];
    js: string[];
    run_at: string;
  }>;
  /** Web 可访问资源 */
  web_accessible_resources: Array<{
    resources: string[];
    matches: string[];
  }>;
  /** 选项页面 */
  options_ui: {
    page: string;
    open_in_tab: boolean;
  };
  /** 权限 */
  permissions: string[];
  /** 主机权限 */
  host_permissions: string[];
  /** 可选权限 */
  optional_permissions: string[];
  /** CSP */
  content_security_policy: {
    extension_pages: string;
  };
  /** 浏览器特定设置 */
  browser_specific_settings?: {
    gecko?: {
      id: string;
      strict_min_version: string;
    };
  };
}

// ============================================================================
// 十、工具函数 (utils.js)
// ============================================================================

/**
 * Utils 工具函数接口
 */
interface UtilsInstance {
  /** 浏览器 Agent */
  agent: BrowserAgent;

  /**
   * Chrome API 回调 → Promise 包装
   */
  promisify<T extends (...args: unknown[]) => void>(
    context: Record<string, unknown>,
    method: string,
    ...args: unknown[]
  ): Promise<Parameters<T>[0]>;

  /**
   * 打开新标签页
   */
  open(url: string, active?: boolean): void;

  /**
   * 关闭标签页
   */
  close(tabId: number): void;

  /** 从错误对象中提取消息 */
  getErrorMessage(error: unknown): string;

  /** 标准化错误为 Error 实例 */
  normalizeError(error: unknown): Error;

  /** 判断是否为 "标签页不存在" 错误 */
  isMissingTabError(error: unknown): boolean;

  /** 从 chrome.storage.local 获取选项 */
  getOption(name: string, defaultValue?: unknown): Promise<unknown>;

  /** 写入 chrome.storage.local */
  setOption(name: string, value: unknown): Promise<void>;

  /** 应用国际化（querySelectorAll [data-i18n]） */
  i18n(): void;

  /** 向后台发送消息 */
  sendMessage(source: string, func: string, args?: unknown | unknown[]): Promise<unknown>;

  /** 转义 glob 通配符（用于 tabs.query URL 模式） */
  globEscape(string: string): string;
}

// ============================================================================
// 十一、常量与配置
// ============================================================================

/**
 * Plus API 属性键列表
 */
type AttributeKey =
  | 'phone'
  | 'skype'
  | 'whatsapp'
  | 'email'
  | 'verifiedEmail'
  | 'safeEmail'
  | 'twitter'
  | 'facebook'
  | 'instagram'
  | 'github'
  | 'tiktok'
  | 'youtube'
  | 'pinterest'
  | 'linkedin'
  | 'owler'
  | 'title'
  | 'description'
  | 'copyright'
  | 'copyrightYear'
  | 'responsive'
  | 'schemaOrgTypes'
  | 'certInfo.subjectOrg'
  | 'certInfo.subjectCountry'
  | 'certInfo.subjectState'
  | 'certInfo.subjectLocality'
  | 'certInfo.issuer'
  | 'certInfo.protocol'
  | 'certInfo.validTo'
  | 'dns.spf'
  | 'dns.dmarc'
  | 'trackerGoogleAnalytics'
  | 'trackerGoogleAdSense'
  | 'trackerMedianet'
  | 'trackerFacebook'
  | 'trackerOptimizely'
  | 'companyName'
  | 'inferredCompanyName'
  | 'industry'
  | 'about'
  | 'locations'
  | 'companySize'
  | 'companyType'
  | 'companyFounded'
  | 'employees';

/**
 * 后台常驻常量
 */
interface DriverConstants {
  /** 缓存有效期：48 小时 */
  expiry: 1000 * 60 * 60 * 48;
  /** 最大主机缓存数：100 */
  maxHostnames: 100;
  /** 每次 ping 最多发送 URL 数：25 */
  maxPingUrls: 25;
  /** 每次 ping 最多发送技术数：25 */
  maxPingTechnologies: 25;
  /** 外部脚本最大字符数：100000 */
  maxExternalScriptChars: 100000;
  /** 持久化防抖延迟：1000ms */
  persistDebounce: 1000;
}

/**
 * 内容脚本常量
 */
interface ContentConstants {
  /** 最大可见文本长度：25000 */
  MAX_TEXT_LENGTH: 25000;
  /** 最大内联脚本数量：50 */
  MAX_INLINE_SCRIPT_COUNT: 50;
  /** 最大内联脚本文本长度：200000 */
  MAX_INLINE_SCRIPT_CHARS: 200000;
  /** 最大 DOM 文本长度：1000000 */
  MAX_DOM_TEXT_LENGTH: 1000000;
  /** 每个技术最大 DOM 命中数：50 */
  MAX_TECH_DETECTIONS: 50;
  /** 语言检测采样长度：5000 */
  LANGUAGE_DETECTION_SAMPLE_LENGTH: 5000;
  /** 语言检测最小文本长度：250 */
  LANGUAGE_DETECTION_MIN_TEXT_LENGTH: 250;
  /** 语言检测最小字母数：120 */
  LANGUAGE_DETECTION_MIN_ALPHA_CHARS: 120;
  /** 语言检测最小单词数：20 */
  LANGUAGE_DETECTION_MIN_WORDS: 20;
  /** 语言检测最小置信度：85% */
  LANGUAGE_DETECTION_MIN_PERCENTAGE: 85;
  /** 语言检测最小边距：25% */
  LANGUAGE_DETECTION_MIN_MARGIN: 25;
}

/**
 * Ping 触发阈值
 * - 累计 25+ URL 且距上次 ping > 1h，或
 * - 累计 5+ URL 且距上次 ping > 48h
 */
interface PingThresholds {
  /** 大批量阈值：25 */
  batch: 25;
  /** 大批量间隔：1 小时 */
  batchInterval: 1000 * 60 * 60;
  /** 小批量阈值：5 */
  batchSmall: 5;
  /** 小批量间隔：48 小时 */
  batchSmallInterval: 1000 * 60 * 60 * 48;
}
