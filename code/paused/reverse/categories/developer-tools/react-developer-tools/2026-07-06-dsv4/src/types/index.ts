// ============================================================
// React Developer Tools v7.0.1 — TypeScript 类型定义
// 来源：逆向工程分析（dsv4 工作流）
// 生成日期：2026-07-06
// ============================================================

// ============================================================
// 1. 全局 Hook（注入到页面主世界的全局对象）
// ============================================================

/** React DevTools 的全局 Hook 接口，由 installHook.js 注入到页面主世界 */
export interface ReactDevToolsGlobalHook {
  /** 已注册的渲染器后端映射：版本号 → 渲染器接口 */
  backends: Map<string, RendererBackend>;

  /** 已附加的渲染器列表 */
  renderers: Map<number, RendererInterface>;

  /** 是否有不支持的渲染器版本附加 */
  hasUnsupportedRendererAttached: boolean;

  /** Hook 设置（由 hookSettingsInjector 写入） */
  settings?: HookSettings;

  /** React DevTools Agent 实例引用 */
  reactDevtoolsAgent?: Agent;

  /** Chrome DevTools 的 $0 快捷引用 */
  $0?: HTMLElement;

  /** Observable 模式的 emit 方法 */
  emit(event: string, ...args: unknown[]): void;

  /** 订阅事件，返回取消订阅函数 */
  sub(event: string, listener: (...args: unknown[]) => void): () => void;

  /** 触发事件 */
  on(event: string, listener: (...args: unknown[]) => void): void;
}

// ============================================================
// 2. Hook 设置
// ============================================================

/** 存储在 chrome.storage.local 中的 Hook 设置 */
export interface HookSettings {
  /** 是否附加组件堆栈信息 */
  appendComponentStack: boolean;
  /** 是否在控制台错误时断点 */
  breakOnConsoleErrors: boolean;
  /** 是否显示内联警告和错误 */
  showInlineWarningsAndErrors: boolean;
  /** 是否在严格模式下隐藏控制台日志 */
  hideConsoleLogsInStrictMode: boolean;
}

/** 默认 Hook 设置 */
export const DEFAULT_HOOK_SETTINGS: HookSettings = {
  appendComponentStack: true,
  breakOnConsoleErrors: false,
  showInlineWarningsAndErrors: true,
  hideConsoleLogsInStrictMode: false,
};

// ============================================================
// 3. 渲染器接口
// ============================================================

/** 渲染器信息（来自页面中的 React 实例） */
export interface RendererInfo {
  /** 调和器版本 */
  reconcilerVersion?: string;
  /** React 版本 */
  version?: string;
  /** 构建类型: 0=development, 1=production, 2=profiling 等 */
  bundleType?: number;
}

/** React 渲染器提供的接口 */
export interface RendererInterface {
  /** 渲染器信息 */
  renderer: RendererInfo;

  /** 清空所有错误和警告 */
  clearErrorsAndWarnings(): void;

  /** 清空特定元素的错误 */
  clearErrorsForElementID(id: number): void;

  /** 清空特定元素的警告 */
  clearWarningsForElementID(id: number): void;

  /** 按路径获取序列化值 */
  getSerializedElementValueByPath(id: number, path: string[]): unknown;

  /** 按路径删除值 */
  deletePath(type: string, id: number, hookID: number | null, path: string[]): void;

  /** 按路径重命名 */
  renamePath(type: string, id: number, hookID: number | null, oldPath: string[], newPath: string[]): void;

  /** 检查元素 */
  inspectElement(requestID: number, id: number, path: string[] | null, forceFullData: boolean): InspectedElementResult;

  /** 获取元素所有者列表 */
  getOwnersList(id: number): Owner[];

  /** 获取元素路径 */
  getPathForElement(id: number): string[] | null;

  /** 获取最佳匹配的追踪路径 */
  getBestMatchForTrackedPath(): TrackedPathMatch | null;

  /** 获取性能分析数据 */
  getProfilingData(): ProfilingData;

