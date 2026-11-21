/**
 * Automa v1.30.01 — 从 Webpack bundle 推断的 TypeScript 类型定义
 *
 * 本文件基于对 background.bundle.js, contentScript.bundle.js, webService.bundle.js,
 * sandbox.bundle.js, execute.bundle.js 等打包文件的逆向分析，
 * 提取了核心数据模型、消息协议、存储 schema 和 API 接口类型。
 *
 * 注意：所有类型均为推断，可能与原始源码有偏差。
 */

// ============================================================================
// 存储 Schema (chrome.storage.local)
// ============================================================================

/** chrome.storage.local 顶层存储结构 */
export interface StorageSchema {
  /** 工作流集合，支持对象映射 (Record<id, Workflow>) 或数组 */
  workflows: Record<string, Workflow> | Workflow[];
  /** 团队共享工作流，嵌套结构: teamId -> workflowId -> Workflow */
  teamWorkflows?: Record<string, Record<string, Workflow>>;
  /** 用户保存的 Block 包（可复用模块） */
  savedBlocks?: SavedBlock[];
  /** Supabase 会话对象 */
  session?: SessionData | null;
  /** Google OAuth 会话令牌 */
  sessionToken?: SessionToken | null;
}

// ============================================================================
// 核心数据模型
// ============================================================================

/** 工作流定义 */
export interface Workflow {
  /** 唯一标识 (21 字符随机 ID) */
  id: string;
  /** 工作流名称 */
  name: string;
  /** 工作流图标 */
  icon?: string;
  /** 工作流描述 */
  description?: string;
  /** drawflow 节点/边数据（JSON 字符串或已解析对象） */
  drawflow: string | DrawflowData;
  /** 数据表格列定义 */
  dataColumns: DataColumn[];
  /** 历史执行日志 */
  logs?: WorkflowLog[];
  /** 全局变量 */
  variables?: Variable[];
  /** 全局表格数据 */
  table: TableRow[];
  /** 设置 */
  settings?: WorkflowSettings;
  /** 创建时间 (timestamp) */
  createdAt: number;
  /** 编辑时间 (timestamp) */
  editedAt?: number;
  /** 扩展数据 */
  extVersion?: string;
  /** 触发器块 (运行时注册) */
  triggerBlock?: TriggerBlock;
  /** 团队 ID（若为团队工作流） */
  teamId?: string;
}

/** Drawflow 绘图数据 */
export interface DrawflowData {
  /** 节点映射: nodeId -> Node */
  nodes: Record<string, DrawflowNode>;
  /** 边数组 */
  edges?: DrawflowEdge[];
  /** 画布视口 */
  viewport?: {
    x: number;
    y: number;
    zoom: number;
  };
}

/** Drawflow 节点 */
export interface DrawflowNode {
  /** 节点 ID */
  id: number;
  /** 节点名称 */
  name?: string;
  /** Block 标签 (类型标识) */
  label: string;
  /** 位置坐标 */
  pos_x: number;
  pos_y: number;
  /** 输入连接点 */
  inputs: Record<string, DrawflowConnection>;
  /** 输出连接点 */
  outputs: Record<string, DrawflowConnection>;
  /** 数据 */
  data: BlockData;
  /** HTML 模板 */
  html?: string;
}

/** Drawflow 连接点 */
export interface DrawflowConnection {
  connections: Array<{
    node: number;
    input: string;
  }>;
}

/** Drawflow 边 */
export interface DrawflowEdge {
  id: string;
  source: number;
  sourceHandle: string;
  target: number;
  targetHandle: string;
}

/** Block 数据 */
export interface BlockData {
  /** Block ID */
  id?: string;
  /** Block 描述 */
  description?: string;
  /** 超时 (ms) */
  timeout?: number;
  /** 是否禁用 */
  disabled?: boolean;
  /** Block 参数 */
  [key: string]: unknown;
}

