// ============================================================================
// React Context DevTool v4.4 — TypeScript 类型定义（从 JS 逆向推断）
// ============================================================================

// ---------------------------------------------------------------------------
// 通信协议 - 消息事件名
// ---------------------------------------------------------------------------

/** 消息事件名称枚举 */
export type MessageEventName =
  // 背景 ↔ Content Script
  | 'REACT_JS_FOUND'
  | 'GET_CONTEXT_DATA'
  | 'CONTEXT_DATA_UPDATED'
  | 'CONTEXT_DATA'
  | 'GET_SETTINGS'
  | 'START_DEVTOOL'
  | 'STOP_DEVTOOL'
  // Content Script ↔ Main Content (MAIN world)
  | 'START_DEBUGGING'
  | 'STOP_DEBUGGING'
  | 'DISPATCH_ACTION'
  | 'DISPATCH_USE_REDUCER_ACTION'
  // 重连
  | 'RECONNECT_CONTENT_MESSAGING_PORT';

/** 带 ::RESPONSE / ::RESPONSE_ERROR 后缀的完整事件名 */
export type ResponseEventName =
  `${MessageEventName}::RESPONSE` | `${MessageEventName}::RESPONSE_ERROR`;

// ---------------------------------------------------------------------------
// window.postMessage 类型标识
// ---------------------------------------------------------------------------

/** 主页面与 content script 之间的 postMessage 方向 */
export const POST_MESSAGE_TYPES = {
  CONTENT_WINDOW: 'CONTENT_WINDOW', // content script → 主页面
  CONTENT: 'CONTENT',                // 主页面 → content script
} as const;
export type PostMessageType = (typeof POST_MESSAGE_TYPES)[keyof typeof POST_MESSAGE_TYPES];

// ---------------------------------------------------------------------------
// 核心消息结构
// ---------------------------------------------------------------------------

/** 扩展内部端口消息（通过 chrome.runtime.connect 传递） */
export interface InternalMessage<T = unknown> {
  /** 目标端口标识（如 "devtool:123"、"popup"、"content:456"、"background"） */
  to: string;
  /** 源端口标识 */
  from: string;
  /** 源 Tab ID */
  fromTabId?: number | null;
  /** 发送方的 chrome.runtime.Port.sender */
  sender?: chrome.runtime.Port['sender'];
  /** 事件名 */
  eventName: MessageEventName | string;
  /** 事件负载 */
  eventData: T;
  /** 原始事件（内部转发时保留） */
  event?: InternalMessage<T>;
}

/** window.postMessage 的数据结构 */
export interface WindowMessage<T = unknown> {
  type: PostMessageType;
  eventName: string;
  eventData: T;
}

// ---------------------------------------------------------------------------
// React 检测相关
// ---------------------------------------------------------------------------

/** React Fiber 根节点（简化类型，实际为 React 内部类型） */
export interface FiberRoot {
  current: FiberNode;
  [key: string]: unknown;
}

/** React Fiber 节点（简化类型） */
export interface FiberNode {
  tag: number;
  stateNode: unknown;
  memoizedState: FiberHook | null;
  memoizedProps: Record<string, unknown>;
  pendingProps: Record<string, unknown>;
  sibling: FiberNode | null;
  child: FiberNode | null;
  return: FiberNode | null;
  type: unknown;
  _debugOwner: FiberNode | null;
  _debugHookTypes: string[] | null;
  [key: string]: unknown;
}

/** useReducer hook 的简化 Fiber 内部结构 */
export interface FiberHook {
  baseState: unknown;
  queue: FiberHookQueue | null;
  next: FiberHook | null;
  [key: string]: unknown;
}

/** useReducer queue 的简化类型 */
export interface FiberHookQueue {
  lastRenderedReducer: ((...args: unknown[]) => unknown) & {
    __reactContextDevtoolDebugId?: string;
  };
  lastRenderedState: unknown;
  dispatch: ((...args: unknown[]) => unknown) & {
    __reactContextDevtoolDebugId?: string;
  };
  __reactContextDevtoolDebugId?: string;
}

/** React DevTools global hook 的简化类型 */
export interface ReactDevToolsHook {
  renderers: Map<number, ReactRendererInfo>;
  getFiberRoots(rendererId: number): Map<number, FiberRoot>;
  onCommitFiberRoot?: (
    rendererId: number,
    root: FiberRoot,
    ...args: unknown[]
  ) => void;
}