  /** 按属性路径获取 */
  getElementAttributeByPath(id: number, path: (string | number)[]): unknown;

  /** 查找宿主实例（DOM 节点） */
  findHostInstancesForElementID(id: number): HTMLElement[] | null;

  /** 查找最后一个已知矩形 */
  findLastKnownRectsForID(id: number): Rect[] | null;

  /** 获取元素宿主实例 ID */
  getElementIDForHostInstance(node: HTMLElement): number | null;

  /** 获取 Suspense 宿主实例 ID */
  getSuspenseNodeIDForHostInstance(node: HTMLElement): number | null;

  /** 获取最近已挂载 DOM 节点 */
  getNearestMountedDOMNode(node: HTMLElement): HTMLElement | null;

  /** 获取显示名称 */
  getDisplayNameForElementID(id: number): string | null;

  /** 获取环境名称 */
  getEnvironmentNames(): string[];

  /** 获取组件名称（用于 Native） */
  getComponentNameForHostInstance?(node: HTMLElement): string | null;

  /** 设置追踪路径 */
  setTrackedPath(path: string[] | null): void;

  /** 重写错误状态 */
  overrideError(id: number, forceError: boolean): void;

  /** 重写 Suspense 状态 */
  overrideSuspense(id: number, forceFallback: boolean): void;

  /** 重写 Suspense 里程碑 */
  overrideSuspenseMilestone(suspendedSet: Set<number>): void;

  /** 按路径重写值 */
  overrideValueAtPath(type: string, id: number, hookID: number | null, path: string[], value: unknown): void;

  /** 控制台输出元素 */
  logElementToConsole(id: number): void;

  /** 存为全局变量 */
  storeAsGlobal(id: number, path: string[], count: number): void;

  /** 开始性能分析 */
  startProfiling(recordChangeDescriptions: boolean, recordTimeline: boolean): void;

  /** 停止性能分析 */
  stopProfiling(): void;

  /** 设置追踪更新开关 */
  setTraceUpdatesEnabled(enabled: boolean): void;

  /** 更新组件过滤器 */
  updateComponentFilters(filters: ComponentFilter[]): void;

  /** 刷新初始操作 */
  flushInitialOperations(): void;

  /** 获取实例和样式（React Native） */
  getInstanceAndStyle(id: number): { instance: unknown; style: unknown } | null;

  /** 是否有元素 */
  hasElementWithId(id: number): boolean;

  /** 清理 */
  cleanup(): void;

  /** 是否支持切换 Suspense */
  supportsTogglingSuspense?: boolean;
}

// ============================================================
// 4. 渲染器后端注册
// ============================================================

/** 渲染器后端入口（在 backendManager.js 中注册） */
export interface RendererBackend {
  /** Agent 构造函数 */
  Agent: new (bridge: Bridge, isProfiling: boolean, onReloadAndProfile?: (a: boolean, b: boolean) => void) => Agent;
  /** Bridge 构造函数 */
  Bridge: new (opts: BridgeOptions) => Bridge;
  /** 初始化后端函数 */
  initBackend: (hook: ReactDevToolsGlobalHook, agent: Agent, window: Window, supportsReloadAndProfile: boolean) => () => void;
  /** 设置 Native 样式编辑器（React Native 专用） */
  setupNativeStyleEditor?: (
    bridge: Bridge,
    agent: Agent,
    resolveStyle: (style: unknown) => Record<string, string | number>,
    validAttributes: Record<string, unknown>
  ) => void;
}

// ============================================================
// 5. Bridge 通信层
// ============================================================

/** Bridge 构造函数参数 */
export interface BridgeOptions {
  listen(fn: (callback: (data: unknown) => void) => void): () => void;
  send(event: string, payload: unknown, transferable?: unknown[]): void;
}

/** Bridge 实例 — devtools 前端 ↔ 后端之间的消息通道 */
export interface Bridge {
  /** 发送消息 */
  send(event: string, ...payload: unknown[]): void;

  /** 监听消息 */
  addListener(event: string, listener: (...args: unknown[]) => void): void;

