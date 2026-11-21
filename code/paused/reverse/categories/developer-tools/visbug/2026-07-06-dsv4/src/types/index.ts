/**
 * VisBug v0.4.10 — 类型定义
 * 从 dist/ 源码中推断的 TypeScript 接口与枚举
 */

// ============================================================
// 后台 Service Worker 状态 (visbug.js)
// ============================================================

/** 每个 tab 的加载/注入状态 */
export interface TabState {
  /** 该 tab 是否已加载过 VisBug */
  loaded: Record<number, boolean>;
  /** 该 tab 中 VisBug 是否处于注入/可见状态 */
  injected: Record<number, boolean>;
}

// ============================================================
// 颜色模式 (contextmenu/colormode.js)
// ============================================================

/** 颜色模式选项 */
export type ColorMode = 'hex' | 'rgb' | 'hsl';

/** 存储键名 */
export const COLOR_MODE_STORAGE_KEY = 'visbug-color-mode';

/** 默认颜色模式 */
export const DEFAULT_COLOR_MODE: ColorMode = 'hex';

/** 颜色模式状态 */
export interface ColorModeState {
  mode: ColorMode;
}

// ============================================================
// 颜色方案/主题 (contextmenu/colorscheme.js)
// ============================================================

/** 颜色方案选项 */
export type ColorScheme = 'auto' | 'light' | 'dark';

/** 存储键名 */
export const COLOR_SCHEME_STORAGE_KEY = 'visbug-color-scheme';

/** 默认颜色方案 */
export const DEFAULT_COLOR_SCHEME: ColorScheme = 'auto';

/** 颜色方案状态 */
export interface ColorSchemeState {
  mode: ColorScheme;
}

// ============================================================
// 运行时消息类型 (toolbar/inject.js 中的 onMessage)
// ============================================================

/** 颜色模式变更消息 */
export interface ColorModeMessage {
  action: 'COLOR_MODE';
  params: {
    mode: ColorMode;
  };
}

/** 颜色方案变更消息 */
export interface ColorSchemeMessage {
  action: 'COLOR_SCHEME';
  params: {
    mode: ColorScheme;
  };
}

/** 所有可能的运行时消息 */
export type RuntimeMessage = ColorModeMessage | ColorSchemeMessage;

// ============================================================
// Context Menu ID 常量
// ============================================================

export const CONTEXT_MENU_IDS = {
  LAUNCHER: 'launcher',
  COLOR_MODE: 'color-mode',
  COLOR_SCHEME: 'color-scheme',
} as const;

// ============================================================
// VisBug 自定义元素
// ============================================================

/** <vis-bug> 自定义元素的属性 */
export interface VisBugAttributes {
  /** 教程 GIF 的基础 URL 路径 */
  'tutsBaseURL': string;
  /** 当前颜色模式 (hex/rgb/hsl) */
  'color-mode'?: ColorMode;
  /** 当前颜色方案 (auto/light/dark) */
  'color-scheme'?: ColorScheme;
}

// ============================================================
// 注入/弹出脚本
// ============================================================

/** toolbar/inject.js 注入逻辑的抽象 */
export interface InjectResult {
  /** 注入的 <vis-bug> 元素 */
  visbugElement: HTMLElement;
  /** 加载的 bundle 脚本元素 */
  bundleScript: HTMLScriptElement;
}

/** toolbar/eject.js 移除逻辑的抽象 */
export interface EjectAnimation {
  /** 移除前的动画效果 (translateX + opacity) */
  animation: Keyframe[];
  /** 动画时长 300ms, ease-out */
  options: KeyframeAnimationOptions;
}

// ============================================================
// 平台适配
// ============================================================

/**
 * 兼容 Chrome 和 Firefox 的浏览器 API 命名空间
 * Firefox 使用 `browser`, Chrome 使用 `chrome`
 */
export type BrowserPlatform = typeof chrome;
