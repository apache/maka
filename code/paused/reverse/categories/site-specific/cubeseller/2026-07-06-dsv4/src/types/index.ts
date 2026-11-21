// ============================================================
// CubeSeller 逆向工程 — 类型定义
// 基于 dist/ 目录中的实际运行时代码反推
// ============================================================

// ---- 平台标识 ----

/** 支持的电商/内容平台标识符 (从 background.js 提取规则配置推断) */
export type PlatformId =
  | '1688'
  | 'tmall'
  | 'taobao'
  | 'jd.com'
  | 'pinduoduo'
  | 'alibaba'
  | 'aliexpress'
  | 'shopee'
  | 'lazada'
  | 'wish'
  | 'suning'
  | 'vip.com'
  | 'kaola'
  | 'amazon'
  | 'shein'
  | 'temu'
  | 'etsy.com'
  | 'coupang'
  | 'qoo10'
  | 'dhgate'
  | 'farfetch'
  | 'xiaohongshu'
  | 'douyin'
  | 'weibo'
  | 'weixin'
  | 'bilibili'
  | 'instagram'
  | 'pinterest'
  | 'google'
  | 'bing'
  | 'baidu'
  | 'yandex'
  | 'pixiv'
  | string // 支持动态添加的平台

// ---- 提取规则配置 ----

/** 单个替换规则 */
export interface ReplaceUrlRule {
  /** 匹配用的正则表达式 */
  reg: string
  /** 替换为的字符串 */
  replace: string
}

/** CSS 选择器提取规则 */
export interface SelectorRule {
  /** CSS 选择器 (字符串或字符串数组) */
  selector: string | string[]
  /** 要提取的属性列表 (如 "src", "dataset.original", "href") */
  attributes: string[]
  /** URL 替换规则 */
  replaceUrlRules?: ReplaceUrlRule[]
}

/** 资源分组定义 */
export interface ResourceGroup {
  /** 分组名称 (如 "主图", "SKU图", "详情图", "视频") */
  groupName: string
  /** 资源类型 */
  type: 'img' | 'video' | 'imgComment'
  /** 提取规则列表 */
  rules: SelectorRule[]
}

/** 提取函数配置 */
export interface ExtractFuncConfig {
  /** 主类型 */
  mainType: 'func' | 'comment' | 'jsonp' | 'default'
  /** 提取函数名 */
  funcName: string
  /** 函数参数 */
  params: ResourceGroup[]
}

/** 单个平台的完整提取规则配置 */
export interface PlatformConfig {
  /** 平台显示名称 */
  name: string
  /** 功能描述 */
  desc: string
  /** 平台图标 (base64 data URI 或图标 URL) */
  icon: string
  /** URL 匹配正则 */
  reg: string
  /** 排序优先级 (数字越小越靠前) */
  index: number
  /** 规则分组 (用于UI中分类展示) */
  group: string[]
  /** 请求过滤 (替换 URL 中特定参数的规则) */
  filters: FilterRule[]
  /** 提取规则 JSON 字符串 */
  config: string
}

/** URL 参数过滤规则 */
export interface FilterRule {
  /** 参数字段名 */
  fieldName: string
  /** 匹配正则 */
  reg: string
  /** 替换值 */
  replace: string
}

// ---- 提取规则版本管理 ----

/** 提取规则集的总结构 (background.js 中 JSON.parse 的顶层结构) */
export interface RulesRegistry {
  /** 规则版本号 (如 "2.0.0.20") */
  r: string
  /** 按域名索引的平台配置表 */
  Q: Record<string, PlatformConfig>
}

// ---- 消息通信 ----

/** background.js → 所有监听者的消息类型 */
export type BackgroundMessageType =
  | 'setReferers'
  | 'imgFetch'
  | 'download'
  | 'getCookies'
  | 'setCookie'
  | 'makeXHRrequest'
  | 'makeXHPostRrequest'
  | 'addCutout'
  | 'delCutout'
  | 'getCutout'
  | 'addTranslate'
  | 'delTranslate'
  | 'getTranslate'
  | 'updateShowBtnFromBg'

/** content script → background 的消息结构 */
export interface CS2BGMessage {
  /** 消息类型 */
  type: BackgroundMessageType
  /** 图片 URL (imgFetch 使用) */
  url?: string
  /** DNR 规则列表 (setReferers 使用) */
  fRules?: DNRRule[]
  /** 下载配置 */
  downloadCfg?: DownloadConfig
  /** Cookies 参数 */
  cookieOpts?: CookieOptions
  /** XHR 目标 URL */
  targetUrl?: string
  /** 数据负载 */
  data?: unknown
  /** 其他扩展字段 */
  [key: string]: unknown
}

/** 下载配置 */
export interface DownloadConfig {
  url: string
  filename: string
  conflictAction?: 'uniquify' | 'overwrite' | 'prompt'
  saveAs?: boolean
  method?: 'GET' | 'POST'
  headers?: { name: string; value: string }[]
  body?: string
}