  /** 移除监听 */
  removeListener(event: string, listener: (...args: unknown[]) => void): void;

  /** 移除所有监听 */
  removeAllListeners(): void;

  /** 关闭 Bridge */
  shutdown(): void;
}

// ============================================================
// 6. Agent 类
// ============================================================

/** Agent 实例 — 后端核心，管理所有渲染器接口 */
export interface Agent {
  /** 添加事件监听器 */
  addListener(event: string, listener: (...args: unknown[]) => void): void;

  /** 触发事件 */
  emit(event: string, ...args: unknown[]): void;

  /** 移除所有监听器 */
  removeAllListeners(): void;

  /** 获取渲染器接口映射 */
  readonly rendererInterfaces: Record<number, RendererInterface>;

  /** 注册渲染器接口 */
  registerRendererInterface(rendererID: number, rendererInterface: RendererInterface): void;

  /** 获取宿主实例的组件 ID */
  getIDForHostInstance(node: HTMLElement, suspense?: boolean): { id: number; rendererID: number } | null;

  /** 获取宿主实例的组件名称 */
  getComponentNameForHostInstance(node: HTMLElement): string | null;

  /** 选择 DOM 节点 */
  selectNode(node: HTMLElement): void;

  /** 获取实例和样式 */
  getInstanceAndStyle(args: { id: number; rendererID: number }): { instance: unknown; style: unknown } | null;
}

// ============================================================
// 7. 受检查元素
// ============================================================

/** inspectElement 的返回类型 */
export type InspectedElementResult =
  | { type: "full-data"; value: InspectedElement }
  | { type: "hydrated-path"; path: (string | number)[]; value: InspectedElement | null }
  | { type: "no-change" }
  | { type: "not-found" }
  | { type: "error"; message: string };

/** 被检查的 React 元素完整信息 */
export interface InspectedElement {
  id: number;
  type: string;
  isErrored: boolean;
  errors: ErrorWarning[];
  warnings: ErrorWarning[];
  suspendedBy: SuspendedByData;
  suspendedByRange: [number, number] | null;
  unknownSuspenders: number;
  rootType: string | null;
  plugins: { stylex: unknown };
  nativeTag: unknown | null;
  env: string | null;
  source: SourceLocation | null;
  stack: string | null;
  rendererPackageName: string | null;
  rendererVersion: string | null;
  key: string | null;
  canEditFunctionProps: boolean;
  canEditHooks: boolean;
  canEditFunctionPropsDeletePaths: boolean;
  canEditFunctionPropsRenamePaths: boolean;
  canEditHooksAndDeletePaths: boolean;
  canEditHooksAndRenamePaths: boolean;
  canToggleError: boolean;
  canToggleSuspense: boolean;
  isSuspended: boolean;
  hasLegacyContext: boolean;
  context: unknown | null;
  hooks: unknown | null;
  props: unknown | null;
  state: unknown | null;
  owners: Owner[] | null;
}

/** 错误/警告条目 */
export interface ErrorWarning {
  message: string;
  stack: string;
  // ... 其他错误属性
}

/** 被挂起数据 */
export interface SuspendedByData {
  cleaned: [number, ...unknown[]][];
  data: unknown[];
  unserializable: [number, ...unknown[]][];
}

// ============================================================
// 8. 所有者与源位置
// ============================================================

/** 组件所有者 */
export interface Owner {
  id: number;
  displayName: string;
  hocDisplayNames: string[] | null;
  type: string;
}

/** 源文件位置 */
export interface SourceLocation {
  fileName: string;
  lineNumber: number;
  columnNumber: number;
}

// ============================================================
// 9. 追踪路径匹配
// ============================================================

/** 追踪路径匹配结果 */
export interface TrackedPathMatch {
  id: number;
  isFullMatch: boolean;
}

// ============================================================
// 10. 矩形与布局
// ============================================================

/** DOM 矩形 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  top?: number;
  left?: number;
  bottom?: number;
  right?: number;
}

/** DOM 元素尺寸 */
export interface ElementDimensions {
  borderLeft: number;
  borderRight: number;
  borderTop: number;
  borderBottom: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
  paddingBottom: number;
}

