// ============================================================
// CSS Peeper dsV4 — 反向工程类型定义
// 基于 Chrome 扩展 v1.2.2 (Manifest V3) 源码分析
// ============================================================

/**
 * 元素检查结果
 * 当用户在页面上选中一个元素后，CSS Peeper 返回的完整信息
 */
export interface InspectResult {
  /** 选中的 DOM 元素引用 */
  element: HTMLElement | null;

  /** 元素的 CSS 选择器路径 */
  selector: string;

  /** 元素的标签名（小写） */
  tagName: string;

  /** 计算后的样式 (CSSStyleDeclaration) */
  computedStyles: Record<string, string>;

  /** 内联样式 (style 属性) */
  inlineStyles: Record<string, string>;

  /** 元素的边界矩形 */
  boundingRect: DOMRect;

  /** 提取的颜色调色板 */
  colorPalette: ColorPalette;

  /** 排版信息 */
  typography: TypographyInfo;

  /** 所有 CSS 属性列表（过滤后） */
  cssProperties: CSSProperty[];

  /** 元素上的 class 列表 */
  classList: string[];

  /** 元素的 ID */
  id: string;

  /** 元素的文本内容 */
  textContent: string;

  /** 检查时间戳 */
  timestamp: number;
}

/**
 * 颜色调色板
 * 从元素及其伪元素中提取的颜色信息
 */
export interface ColorPalette {
  /** 背景色 (background-color) */
  backgroundColor: ColorInfo;

  /** 文本颜色 (color) */
  textColor: ColorInfo;

  /** 边框颜色 (border-color) */
  borderColor: ColorInfo;

  /** 从元素中检测到的所有颜色列表 */
  allColors: ColorInfo[];

  /** 唯一颜色列表（去重后） */
  uniqueColors: ColorInfo[];

  /** 渐变色列表 */
  gradients: GradientInfo[];

  /** 是否有透明度 */
  hasAlpha: boolean;
}

/**
 * 单个颜色信息
 */
export interface ColorInfo {
  /** HEX 格式颜色值，如 "#5D2DE6" */
  hex: string;

  /** RGB 格式颜色值，如 "rgb(93, 45, 230)" */
  rgb: string;

  /** HSL 格式颜色值，如 "hsl(256, 80%, 54%)" */
  hsl: string;

  /** 透明度 (0-1)，1 表示完全不透明 */
  alpha: number;

  /** 颜色来源 CSS 属性名 */
  sourceProperty: string;

  /**
   * 语义化颜色名称
   * 如 "peeper-purple", "primary", "white", "gray-500" 等
   * 匹配自 Tailwind/自定义设计 token
   */
  semanticName: string | null;

  /** WCAG 对比度评分 (相对于白色/黑色背景) */
  contrastRatio: ContrastRatio;
}

/**
 * 渐变色信息
 */
export interface GradientInfo {
  /** 渐变类型: linear-gradient | radial-gradient | conic-gradient */
  type: "linear" | "radial" | "conic";

  /** 渐变角度 (仅 linear) */
  angle: number;

  /** 色标列表 */
  colorStops: ColorStop[];

  /** 原始 CSS 值 */
  rawValue: string;
}

/** 渐变色标 */
export interface ColorStop {
  /** 色标颜色 */
  color: string;

  /** 色标位置 (百分比或像素) */
  position: string;
}

/**
 * WCAG 对比度
 */
export interface ContrastRatio {
  /** 对比度数值 (如 4.5, 7.0) */
  ratio: number;

  /** 相对于白色背景的对比度 */
  againstWhite: number;

  /** 相对于黑色背景的对比度 */
  againstBlack: number;

  /** 是否满足 WCAG AA 级 (>= 4.5) */
  isAaCompliant: boolean;

  /** 是否满足 WCAG AAA 级 (>= 7.0) */
  isAaaCompliant: boolean;
}

/**
 * 排版信息
 * 从元素计算样式中提取的字体相关属性
 */
export interface TypographyInfo {
  /** 字体族 (font-family) */
  fontFamily: string;

  /** 字体大小 (font-size) */
  fontSize: string;

  /** 字体大小数值 (px) */
  fontSizePx: number;

  /** 字体粗细 (font-weight) */
  fontWeight: number;

  /** 字体样式 (font-style) */
  fontStyle: string;

  /** 行高 (line-height) */
  lineHeight: string;

  /** 行高数值 (px 或无单位) */
  lineHeightValue: number;

  /** 字间距 (letter-spacing) */
  letterSpacing: string;

  /** 文本对齐 (text-align) */
  textAlign: string;

  /** 文本装饰 (text-decoration) */
  textDecoration: string;

  /** 文本变换 (text-transform) */
  textTransform: string;

  /** 是 Google Font 还是系统字体 */
  isWebFont: boolean;

  /** 实际渲染的字体名 */
  renderedFont: string;
}

/**
 * 单个 CSS 属性条目
 * Side panel 中显示的每行 CSS 属性
 */
