/**
 * copy-link-to-clipboard v15.1.3 — TypeScript 类型定义
 * 从源码变量使用模式、API 调用和存储键名推断重建
 */

// ============================================================================
// 格式类型
// ============================================================================

/** 支持的链接格式 ID */
export type FormatId =
  | 'AsciiDoc'
  | 'BBCode'
  | 'CSV'
  | 'DokuWiki'
  | 'HTMLHyper'
  | 'HTMLPlain'
  | 'Jira'
  | 'LaTeX'
  | 'Markdown'
  | 'MediaWiki'
  | 'OrgMode'
  | 'Textile'
  | 'TextOnly'
  | 'TextURL'
  | 'URLOnly'
  | 'reStructuredText';

/** 格式定义条目 */
export interface FormatItem {
  id: FormatId;
  enabled: boolean;
  menu: string;
  template: string;
  templateAlt?: string;
  title?: string;
}

/** 格式数据字典 */
export type FormatData = Record<FormatId, FormatItem>;

// ============================================================================
// 操作类型 (menuItemId 前缀)
// ============================================================================

export type CopyActionPrefix =
  | 'copyAllTabsURL'
  | 'copyLinkURL'
  | 'copyOtherTabsURL'
  | 'copyPageURL'
  | 'copyTabURL'
  | 'copyTabsURL';

// ============================================================================
// 上下文信息 (从页面提取)
// ============================================================================

export interface ContextInfo {
  canonicalUrl: string | null;
  content: string | null;
  isLink: boolean;
  selectionText: string | null;
  title: string | null;
  url: string | null;
}

// ============================================================================
// 标签页复制数据
// ============================================================================

export interface TabLinkData {
  id: number;
  formatId: FormatId;
  template: string;
  title: string;
  url: string;
  content: string;
  attr?: string;
}

// ============================================================================
// 剪贴板操作选项
// ============================================================================

export interface CopyOptions {
  formatTitle: string;
  mimeType: 'text/html' | 'text/plain';
  text: string;
  notify: boolean;
}

// ============================================================================
// 上下文菜单项定义
// ============================================================================

export interface MenuItemDefinition {
  id: string;
  contexts: chrome.contextMenus.ContextType[];
  key: string;
}

export type MenuItems = Record<string, MenuItemDefinition>;

// ============================================================================
// 存储键名枚举
// ============================================================================

export const STORAGE_KEYS = {
  // 格式启用状态
  ASCIIDOC: 'AsciiDoc',
  BBCODE: 'BBCode',
  CSV: 'CSV',
  DOKUWIKI: 'DokuWiki',
  HTML_HYPER: 'HTMLHyper',
  HTML_PLAIN: 'HTMLPlain',
  JIRA: 'Jira',
  LATEX: 'LaTeX',
  MARKDOWN: 'Markdown',
  MEDIAWIKI: 'MediaWiki',
  ORG_MODE: 'OrgMode',
  RESTRUCTURED_TEXT: 'reStructuredText',
  TEXTILE: 'Textile',
  TEXT_ONLY: 'TextOnly',
  TEXT_URL: 'TextURL',
  URL_ONLY: 'URLOnly',

  // 用户选项
  ATTR_HTML_HYPER: 'attributesHTMLHyper',
  ATTR_HTML_PLAIN: 'attributesHTMLPlain',
  INCLUDE_ATTR_HTML_HYPER: 'includeAttrHTMLHyper',
  INCLUDE_ATTR_HTML_PLAIN: 'includeAttrHTMLPlain',
  INCLUDE_TITLE_HTML_HYPER: 'includeTitleHTMLHyper',
  INCLUDE_TITLE_HTML_PLAIN: 'includeTitleHTMLPlain',
  INCLUDE_TITLE_MARKDOWN: 'includeTitleMarkdown',
  NOTIFY_COPY: 'notifyOnCopy',
  PREFER_CANONICAL: 'preferCanonicalUrl',
  PROMPT_CONTENT: 'promptContent',
  TEXT_FRAG_HTML_HYPER: 'createTextFragmentsHTMLHyper',
  TEXT_FRAG_HTML_PLAIN: 'createTextFragmentsHTMLPlain',
  TEXT_SEP_LINES: 'separateTextURL',

  // 图标
  ICON_BLACK: 'buttonIconBlack',
  ICON_COLOR: 'buttonIconColor',
  ICON_DARK: 'buttonIconDark',
  ICON_LIGHT: 'buttonIconLight',
  ICON_WHITE: 'buttonIconWhite',
  ICON_AUTO: 'buttonIconAuto',
  ICON_RADIO: 'buttonIconRadio',
} as const;

