// ============================================================================
// Redux DevTools v3.2.10 — TypeScript 类型定义
// 从 webpack-bundled JS 代码中推断，基于变量使用模式和 API 调用
// ============================================================================

// ---------------------------------------------------------------------------
// Chrome Extension API 类型扩展
// ---------------------------------------------------------------------------

/** 扩展存储的选项配置 */
export interface DevToolsOptions {
  /** 是否启用编辑器集成: 0=禁用, 1=VSCode, 2=Atom, 3=WebStorm */
  useEditor?: number;
  /** 编辑器路径 */
  editor?: string;
  /** 项目路径 */
  projectPath?: string;
  /** 保留的最大 action 数 (默认50) */
  maxAge?: number | (() => number);
  /** 过滤模式 */
  filter?: FilterMode;
  /** 允许列表 (每行一个正则) */
  allowlist?: string;
  /** 拦截列表 (每行一个正则) */
  denylist?: string;
  /** (已废弃) 原名 allowlist */
  whitelist?: string;
  /** (已废弃) 原名 denylist */
  blacklist?: string;
  /** 是否捕获错误 */
  shouldCatchErrors?: boolean;
  /** 是否自动注入 (默认true) */
  inject?: boolean;
  /** URL过滤模式 (正则字符串, 每行一个) */
  urls?: string;
  /** 是否显示右键菜单 (默认true) */
  showContextMenus?: boolean;
  /** 是否记录 action 调用栈 */
  trace?: boolean | (() => string);
  /** 调用栈最大行数 (默认10) */
  traceLimit?: number;
  /** 是否允许热重载 */
  shouldHotReload?: boolean;
  /** 是否记录变更 (默认true) */
  shouldRecordChanges?: boolean;
  /** 初始是否锁定 */
  shouldStartLocked?: boolean;
  /** 暂停时注入的 action type */
  pauseActionType?: string;
  /** 序列化配置 */
  serialize?: SerializeConfig | boolean;
  /** 状态清洗函数 */
  stateSanitizer?: (state: unknown, index: number) => unknown;
  /** action 清洗函数 */
  actionSanitizer?: (action: unknown, id: number) => unknown;
  /** 自定义 action 类型获取 */
  getActionType?: (action: unknown) => unknown;
  /** 功能开关 */
  features?: DevToolsFeatures;
  /** 实例名称 */
  name?: string;
  /** 连接类型 (默认"redux") */
  type?: string;
  /** action 构造器 */
  actionCreators?: Record<string, unknown> | unknown[];
  /** 延迟批量上报 (ms, 默认500) */
  latency?: number;
  /** 谓词过滤 */
  predicate?: (state: unknown, action: unknown) => boolean;
  /** 自动暂停 */
  autoPause?: boolean;
}

/** 过滤模式枚举 */
export type FilterMode =
  | 'DO_NOT_FILTER'
  | 'DENYLIST_SPECIFIC'
  | 'ALLOWLIST_SPECIFIC';

/** 功能开关 */
export interface DevToolsFeatures {
  /** 是否允许 dispatch */
  dispatch?: boolean;
  /** 是否允许跳转 */
  jump?: boolean;
  /** 是否允许 skip/toggle */
  skip?: boolean;
  /** 是否允许重排 */
  reorder?: boolean;
  /** 是否允许导入 */
  import?: boolean;
  /** 是否允许锁定 */
  lock?: boolean;
  /** 是否允许暂停 */
  pause?: boolean;
}

/** 序列化配置 */
export interface SerializeConfig {
  /** Immutable.js 实例 */
  immutable?: unknown;
  /** 引用路径 */
  refs?: unknown[];
  /** 自定义 replacer */
  replacer?: (key: string, value: unknown) => unknown;
  /** 自定义 reviver */
  reviver?: (key: string, value: unknown) => unknown;
  /** jsan 选项 */
  options?: JSANOptions | boolean;
}

/** jsan 序列化选项 */
export interface JSANOptions {
  date?: boolean;
  function?: boolean;
  regex?: boolean;
  undefined?: boolean;
  error?: boolean;
  symbol?: boolean;
  map?: boolean;
  set?: boolean;
  nan?: boolean;
  infinity?: boolean;
  circular?: boolean | ((obj: unknown, path: string, ref: string) => unknown);
  refs?: boolean;
}

// ---------------------------------------------------------------------------
// Redux Store 内部类型
// ---------------------------------------------------------------------------