export interface ReactRendererInfo {
  version: string;
  rendererPackageName: string;
}

/** injectedGlobalHook 发送给 background 的检测结果 */
export interface ReactFoundPayload {
  reactBuildType: 'development' | 'production' | '';
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

export type StartDebugMode = 'pageLoad' | 'extensionLoad';

export interface ExtensionSettings {
  /** 调试启动时机：页面加载即开始 / 扩展加载时（有 panel 或 popup 打开）才开始 */
  startDebugWhenV2: StartDebugMode;
  /** 是否监控 useReducer */
  debugUseReducer: boolean;
  /** 是否监控 Context */
  debugContext: boolean;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  startDebugWhenV2: 'extensionLoad',
  debugUseReducer: true,
  debugContext: true,
};

// ---------------------------------------------------------------------------
// Debug 数据（background.js 中缓存的 per-tab 状态）
// ---------------------------------------------------------------------------

/** Context 条目（一个 Context.Provider 的当前值追踪） */
export interface ContextEntry {
  oldValue: unknown;
  newValue: unknown;
}

/** Context 更新快照 */
export interface ContextSnapshot {
  /** 值是否在本次遍历中变化 */
  valueChanged: boolean;
  /** 当前值 */
  value: unknown;
  /** 展示名 */
  displayName: string;
}

/** useReducer 条目（一个 useReducer hook 的追踪信息） */
export interface UseReducerEntry {
  actions: unknown[];
  /** 标记第一个元素是否为 initialState 哨兵 */
  state: unknown[];
  /** 展示名（reducer 函数名） */
  displayName: string;
  hook?: {
    queue: {
      lastRenderedReducer: ((...args: unknown[]) => unknown) & {
        __reactContextDevtoolDebugId?: string;
      };
      lastRenderedState: unknown;
      dispatch: ((...args: unknown[]) => unknown) & {
        __reactContextDevtoolDebugId?: string;
      };
      __reactContextDevtoolDebugId?: string;
    };
  };
  valueChanged: boolean;
  useDispatch?: boolean;
}

/** 完整的 per-tab debug 数据 */
export interface TabDebugData {
  tabId: number;
  tab: {
    title?: string;
  };
  context: Record<string, ContextEntry>;
  useReducer: Record<string, UseReducerEntry>;
  reactInfo: ReactInfo | null;
  reactDevtoolPayload: ReactFoundPayload | null;
  isReactDetected: boolean;
}

/** React 信息 */
export interface ReactInfo {
  version: string;
  rendererPackageName: string;
}

// ---------------------------------------------------------------------------
// Content Script 发送的数据更新负载
// ---------------------------------------------------------------------------

/** mainContent.js 遍历 Fiber 树后发出的更新事件（CONTEXT_DATA_UPDATED） */
export interface ContextDataUpdatedPayload {
  reactInfo: ReactInfo;
  contextKeys: string[];
  useReducerKeys: string[];
  context: Record<string, {
    value: unknown;
    displayName: string;
  }>;
  useReducer: Record<string, {
    actions: unknown[];
    state: unknown[];
    displayName: string;
  }>;
}

// ---------------------------------------------------------------------------
// 端口管理
// ---------------------------------------------------------------------------

export interface PortHandlers {
  onPortConnect?: (info: {
    portName: string;
    port: chrome.runtime.Port;
    originPortName: string;
    tabId?: string;
  }) => void;
  onPortDisconnect?: (info: {
    portName: string;
    port: chrome.runtime.Port;
    originPortName: string;
    tabId?: string;
  }) => void;
}

export interface InitMessagingOptions extends PortHandlers {
  /** 保留扩展 */
}

// ---------------------------------------------------------------------------
// 消息通道抽象（sendevent / onMessage / sendMessage）
// ---------------------------------------------------------------------------

export interface MessageChannel {
  /** 注册消息监听 */
  onMessage: (
    eventName: string,
    handler: (eventData: unknown, event: InternalMessage) => void | Promise<void>
  ) => void;
  /** 发送消息（返回带超时的 Promise） */
  sendMessage: <T = unknown>(
    to: string,
    eventName: string,
    eventData?: unknown
  ) => Promise<T>;
}