/** 触发器 Block (workflow 入口节点) */
export interface TriggerBlock {
  id: number;
  label: string;
  data: {
    type: TriggerType;
    [key: string]: unknown;
  };
}

/** 触发器类型 */
export type TriggerType =
  | "interval"
  | "specific-day"
  | "cron-job"
  | "context-menu"
  | "visit-web"
  | "keyboard-shortcut"
  | "on-startup";

/** 数据列定义 */
export interface DataColumn {
  name: string;
  type: DataColumnType;
  defaultValue?: string;
}

export type DataColumnType =
  | "text"
  | "number"
  | "boolean"
  | "select"
  | "file"
  | "json";

/** 表格行 */
export interface TableRow {
  [column: string]: string | number | boolean | null;
}

/** 全局变量 */
export interface Variable {
  name: string;
  value: string;
}

/** 工作流设置 */
export interface WorkflowSettings {
  /** 错误时继续执行 */
  continueOnError?: boolean;
  /** 执行超时 (ms) */
  executionTimeout?: number;
  /** 是否允许并发执行 */
  allowConcurrency?: boolean;
  /** 重试次数 */
  retryCount?: number;
  /** 重试间隔 (ms) */
  retryDelay?: number;
  /** 在无痕模式下允许执行 */
  allowIncognito?: boolean;
  /** 是否异步执行 */
  async?: boolean;
  /** 执行来源限制 */
  allowedOrigins?: string[];
}

/** 工作流执行日志 */
export interface WorkflowLog {
  id: string;
  workflowId: string;
  status: "success" | "error" | "stopped";
  startedAt: number;
  endedAt?: number;
  error?: string;
  steps?: LogStep[];
}

/** 日志步骤 */
export interface LogStep {
  blockId: string;
  blockName: string;
  status: "success" | "error";
  duration: number;
  data?: unknown;
  error?: string;
}

/** 保存的 Block 包 */
export interface SavedBlock {
  id: string;
  name: string;
  description?: string;
  category?: string;
  blocks: DrawflowNode[];
  edges?: DrawflowEdge[];
  createdAt: number;
  version?: string;
}

// ============================================================================
// 会话 / 认证模型
// ============================================================================