/** Lifted Store 的 action 枚举 */
export const ActionTypes = {
  PERFORM_ACTION: 'PERFORM_ACTION',
  RESET: 'RESET',
  ROLLBACK: 'ROLLBACK',
  COMMIT: 'COMMIT',
  SWEEP: 'SWEEP',
  TOGGLE_ACTION: 'TOGGLE_ACTION',
  SET_ACTIONS_ACTIVE: 'SET_ACTIONS_ACTIVE',
  JUMP_TO_STATE: 'JUMP_TO_STATE',
  JUMP_TO_ACTION: 'JUMP_TO_ACTION',
  REORDER_ACTION: 'REORDER_ACTION',
  IMPORT_STATE: 'IMPORT_STATE',
  LOCK_CHANGES: 'LOCK_CHANGES',
  PAUSE_RECORDING: 'PAUSE_RECORDING',
} as const;

export type ActionType = (typeof ActionTypes)[keyof typeof ActionTypes];

/** 包装后的 Action (含时间戳和调用栈) */
export interface PerformAction<T = unknown> {
  type: typeof ActionTypes.PERFORM_ACTION;
  action: T;
  timestamp: number;
  stack?: string;
}

/** action 记录条目 */
export interface ActionEntry<T = unknown> {
  action: T;
  timestamp: number;
  stack?: string;
}

/** 计算状态条目 */
export interface ComputedState<S = unknown> {
  state: S;
  error?: string;
}

/** Lifted Store 完整状态 */
export interface LiftedState<S = unknown, A = unknown> {
  monitorState: unknown;
  actionsById: Record<number, ActionEntry<A>>;
  nextActionId: number;
  stagedActionIds: number[];
  skippedActionIds: number[];
  committedState: S;
  currentStateIndex: number;
  computedStates: ComputedState<S>[];
  isLocked: boolean;
  isPaused: boolean;
}

/** Lifted Store 增强器选项 */
export interface InstrumentOptions {
  maxAge?: number | (() => number);
  trace?: boolean | (() => string);
  traceLimit?: number;
  shouldCatchErrors?: boolean;
  shouldHotReload?: boolean;
  shouldRecordChanges?: boolean;
  shouldStartLocked?: boolean;
  pauseActionType?: string;
}

// ---------------------------------------------------------------------------
// 消息通信类型
// ---------------------------------------------------------------------------

/** 消息来源标识 */
export const MessageSources = {
  DEVTOOLS_EXTENSION: '@devtools-extension',
  DEVTOOLS_PAGE: '@devtools-page',
} as const;

export type MessageSource = (typeof MessageSources)[keyof typeof MessageSources];

/** 消息方向类型 */
export type MessageType =
  | 'INIT_INSTANCE'
  | 'DISPATCH'
  | 'ACTION'
  | 'STATE'
  | 'PARTIAL_STATE'
  | 'LIFTED'
  | 'EXPORT'
  | 'IMPORT'
  | 'START'
  | 'STOP'
  | 'UPDATE'
  | 'ERROR'
  | 'OPEN'
  | 'INIT'
  | 'DISCONNECT'
  | 'OPTIONS'
  | 'GET_REPORT'
  | 'RELAY';

/** 跨上下文通信消息基类 */
export interface DevToolsMessageBase {
  source: MessageSource;
  type: MessageType;
  instanceId?: number;
  id?: number;
  name?: string;
}

/** INIT_INSTANCE 消息 */
export interface InitInstanceMessage extends DevToolsMessageBase {
  type: 'INIT_INSTANCE';
  instanceId: number;
}

/** DISPATCH 消息 */
export interface DispatchMessage<T = unknown> extends DevToolsMessageBase {
  type: 'DISPATCH';
  payload: PerformAction<T> | T;
  state?: string; // JSON serialized
}

/** ACTION 消息 */
export interface ActionMessage<T = unknown, S = unknown> extends DevToolsMessageBase {
  type: 'ACTION';
  action: PerformAction<T> | T;
  payload: string; // JSON serialized state
  maxAge?: number;
  name?: string;
}

/** STATE 消息 */
export interface StateMessage extends DevToolsMessageBase {
  type: 'STATE';
  action: string; // JSON serialized
  payload: string; // JSON serialized
  maxAge?: number;
  libConfig?: LibConfig;
}

/** PARTIAL_STATE 消息 */
export interface PartialStateMessage extends DevToolsMessageBase {
  type: 'PARTIAL_STATE';
  payload: string; // JSON serialized
  maxAge?: number;
}

/** EXPORT 消息 */
export interface ExportMessage extends DevToolsMessageBase {
  type: 'EXPORT';
  payload: string; // JSON serialized actions array
  committedState?: string;
}

/** IMPORT 消息 */
export interface ImportMessage extends DevToolsMessageBase {
  type: 'IMPORT';
  state: string; // JSON serialized
}

/** STOP 消息 */
export interface StopMessage extends DevToolsMessageBase {
  type: 'STOP';
  failed?: boolean;
}

/** ERROR 消息 */
export interface ErrorMessage extends DevToolsMessageBase {
  type: 'ERROR';
  payload: string; // error message
}

/** OPTIONS 消息 */
export interface OptionsMessage extends DevToolsMessageBase {
  type: 'OPTIONS';
  options: DevToolsOptions;
}

