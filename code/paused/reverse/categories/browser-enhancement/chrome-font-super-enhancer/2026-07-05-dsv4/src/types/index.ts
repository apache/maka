/**
 * Chrome Font Super Enhancer — TypeScript 类型定义
 *
 * 本文件基于对扩展源码的逆向工程，定义了所有核心数据结构和接口。
 * 版本: 2.25 (对应 manifest.json version)
 */

// ============================================================================
// chrome.storage.sync 存储的选项数据结构
// ============================================================================

/** 扩展配置（持久化到 chrome.storage.sync） */
export interface ExtensionOptions {
  /** 字体加粗等级 (0-9)，存储为字符串 */
  Thickness: string;
  /** 扩展总开关 */
  Enab: boolean;
  /** 深色模式支持（浅色文字也加粗） */
  Darkmodesupport: boolean;
  /** 字间距增加值 (0-20)，存储为字符串 */
  LetterSpacing: string;
  /** 排除的域名列表 */
  excludedDomains: string[];
  /** 解锁码（捐赠后获得） */
  unlockCode: string;
}

/** chrome.storage.sync 读取时的默认值 */
export const DEFAULT_OPTIONS: ExtensionOptions = {
  Thickness: '0',
  Enab: true,
  Darkmodesupport: false,
  LetterSpacing: '0',
  excludedDomains: [],
  unlockCode: '',
};

// ============================================================================
// chrome.storage.local 存储的运行时数据
// ============================================================================

/** 本地运行时数据 */
export interface LocalState {
  /** 管理被排除网站的弹出窗口 ID */
  manageWindowId: number | null;
}

// ============================================================================
// 消息传递类型
// ============================================================================

/** popup.js → service-worker.js 的消息 */
export interface PopupOpenedMessage {
  type: 'popupOpened';
}

/** 运行时消息联合类型 */
export type RuntimeMessage = PopupOpenedMessage;

// ============================================================================
// content.js 内部数据结构
// ============================================================================

/** RGB(A) 颜色解析结果 */
export type ParsedColor = [number, number, number, number?];

/** 元素可见包含直接文本节点的结果 */
export interface ElementWithText {
  element: Element;
  hasDirectText: boolean;
}

// ============================================================================
// manage.html 页面 URL 参数
// ============================================================================

/** manage.html 页面查询参数 */
export interface ManagePageParams {
  /** 来源标签页 ID */
  tabId: string;
  /** 来源域名 */
  host: string;
}

// ============================================================================
// 常量
// ============================================================================

/** content script 中排除的非视觉/纯容器元素选择器 */
export const EXCLUDED_ELEMENT_SELECTOR =
  ':not(script):not(style):not(area):not(base):not(br):not(col):not(embed):not(hr):not(img):not(keygen):not(link):not(meta):not(param):not(source):not(track):not(wbr):not(table):not(tbody):not(tr):not(ul)';

/** 不做阴影处理的 input type */
export const EXCLUDED_INPUT_TYPES: readonly string[] = [
  'range',
  'color',
  'checkbox',
  'radio',
  'image',
  'hidden',
];

/** 厚度滑块范围 */
export const THICKNESS_RANGE = { min: 0, max: 9 } as const;

/** 字间距滑块范围 */
export const LETTER_SPACING_RANGE = { min: 0, max: 20 } as const;

/** MutationObserver 批量处理防抖延迟 (ms) */
export const DEBOUNCE_DELAY_MS = 100;

/**
 * 解锁码生成算法的种子短语。
 *
 * 算法: 将短语按空格分割 → reduceRight → 每个词取 word[7 - index]
 *
 * 计算结果: "Apz4m1-s"
 */
export const UNLOCK_CODE_SEED =
  'Contexts binary-o Stage100 parameter 80040000 unzipped Append Async';