// ============================================================
// 11. 性能分析
// ============================================================

/** 性能分析数据 */
export interface ProfilingData {
  // 实现由各个渲染器后端提供
  [key: string]: unknown;
}

// ============================================================
// 12. 组件过滤器
// ============================================================

/** 组件过滤器 */
export interface ComponentFilter {
  type: "name" | "regex" | "hoc" | "type" | "env";
  value: string;
  isEnabled: boolean;
  isValid: boolean;
}

// ============================================================
// 13. Bridge 协议
// ============================================================

/** Bridge 协议版本 */
export interface BridgeProtocol {
  version: number;
  minNpmVersion: string | null;
  maxNpmVersion: string | null;
}

/** 当前协议版本（最新） */
export const CURRENT_BRIDGE_PROTOCOL: BridgeProtocol = {
  version: 2,
  minNpmVersion: "4.22.0",
  maxNpmVersion: null,
};

// ============================================================
// 14. 消息类型枚举
// ============================================================

/** 消息来源标识 */
export type MessageSource =
  | "devtools-page"
  | "react-devtools-background"
  | "react-devtools-fetch-resource-content-script"
  | "react-devtools-backend-manager"
  | "react-devtools-hook"
  | "react-devtools-content-script"
  | "react-devtools-bridge"
  | "react-devtools-hook-installer"
  | "react-devtools-hook-settings-injector";

/** Extension 图标状态 */
export type IconStatus =
  | "development"
  | "production"
  | "disabled"
  | "restricted"
  | "outdated"
  | "deadcode"
  | "unminified";

/** React 构建类型 */
export type ReactBuildType = "development" | "production" | "outdated" | "deadcode" | "unminified" | "restricted";

// ============================================================
// 15. Storage 键名
// ============================================================

/** Session Storage 键 */
export const SESSION_STORAGE_KEYS = {
  /** 记录变更描述开关 */
  RECORD_CHANGE_DESCRIPTIONS: "React::DevTools::recordChangeDescriptions",
  /** 记录时间线开关 */
  RECORD_TIMELINE: "React::DevTools::recordTimeline",
  /** 重载并分析标记 */
  RELOAD_AND_PROFILE: "React::DevTools::reloadAndProfile",
  /** 最后选择 */
  LAST_SELECTION: "React::DevTools::lastSelection",
} as const;

// ============================================================
// 16. 内容脚本注册
// ============================================================

/** 动态注册的内容脚本 */
export interface RegisteredContentScript {
  id: string;
  js: string[];
  matches: string[];
  persistAcrossSessions: boolean;
  runAt: "document_start" | "document_end" | "document_idle";
  world: chrome.scripting.ExecutionWorld;
}

/** 所有动态注册的内容脚本列表 */
export const CONTENT_SCRIPTS: RegisteredContentScript[] = [
  {
    id: "@react-devtools/proxy",
    js: ["build/proxy.js"],
    matches: ["<all_urls>"],
    persistAcrossSessions: true,
    runAt: "document_start",
    world: "ISOLATED" as chrome.scripting.ExecutionWorld,
  },
  {
    id: "@react-devtools/file-fetcher",
    js: ["build/fileFetcher.js"],
    matches: ["<all_urls>"],
    persistAcrossSessions: true,
    runAt: "document_end",
    world: "ISOLATED" as chrome.scripting.ExecutionWorld,
  },
  {
    id: "@react-devtools/hook",
    js: ["build/installHook.js"],
    matches: ["<all_urls>"],
    persistAcrossSessions: true,
    runAt: "document_start",
    world: "MAIN" as chrome.scripting.ExecutionWorld,
  },
  {
    id: "@react-devtools/hook-settings-injector",
    js: ["build/hookSettingsInjector.js"],
    matches: ["<all_urls>"],
    persistAcrossSessions: true,
    runAt: "document_start",
    world: "ISOLATED" as chrome.scripting.ExecutionWorld,
  },
];