/** LibConfig (初始化时发送) */
export interface LibConfig {
  name?: string;
  actionCreators?: string; // JSON string
  features?: DevToolsFeatures;
  serialize?: boolean;
  type?: string;
}

export type DevToolsMessage<T = unknown, S = unknown> =
  | InitInstanceMessage
  | DispatchMessage<T>
  | ActionMessage<T, S>
  | StateMessage
  | PartialStateMessage
  | ExportMessage
  | ImportMessage
  | StopMessage
  | ErrorMessage
  | OptionsMessage
  | (DevToolsMessageBase & { type: string; [key: string]: unknown });

// ---------------------------------------------------------------------------
// 消息拆分 (大消息处理)
// ---------------------------------------------------------------------------

export const MAX_MESSAGE_SIZE = 32 * 1024 * 1024; // 32MB

export type SplitType = 'start' | 'chunk' | 'end';

export interface SplitMessage {
  source: typeof MessageSources.DEVTOOLS_PAGE;
  instanceId: number;
  split: SplitType;
  chunk?: [string, string]; // [key, value]
}

// ---------------------------------------------------------------------------
// Connection API
// ---------------------------------------------------------------------------

/** connect() 返回的 Store API (兼容 Redux Store) */
export interface DevToolsConnectReturn<S = unknown, A = unknown> {
  /** 发送 action */
  dispatch(action: A): A;
  /** 订阅状态变化 */
  subscribe(listener: () => void): () => void;
  /** 获取当前状态 */
  getState(): S | undefined;
  /** 替换 reducer */
  replaceReducer(nextReducer: (state: S | undefined, action: A) => S): void;
  /** 初始化 */
  init(state: S, liftedState?: LiftedState<S, A>): void;
  /** 错误上报 */
  error(message: string): void;
  /** 发送消息 */
  send(action: A | string, state: S): void;
  /** 获取 lifted store */
  liftedStore: {
    getState(): LiftedState<S, A>;
    dispatch(action: unknown): unknown;
    subscribe(listener: () => void): () => void;
    replaceReducer(nextReducer: unknown): void;
    initialDispatch?: (action: unknown) => unknown;
  };
  /** 取消订阅 */
  unsubscribe(): void;
  [Symbol.observable]?(): {
    subscribe(observer: { next?: (state: S) => void }): {
      unsubscribe(): void;
    };
    [Symbol.observable](): unknown;
  };
}

/** 窗口上的 Redux DevTools 扩展 API */
export interface ReduxDevToolsExtension {
  /** 连接 DevTools */
  (options?: DevToolsOptions): <R extends (...args: unknown[]) => unknown>(...args: Parameters<R>) => ReturnType<R>;
  /** 打开 DevTools 窗口 */
  open(position?: string): void;
  /** 配置错误通知 */
  notifyErrors(onError?: (() => boolean) | undefined): void;
  /** 手动发送 action/state */
  send(
    action: unknown,
    state: unknown,
    options?: DevToolsOptions,
    instanceId?: number | string,
    name?: string
  ): void;
  /** 监听 DevTools 消息 */
  listen(
    callback: (message: DevToolsMessage) => void,
    instanceId: number | string
  ): void;
  /** 独立连接 (不通过 Redux store) */
  connect(options?: DevToolsOptions): DevToolsConnectReturn;
  /** 断开连接 */
  disconnect(): void;
}

/** compose 函数类型 */
export type ReduxDevToolsExtensionCompose = <R>(
  ...funcs: ((...args: unknown[]) => unknown)[]
) => (...args: unknown[]) => R;

// ---------------------------------------------------------------------------
// 全局扩展
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    /** Redux DevTools 扩展 API (注入到页面 MAIN world) */
    __REDUX_DEVTOOLS_EXTENSION__?: ReduxDevToolsExtension;
    /** Redux DevTools compose 增强器 */
    __REDUX_DEVTOOLS_EXTENSION_COMPOSE__?: ReduxDevToolsExtensionCompose;
    /** DevTools 连接 ID */
    devToolsExtensionID?: string;
    /** DevTools 选项 (运行时覆盖) */
    devToolsOptions?: DevToolsOptions;
    /** 是否捕获错误 */
    shouldCatchErrors?: boolean;
    /** 全局锁定标记 */
    __REDUX_DEVTOOLS_EXTENSION_LOCKED__?: boolean;
  }
}

// ---------------------------------------------------------------------------
// Options 页面特定类型
// ---------------------------------------------------------------------------

/** 编辑器枚举 */
export const EditorType = {
  NONE: 0,
  VSCODE: 1,
  ATOM: 2,
  WEBSTORM: 3,
} as const;

/** 窗口位置类型 */
export type WindowPosition = 'window' | 'panel' | 'remote' | 'popup';