/** Supabase 会话数据 */
export interface SessionData {
  user: {
    id: string;
    email?: string;
    user_metadata?: {
      iss?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  access_token?: string;
  refresh_token?: string;
  [key: string]: unknown;
}

/** Google OAuth 会话令牌 */
export interface SessionToken {
  access: string;
  refresh: string;
}

// ============================================================================
// 跨上下文消息协议
// ============================================================================

/** 运行时消息基类 */
export interface RuntimeMessage {
  /** 消息名称，支持前缀 "prefix--name" 格式 */
  name: string;
  /** 消息载荷 */
  data: unknown;
}

/** 浏览器 API 代理消息 */
export interface BrowserApiMessage {
  /** API 路径（dot-separated），例如 "tabs.get" */
  name: string;
  /** 序列化后的参数 */
  args: SerializedArg[];
}

/** 序列化参数（支持函数序列化） */
export type SerializedArg =
  | { __type: "function"; __value: string }
  | SerializedArg[]
  | Record<string, SerializedArg>
  | string
  | number
  | boolean
  | null;

/** 浏览器事件通知 (offscreen -> background) */
export interface BrowserEventMessage {
  name: string;
  args: unknown[];
}

/** 事件监听器开关消息 */
export interface ToggleEventListenerMessage {
  name: string;
  type: "add" | "remove";
}

/** 内容脚本注入目标 */
export interface InjectionTarget {
  tabId: number;
  allFrames?: boolean;
  frameId?: number;
}

/** 内容脚本注入选项 */
export interface InjectionOptions {
  file: string;
  target: InjectionTarget;
  injectImmediately?: boolean;
  waitUntilInjected?: {
    maxTry?: number;
    timeoutMs?: number;
    messageId?: string;
  };
}

// ============================================================================
// 核心消息类型列表
// ============================================================================

export type BackgroundMessageType =
  | "workflow:execute"
  | "workflow:stop"
  | "workflow:resume"
  | "workflow:added"
  | "workflow:register"
  | "workflow:unregister"
  | "workflow:added"
  | "open:dashboard"
  | "browser-api"
  | "browser-api:on-browser-event"
  | "browser-api:toggle-browser-event-listener"
  | "dashboard:refresh-packages"
  | "content-script-exists";

// ============================================================================
// Web Service 消息 (webService.bundle.js)
// ============================================================================

/** webService 自定义事件名称 */
export type WebServiceEventName =
  | "open-dashboard"
  | "open-workflow"
  | "add-workflow"
  | "add-team-workflow"
  | "check-team-workflow"
  | "add-package"
  | "update-package"
  | "send-message";

/** open-dashboard 事件数据 */
export interface OpenDashboardEvent {
  path?: string;
}

/** open-workflow 事件数据 */
export interface OpenWorkflowEvent {
  workflowId: string;
}

/** add-workflow 事件数据 */
export interface AddWorkflowEvent {
  workflow: Partial<Workflow>;
}

/** send-message 内部协议（webService 内） */
export interface WebServiceSendMessage {
  type: "package-installed" | "get-workflows";
  data?: unknown;
}

// ============================================================================
// Chrome Debugger API 相关类型
// ============================================================================

/** debugger 目标 */
export interface DebuggerTarget {
  tabId: number;
}

/** debugger 命令 */
export interface DebuggerCommand {
  command: string;
  params?: Record<string, unknown>;
}

/** debugger 事件 */
export interface DebuggerEvent {
  method: string;
  params: Record<string, unknown>;
  tabId: number;
}

// ============================================================================
// Proxy 设置类型
// ============================================================================

/** 代理配置 */
export interface ProxyConfig {
  mode: "direct" | "fixed_servers" | "pac_script" | "system";
  rules?: {
    singleProxy?: ProxyServer;
    bypassList?: string[];
  };
  pacScript?: {
    url?: string;
    data?: string;
    mandatory?: boolean;
  };
}

/** 代理服务器 */
export interface ProxyServer {
  scheme: "http" | "https" | "quic" | "socks5";
  host: string;
  port: number;
}

// ============================================================================
// Offscreen API 类型
// ============================================================================

/** 屏幕外文档创建原因 */
export type OffscreenReason =
  | "DOM_PARSER"
  | "BLOBS"
  | "AUDIO_PLAYBACK"
  | "WEB_RTC"
  | "CLIPBOARD"
  | "DISPLAY_MEDIA";

/** 屏幕外文档配置 */
export interface OffscreenDocumentOptions {
  url: string;
  reasons: OffscreenReason[];
  justification: string;
}

// ============================================================================
// 枚举类型
// ============================================================================

/** Block 类别 */
export enum BlockCategory {
  GENERAL = "general",
  BROWSER = "browser",
  WEB_INTERACTION = "web-interaction",
  CONDITIONS = "conditions",
  DATA = "data",
  ONLINE_SERVICES = "online-services",
  SCHEDULE = "schedule",
}

/** 内容脚本消息类型 */
export enum ContentScriptMessageType {
  CONTENT_SCRIPT_EXISTS = "content-script-exists",
  EXECUTE_BLOCK = "execute-block",
  TAKE_SCREENSHOT = "take-screenshot",
  GET_ELEMENT_INFO = "get-element-info",
  HIGHLIGHT_ELEMENT = "highlight-element",
}

/** 工作流执行状态 */
export enum WorkflowExecutionStatus {
  IDLE = "idle",
  RUNNING = "running",
  STOPPED = "stopped",
  ERROR = "error",
  COMPLETED = "completed",
}