// ============================================================================
// 用户选项
// ============================================================================

export interface UserOptions {
  /** HTML Hyper 格式的额外属性 */
  attributesHTMLHyper: string;
  /** HTML Plain 格式的额外属性 */
  attributesHTMLPlain: string;
  /** HTML Hyper 是否包含 title 属性 */
  includeTitleHTMLHyper: boolean;
  /** HTML Plain 是否包含 title 属性 */
  includeTitleHTMLPlain: boolean;
  /** Markdown 是否包含 title */
  includeTitleMarkdown: boolean;
  /** HTML Hyper 是否包含自定义属性 */
  includeAttrHTMLHyper: boolean;
  /** HTML Plain 是否包含自定义属性 */
  includeAttrHTMLPlain: boolean;
  /** HTML Hyper 是否创建文本片段链接 */
  createTextFragmentsHTMLHyper: boolean;
  /** HTML Plain 是否创建文本片段链接 */
  createTextFragmentsHTMLPlain: boolean;
  /** 复制时是否通知 */
  notifyOnCopy: boolean;
  /** 是否优先使用 canonical URL */
  preferCanonicalUrl: boolean;
  /** 复制时是否弹出编辑提示 */
  promptContent: boolean;
  /** Text & URL 格式是否分两行 */
  separateTextURL: boolean;
}

// ============================================================================
// 存储值结构
// ============================================================================

export interface StorageValue {
  id: string;
  value: string;
  checked: boolean;
  subItemOf?: string | null;
}

// ============================================================================
// 消息类型 (runtime.sendMessage 消息契约)
// ============================================================================

export type MessageKey =
  | 'contextInfo'
  | 'executeCopy'
  | 'getContextInfo'
  | 'notifyOnCopy'
  | 'promptContent'
  | 'sanitizeAttributes'
  | 'sanitizeURL';

export interface ContextInfoMessage {
  contextInfo: {
    contextInfo: ContextInfo;
  };
}

export interface ExecCopyMessage {
  executeCopy: {
    info: chrome.contextMenus.OnClickData;
    tab: chrome.tabs.Tab;
  };
}

export interface NotifyCopyMessage {
  notifyOnCopy: string; // formatTitle
}

export interface PromptContentMessage {
  promptContent: [content: string, promptMsg: string];
}

export interface SanitizeAttributesMessage {
  sanitizeAttributes: string;
}

export interface SanitizeUrlMessage {
  sanitizeURL: [url: string, options: { allow: string[]; revokeObjectURL: boolean }];
}

export type RuntimeMessage =
  | ContextInfoMessage
  | ExecCopyMessage
  | NotifyCopyMessage
  | PromptContentMessage
  | SanitizeAttributesMessage
  | SanitizeUrlMessage;

// ============================================================================
// MIME 类型常量
// ============================================================================

export const MIME_TYPES = {
  HTML: 'text/html' as const,
  PLAIN: 'text/plain' as const,
  XHTML: 'application/xhtml+xml' as const,
};

// ============================================================================
// 扩展标识
// ============================================================================

export const EXTENSION_ID = 'url2clipboard@asamuzak.jp';

// ============================================================================
// 命令 ID
// ============================================================================

export type CommandId =
  | 'commandCopyHTMLPlain'
  | 'commandCopyHTMLHyper'
  | 'commandCopyMarkdown'
  | 'commandCopyBBCode'
  | 'commandCopyTextile'
  | 'commandCopyAsciiDoc'
  | 'commandCopyMediaWiki'
  | 'commandCopyDokuWiki'
  | 'commandCopyJira'
  | 'commandCopyreStructuredText'
  | 'commandCopyLaTeX'
  | 'commandCopyOrgMode'
  | 'commandCopyCSV'
  | 'commandCopyTextURL'
  | 'commandCopyTextOnly'
  | 'commandCopyURLOnly';

// ============================================================================
// 浏览器 API 包装器返回类型
// ============================================================================

export interface BrowserInfo {
  name: string;
  vendor: string;
  version: string;
  buildID: string;
}
