// ============================================================
// Material Icons for GitHub — Type Definitions (dsv4)
// 基于 main.js 逆向工程推导
// ============================================================

/** 支持的图标包枚举 */
export type IconPack =
  | "angular"
  | "nest"
  | "angular_ngrx"
  | "react"
  | "react_redux"
  | "roblox"
  | "qwik"
  | "vue"
  | "vue_vuex"
  | "bashly";

/** 图标尺寸 */
export type IconSize = "sm" | "md" | "lg" | "xl";

/** 文件夹主题模式 */
export type FolderTheme = "specific" | "classic" | "none";

/** 日志级别 */
export type LogLevel = "info" | "warn" | "error" | "debug";

// ---- 文件/文件夹关联 ----

/** 文件扩展名到图标名的映射 */
export interface FileAssociations {
  [extension: string]: string;
}

/** 文件夹名到图标名的映射 */
export interface FolderAssociations {
  [folderName: string]: string;
}

/** 语言 ID 到图标名的映射 */
export interface LanguageAssociations {
  [languageId: string]: string;
}

/** 自定义克隆（覆盖默认图标或新增图标） */
export interface CustomClone {
  name: string;
  fileExtensions?: string[];
  fileNames?: string[];
  light?: boolean;
  highContrast?: boolean;
}

// ---- 图标映射（文件级别） ----

export interface IconMapping {
  /** 文件名到图标名的映射 */
  fileNames: Record<string, string>;
  /** 文件扩展名到图标名的映射 */
  fileExtensions: Record<string, string>;
  /** 语言 ID 到图标名的映射 */
  languageIds: Record<string, string>;
  /** 图标定义（图标名 -> { iconPath }） */
  iconDefinitions: Record<string, { iconPath: string }>;
  /** 亮色主题变体 */
  light?: {
    fileNames: Record<string, string>;
    fileExtensions: Record<string, string>;
  };
  /** 高对比度变体 */
  highContrast?: {
    fileNames: Record<string, string>;
    fileExtensions: Record<string, string>;
  };
}

// ---- 文件夹级别的图标映射 ----

export interface FolderIconMapping {
  /** 普通文件夹名到图标名的映射 */
  folderNames: Record<string, string>;
  /** 展开状态的文件夹名到图标名的映射 */
  folderNamesExpanded: Record<string, string>;
  /** 根文件夹名到图标名的映射 */
  rootFolderNames: Record<string, string>;
  /** 展开状态的根文件夹名到图标名的映射 */
  rootFolderNamesExpanded: Record<string, string>;
  /** 图标定义 */
  iconDefinitions: Record<string, { iconPath: string }>;
  /** 亮色主题变体 */
  light?: Partial<FolderIconMapping>;
  /** 高对比度变体 */
  highContrast?: Partial<FolderIconMapping>;
}

// ---- 扩展设置 ----

export interface ExtensionSettings {
  /** 文件夹设置 */
  folders: {
    theme: FolderTheme;
    color: string;
    associations: FolderAssociations;
    customClones: CustomClone[];
  };
  /** 根文件夹设置 */
  rootFolders: {
    color: string;
    associations: FolderAssociations;
  };
  /** 当前激活的图标包 */
  activeIconPack: IconPack;
  /** 是否隐藏文件浏览器箭头 */
  hidesExplorerArrows: boolean;
  /** 图标不透明度 (0-1) */
  opacity: number;
  /** 图标饱和度 (0-1) */
  saturation: number;
  /** 文件设置 */
  files: {
    color: string;
    associations: FileAssociations;
    customClones: CustomClone[];
  };
  /** 语言设置 */
  languages: {
    associations: LanguageAssociations;
    customClones: CustomClone[];
  };
  /** 是否启用日志 */
  enableLogging: boolean;
  /** 日志级别 */
  logLevel: LogLevel;
}

/** Per-host 运行时设置（存储在 chrome.storage.sync） */
export interface HostSettings {
  iconPack: IconPack;
  iconSize: IconSize;
  /** 是否在当前 host 启用 */
  extEnabled: boolean;
  fileIconBindings: FileAssociations;
  folderIconBindings: FolderAssociations;
}

// ---- 站点配置 ----

/** 域名匹配规则 */
export interface DomainConfig {
  /** 域名（用于显示） */
  host: string;
  /** 正则表达式匹配域名 */
  test: RegExp;
}

/** 行选择器 — 用于选择文件浏览器中的每一行 */
export interface Selectors {
  /** 选择文件/文件夹行的 CSS 选择器 */
  row: string;
  /** 选择文件名元素的 CSS 选择器 */
  filename: string;
  /** 选择图标元素的 CSS 选择器 */
  icon: string;
  /** 检测当前站点的 CSS 选择器（feature detection） */
  detect: string;
}

/** 站点配置 — 定义如何在一个 Git 托管平台上查找和替换图标 */
export interface SiteConfig {
  /** 站点名称 */
  name: string;
  /** 域名列表 */
  domains: DomainConfig[];
  /** 选择器 */
  selectors: Selectors;
  /** 是否支持自托管 */
  canSelfHost: boolean;
  /** 是否为自定义配置 */
  isCustom: boolean;
  /** 判断当前主题是否为浅色 */
  getIsLightTheme: () => boolean;
  /** 判断一行是否为目录 */
  getIsDirectory: (ctx: { row: HTMLElement; icon: HTMLElement }) => boolean;
  /** 判断一行是否为子模块 */
  getIsSubmodule: () => boolean;
  /** 判断一行是否为符号链接 */
  getIsSymlink: (ctx: { icon: HTMLElement }) => boolean;
  /** 替换图标 DOM 元素 */
  replaceIcon: (original: HTMLElement, newIcon: HTMLImageElement) => void;
  /** 添加新行时的回调 */
  onAdd: (row: HTMLElement, callback: () => void) => void;
  /** 转换文件名（可做规范化处理） */
  transformFileName: (row: HTMLElement, icon: HTMLElement, currentName: string) => string;
  /** 表格头行选择器（可选的） */
  tableHeaderRow?: string;
}

// ---- 日志 ----

export interface LogEvent {
  level: LogLevel;
  message: string;
}

export type LogListener = (event: LogEvent) => void;