export interface CSSProperty {
  /** CSS 属性名 (如 "font-size", "color", "display") */
  name: string;

  /** CSS 属性值 (如 "16px", "#333", "flex") */
  value: string;

  /** 属性分组，用于侧栏分类展示 */
  group: CSSPropertyGroup;

  /** 是否为简写属性 (shorthand) */
  isShorthand: boolean;

  /** 是否被其他规则覆盖 */
  isOverridden: boolean;

  /** 来源样式表的 URL（内联则为 null） */
  source: string | null;
}

/**
 * CSS 属性分组
 * Side panel 中按此分组折叠/展开
 */
export type CSSPropertyGroup =
  | "layout"
  | "spacing"
  | "typography"
  | "colors"
  | "background"
  | "border"
  | "effects"
  | "flexbox"
  | "grid"
  | "other";

// ============================================================
// 扩展内部消息类型
// ============================================================

/**
 * Chrome Extension 消息类型
 * 用于 content script <-> service worker <-> side panel 通信
 */
export type ExtensionMessageType =
  /** 定位元素请求 (sidepanel -> content) */
  | "LOCATE_ELEMENT"
  /** 检查元素请求 */
  | "INSPECT_ELEMENT"
  /** 获取计算样式 */
  | "GET_COMPUTED_STYLES"
  /** 获取颜色调色板 */
  | "GET_COLOR_PALETTE"
  /** 获取排版信息 */
  | "GET_TYPOGRAPHY"
  /** 激活检查模式 */
  | "ACTIVATE_INSPECTOR"
  /** 停用检查模式 */
  | "DEACTIVATE_INSPECTOR"
  /** 检查结果 */
  | "INSPECT_RESULT"
  /** 错误 */
  | "ERROR";

/**
 * 扩展内部消息
 */
export interface ExtensionMessage {
  type: ExtensionMessageType;

  /** 目标 tab ID（发送给 service worker 时） */
  tabId?: number;

  /** 元素定位数据 */
  elementData?: ElementLocatorData;

  /** 元素在匹配列表中的索引 */
  indexOfElement?: number;

  /** 消息 payload */
  payload?: unknown;
}

/**
 * 元素定位器数据
 * 用于在页面上定位并高亮元素
 */
export interface ElementLocatorData {
  /** 标签名 */
  tag: string;

  /** 匹配的元素列表 */
  elements: ElementMatch[];

  /** 类名 */
  className?: string;

  /** ID */
  id?: string;
}

/**
 * 元素匹配条件
 */
export interface ElementMatch {
  /** 文本内容 */
  text: string;

  /** 类名 */
  className: string;

  /** 匹配样式条件 */
  styles?: Record<string, string>;
}

/**
 * 扩展消息响应
 */
export interface ExtensionMessageResponse {
  success: boolean;
  message?: string;
  data?: unknown;
}

// ============================================================
// Side Panel 应用状态
// ============================================================

/**
 * Side Panel 全局应用状态
 */
export interface SidePanelState {
  /** 扩展是否处于检查模式 */
  isInspectorActive: boolean;

  /** 当前选中的元素信息 */
  activeElement: InspectResult | null;

  /** 当前激活的 tab 页 */
  activeTab: SidePanelTab;

  /** 是否正在加载 */
  isLoading: boolean;

  /** 错误信息 */
  error: string | null;

  /** 产品功能访问级别: free | pro */
  licenseTier: "free" | "pro";

  /** 颜色主题: light | dark */
  theme: "light" | "dark";
}

/**
 * Side Panel Tab 页
 */
export type SidePanelTab =
  | "colors"
  | "typography"
  | "properties"
  | "styles"
  | "export";

// ============================================================
// 扩展容器 & 覆盖层
// ============================================================

/**
 * 扩展容器配置
 * CSS Peeper 在页面中注入一个固定定位的隔离容器，
 * 所有覆盖层和定位指示器都渲染在容器内
 */
export interface ExtensionContainerConfig {
  /** 容器 ID: "csspeeper-extension-container" */
  containerId: string;

  /** 覆盖层 z-index */
  overlayZIndex: string; // "2147483646"

  /** 面板 z-index */
  panelZIndex: string; // "2147483647"
}

/**
 * 当前高亮覆盖层
 */
export interface CurrentOverlay {
  /** 覆盖层 DOM 元素 */
  element: HTMLElement;

  /** 更新位置以跟踪目标元素 */
  updatePosition: (targetElement: HTMLElement) => void;

  /** 显示覆盖层 */
  show: () => void;

  /** 隐藏覆盖层 */
  hide: () => void;

  /** 销毁覆盖层 */
  destroy: () => void;
}

// ============================================================
// 存储
// ============================================================

/**
 * Chrome Storage 中保存的用户偏好
 */
export interface StorageSchema {
  /** 当前主题 */
  theme?: "light" | "dark";

  /** 已完成的 onboarding 步骤 */
  onboardingCompleted?: boolean;

  /** 用户许可证信息 */
  license?: {
    tier: "free" | "pro";
    features: string[];
  };
}