/** Cookie 操作参数 */
export interface CookieOptions {
  url: string
  name: string
  value?: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: 'strict' | 'lax' | 'no_restriction'
  expirationDate?: number
}

// ---- Content Script 页面内通信 ----

/** content script → extract page 的消息 */
export interface CSExtractMessage {
  type: 'openProduct' | 'openCommend' | 'openEcWindow' | 'getProduct' | 'openProduct'
  /** 提取的数据 */
  data?: ExtractedProductData
  /** 提取规则配置 */
  rulesConfig?: PlatformConfig
  /** 目标 tab ID */
  tabId?: number
}

/** Product extraction trigger */
export interface ProductExtractRequest {
  type: 'getProduct'
  /** 获取方式: auto(自动识别) 或 指定平台ID */
  mode: 'auto' | PlatformId
}

// ---- 提取结果数据 ----

/** 商品页面识别出的资源分组结果 */
export interface ResourceGroupResult {
  /** 分组名 */
  groupName: string
  /** 资源类型 */
  type: 'img' | 'video'
  /** 资源 URL 列表 */
  urls: string[]
  /** 资源元数据 (宽高等) */
  meta?: ResourceMeta[]
}

/** 单个资源的元数据 */
export interface ResourceMeta {
  url: string
  width?: number
  height?: number
  name?: string
  size?: number
}

/** 提取的完整商品数据 */
export interface ExtractedProductData {
  /** 页面标题 */
  title: string
  /** 页面 URL */
  url: string
  /** 商品 ID */
  productId?: string
  /** 资源分组 */
  groups: ResourceGroupResult[]
  /** 评论图片 */
  commentImages?: ResourceGroupResult
  /** 视频资源 */
  videos?: ResourceGroupResult
}

/** 评论页面提取结果 */
export interface CommentExtractResult {
  /** 评论页面提取的图片 */
  images: ResourceGroupResult
  /** 评论总页数 */
  totalPages: number
  /** 当前页 */
  currentPage: number
}

// ---- Declarative Net Request ----

/** DNR 动态规则 */
export interface DNRRule {
  id: number
  priority: number
  action: {
    type: 'modifyHeaders'
    requestHeaders: ModifyHeaderAction[]
  }
  condition: DNRRuleCondition
}

/** 请求头修改动作 */
export interface ModifyHeaderAction {
  header: string
  operation: 'set' | 'remove' | 'append'
  value: string
}

/** DNR 规则匹配条件 */
export interface DNRRuleCondition {
  urlFilter: string
  resourceTypes: string[]
  initiatorDomains?: string[]
}

// ---- 图片翻译与抠图 ----

/** 翻译/抠图任务 */
export interface ImageProcessTask {
  /** 任务 ID */
  id: string
  /** 图片 URL */
  url: string
  /** 目标语言 (翻译用) */
  targetLang?: string
  /** 任务状态 */
  status: 'pending' | 'processing' | 'completed' | 'failed'
}

/** ushangtech.com 翻译/抠图回调数据 */
export interface UshangProcessResult {
  type: 'ec_translate_succ' | 'ec_cutout_succ'
  data: ImageProcessTask[]
}

// ---- 存储 ----

/** chrome.storage.local 中的用户配置 */
export interface CubeSellerStorage {
  /** 提取规则 (用户自定义规则) */
  extractionRules?: PlatformConfig[]
  /** 是否显示页面悬浮按钮 */
  showPageButton?: boolean
  /** 登录凭据 */
  credentials?: {
    email?: string
    token?: string
  }
  /** 版本信息 */
  version?: string
  /** 用户偏好 */
  preferences?: {
    /** 下载方式: direct(直接) | zip(打包) */
    downloadMode: 'direct' | 'zip'
    /** 文件命名规则 */
    namingRule: {
      /** 序号格式 */
      numberFormat: string
      /** 文件层级 */
      folderStructure: 'flat' | 'grouped'
      /** 是否包含 SKU 属性 */
      includeSkuInfo: boolean
      /** 是否包含时间戳 */
      includeTimestamp: boolean
      /** 是否包含分类名 */
      includeCategory: boolean
    }
  }
}

// ---- 窗口间通信 (Cross-tab / Window) ----

/** windowDataMessage.js 桥接的消息 */
export interface WindowDataMessage {
  type: 'ext_gwd_EC_16931258'
  /** 在 window 对象上要读取的属性路径列表 */
  paths: string[]
  /** 回调消息类型标识 */
  cbType: string
}

/** window 数据提取回调 */
export interface WindowDataCallback {
  type: string
  data: unknown[]
}

// ---- 悬浮通知 ----

/** message.js 通知样式 */
export type MessageType = 'success' | 'failed' | 'login'

/** EC_message 通知载荷 */
export interface ECMessage {
  type: 'EC_message'
  flag: 'EC_success' | 'EC_failed' | 'EC_login'
}
