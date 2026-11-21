// ============================================================
// NopeCHA: CAPTCHA Solver v0.6.1 — 类型定义（dsv4 逆向推断）
// ============================================================

// ---- Chrome 扩展消息系统 ----

/** 从 Content Script / Popup 到 Service Worker 的消息格式 */
export type RuntimeMessage = [
  meta: string,           // 消息元数据标识符（含校验和）
  event: string,          // 事件名称
  ...args: unknown[]      // 可变参数
];

/** 消息事件名枚举 */
export type MessageEvent =
  // 通信
  | "broadcast::broadcastTab"
  | "broadcast"
  | "popup-stream"
  | "stream"
  // 设置
  | "settings::update"
  | "settings::get"
  // Debugger 会话
  | "debugger::beginPointerSession"
  | "debugger::endPointerSession"
  | "debugger::attach"
  | "debugger::detach"
  // CAPTCHA 交互
  | "recognition::request"
  | "recognition::response"
  | "job::update"
  | "job::query"
  | "captcha::interaction"
  // 元素定位
  | "start_locate"
  | "stop_locate"
  | "update_locate"
  // 通用
  | "log"
  | "error"
  | "status";

// ---- 设置系统 ----

/** 鼠标移动速度 */
export type MouseSpeed = "slow" | "medium" | "fast";

/** 输入方法（CAPTCHA 模拟方式） */
export type InputMethod = "auto" | "cdp" | "javascript";

/** Hook 方法（请求拦截方式） */
export type HookMethod = "auto" | "v2" | "v1";

/** 鼠标移动行为模式 */
export type MovementPattern =
  | "brisk"
  | "careful"
  | "hesitant"
  | "measured"
  | "measured-arc"
  | "broad-arc"
  | "broad-sweep"
  | "brisk-direct"
  | "careful-settle"
  | "hesitant-search";

/** 鼠标行为 Profile 键 */
export type MovementProfileKey =
  | "measured-arc"
  | "brisk-direct"
  | "careful-settle"
  | "hesitant-search"
  | "broad-sweep";

/** 各 CAPTCHA 类型的自动化设置 */
export interface CaptchaAutoSettings {
  auto_open: boolean;
  auto_solve: boolean;
  solve_delay_time: number;   // ms
  solve_delay: boolean;
}

/** 全量用户设置 */
export interface NopechaSettings {
  _version: number;
  key: string;                // API Key
  keys: string[];             // 多 Key 支持（key 含逗号时拆分）
  enabled: boolean;
  disabled_hosts: string[];
  input_method: InputMethod;
  hook_method: HookMethod;
  mouse_speed: MouseSpeed;
  mouse_visualization: boolean;

  // 各 CAPTCHA 自动化开关
  awscaptcha_auto_open: boolean;
  awscaptcha_auto_solve: boolean;
  awscaptcha_solve_delay_time: number;
  awscaptcha_solve_delay: boolean;

  geetest_auto_open: boolean;
  geetest_auto_solve: boolean;
  geetest_solve_delay_time: number;
  geetest_solve_delay: boolean;

  funcaptcha_auto_open: boolean;
  funcaptcha_auto_solve: boolean;
  funcaptcha_solve_delay_time: number;
  funcaptcha_solve_delay: boolean;

  hcaptcha_auto_open: boolean;
  hcaptcha_auto_solve: boolean;
  hcaptcha_solve_delay_time: number;
  hcaptcha_solve_delay: boolean;

  lemincaptcha_auto_open: boolean;
  lemincaptcha_auto_solve: boolean;
  lemincaptcha_solve_delay_time: number;
  lemincaptcha_solve_delay: boolean;

  perimeterx_auto_solve: boolean;
  perimeterx_solve_delay_time: number;
  perimeterx_solve_delay: boolean;

  recaptcha_auto_open: boolean;
  recaptcha_auto_solve: boolean;
  recaptcha_solve_delay_time: number;
  recaptcha_solve_delay: boolean;

  textcaptcha_auto_solve: boolean;
  textcaptcha_image_selector: string;
  textcaptcha_input_selector: string;
  textcaptcha_math_expression: boolean;
  textcaptcha_solve_delay_time: number;
  textcaptcha_solve_delay: boolean;

  turnstile_auto_solve: boolean;
  turnstile_solve_delay_time: number;
  turnstile_solve_delay: boolean;
}

/** chrome.storage.local 中的存储结构 */
export interface StorageData {
  settings: NopechaSettings;
  "observability:last-sent-at": number;
  "observability:next-send-after": number;
}

// ---- API 通信 ----

/** API 端点配置 */
export interface ApiEndpoints {
  base: "https://api.nopecha.com";
  status: "/v1/status";
  recognition: "/v1/recognition";
  observability: "/v1/observability";
}

/** API 错误码 */
export const enum ApiErrorCode {
  InvalidKey = 1,
  MissingKey = 2,
  NoCredit = 3,
  UpdateRequired = 4,
  InternalError = 5,
}

/** API 错误响应 */
export interface ApiErrorResponse {
  error: ApiErrorCode;
  message: string;
  source?: "client" | "server";
}

/** API 状态响应 */
export interface ApiStatusResponse {
  plan?: string;
  status?: string;
  credit?: number;
  quota?: number;
  error?: ApiErrorCode;
  message?: string;
}

/** API 识别请求（发给 /v1/recognition） */
export interface RecognitionRequest {
  type: string;              // CAPTCHA 类型标识
  image?: string;            // Base64 图片数据
  question?: string;         // 文本题目
  sitekey?: string;
  [key: string]: unknown;
}

/** API 识别响应 */
export interface RecognitionResponse {
  data?: string;             // 识别结果（token / answer）
  error?: string;
  job_id?: string;
}

/** 可观测性上报数据 */
export interface ObservabilityPayload {
  type: string;
  metadata?: Record<string, unknown>;
  observability: Record<string, unknown>;
}

// ---- CAPTCHA 类型 ----

/** 支持的 CAPTCHA 提供商 */
export type CaptchaProvider =
  | "hcaptcha"
  | "recaptcha"
  | "funcaptcha"
  | "turnstile"
  | "awscaptcha"
  | "geetest"
  | "lemincaptcha"
  | "perimeterx"
  | "textcaptcha";

/** CAPTCHA Job 阶段 */
export type JobPhase =
  | "detecting"
  | "submitting"
  | "queued"
  | "solving"
  | "applying"
  | "completed"
  | "stale"
  | "error";

/** CAPTCHA Job 结果 */
export type ProviderResult = "success" | "incorrect" | "error" | "timeout";

/** CAPTCHA Job 状态（运行中追踪） */
export interface CaptchaJob {
  id: string;
  tabId: number;
  provider: CaptchaProvider;
  phase: JobPhase;
  startedAt: number;
  lastUpdatedAt: number;
  completedAt?: number;
  durationMs?: number;
  message?: string;
  providerResult?: ProviderResult;
  interaction?: CaptchaInteraction;
  sitekey?: string;
  host?: string;
}

/** CAPTCHA 交互记录（Debugger 请求/响应追踪） */
export interface CaptchaInteraction {
  message?: string;
  at: number;
  jobId?: string;
  postreq?: HttpRequestLog;
  getreq?: HttpRequestLog;
  postres?: HttpResponseLog[];
  getres?: HttpResponseLog[];
  answer?: string;
}

/** HTTP 请求日志 */
export interface HttpRequestLog {
  time: number;
  url: string;
  options: {
    method: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
}

/** HTTP 响应日志 */
export interface HttpResponseLog {
  time: number;
  responseBody?: unknown;
  status?: number;
}

// ---- CDP / Debugger 类型 ----

/** CDP 鼠标事件类型 */
export type CdpMouseEventType =
  | "mouseMoved"
  | "mousePressed"
  | "mouseReleased";

/** 鼠标按钮映射 */
export interface MouseButtonMap {
  left: 1;
  middle: 2;
  right: 4;
  none: 0;
}

/** CDP Input.dispatchMouseEvent 参数 */
export interface CdpMouseEvent {
  type: CdpMouseEventType;
  x: number;
  y: number;
  button: "left" | "middle" | "right" | "none";
  buttons: number;
  clickCount: number;
  modifiers?: number;
  timestamp?: number;
}

/** 移动路径配置 */
export interface MovementProfile {
  key: MovementProfileKey;
  movementPattern: MovementPattern;
  targetAcquireDelayMs: MinMax;
  clickHoldDelayMs: MinMax;
  postActionDelayMs: MinMax;
  moveDelayMinMs: MinMax;
  moveDelayMaxMs: MinMax;
  moveDelayJitterRatio: MinMax;
  eventDelayMinMs: MinMax;
  eventDelayMaxMs: MinMax;
  preActionDelayMinMs: MinMax;
  preActionDelayMaxMs: MinMax;
  pixelsPerStep: MinMax;
  maxSteps: MinMax;
  settleSteps: MinMax;
  settleRadiusPx: MinMax;
  microAdjustmentPx: MinMax;
  curveBendRatio: MinMax;
  pathVarianceRatio: MinMax;
  speedPeakSharpness: MinMax;
  tremorAmplitudePx: MinMax;
  tremorFrequency: MinMax;
  pauseChance: MinMax;
  pauseMinMs: MinMax;
  pauseMaxMs: MinMax;
  endpointOvershootRatio: MinMax;
}

/** 路径点 */
export interface Waypoint {
  x: number;
  y: number;
  progress: number;
  delayMs: number;
}

// ---- 鼠标模拟（Human-Like） ----

/** 当前指针会话 */
export interface PointerSession {
  id: string;
  seed: number;
  profileIndex: number;
  profileKey: MovementProfileKey;
  movementPattern: MovementPattern;
  targetAcquireDelayMs: number;
  clickHoldDelayMs: number;
  postActionDelayMs: number;
  moveDelayMinMs: number;
  moveDelayMaxMs: number;
  moveDelayJitterRatio: number;
  eventDelayMinMs: number;
  eventDelayMaxMs: number;
  preActionDelayMinMs: number;
  preActionDelayMaxMs: number;
  pixelsPerStep: number;
  maxSteps: number;
  settleSteps: number;
  settleRadiusPx: number;
  microAdjustmentPx: number;
  curveBendRatio: number;
  curveSide: -1 | 1;
  pathVarianceRatio: number;
  speedPeakSharpness: number;
  tremorAmplitudePx: number;
  tremorFrequency: number;
  pauseChance: number;
  pauseMinMs: number;
  pauseMaxMs: number;
  endpointOvershootRatio: number;
}

// ---- 元素定位（CSS Selector 生成） ----

/** 元素定位请求 */
export interface LocateAction {
  action: "start_locate" | "stop_locate" | "update_locate";
  locate?: "textcaptcha_image_selector" | "textcaptcha_input_selector";
  windowId?: string;
  cssSelector?: string;
}

// ---- Broadcast 消息 ----

/** Broadcast 通道消息 */
export interface BroadcastMessage {
  event: "broadcast";
  data: LocateAction | Record<string, unknown>;
}

// ---- 可观测性系统 ----

/** 可观测性调度状态 */
export interface ObservabilitySchedulerState {
  state: "unscheduled" | "cooldown" | "delayed" | "ready";
  now: number;
  intervalMs: number;
  initialDelayMinMs: number;
  initialDelayMaxMs: number;
  lastSentAt?: number;
  cooldownEndsAt?: number;
  nextSendAfter?: number;
  nextSendAt?: number;
  timeUntilNextSendMs?: number;
}

/** 可观测性采集决策 */
export type CollectDecision =
  | { collect: true; reason: "ready"; status: ObservabilitySchedulerState }
  | { collect: false; reason: "in_flight" | "cooldown" | "scheduled" | "delayed"; status: ObservabilitySchedulerState };

// ---- DNR（Declarative Net Request）规则 ----

/** DNR 规则定义 */
export interface DnrRedirectRule {
  id: number;
  priority: number;
  action: {
    type: "redirect";
    redirect: {
      transform?: {
        queryTransform?: {
          addOrReplaceParams: Array<{
            key: string;
            value: string;
            replaceOnly: boolean;
          }>;
        };
      };
      regexSubstitution?: string;
    };
  };
  condition: {
    regexFilter: string;
    resourceTypes: string[];
  };
}

// ---- UI 状态 ----

/** Badge 颜色 */
export interface BadgeColor {
  red: string;    // #fc2e2e
  yellow: string; // #fcd62e
  blue: string;   // #0a95ff
}

/** Badge 显示状态 */
export interface BadgeState {
  text: string;
  color: string;
}

/** Popup 页面状态枚举 */
export type PopupPage =
  | "main"
  | "settings"
  | "debug"
  | "logs"
  | "captcha-status"
  | "loading";

/** Nav icon 定义 */
export interface NavIcon {
  name: string;
  label: string;
  svg: string;
  page: PopupPage;
}

// ---- 解密辅助类型 ----

/** XHR 拦截上下文（用于 hCaptcha getcaptcha 响应解密） */
export interface XhrHookContext {
  source: "3149371273";
  payload: {
    k: "xhr" | "settings";
    url: string;
    body: string;
    timestamp: number;
  };
}

/** hCaptcha 响应解密结果 */
export interface HCaptchaDecryptedResponse {
  request_type?: string;
  key?: string;
  [key: string]: unknown;
}

/** reCAPTCHA token 缓存条目 */
export interface RecaptchaTokenCache {
  token: string;
  sitekey: string;
  timestamp: number;
  ttl: number;
}

// ---- 通用工具类型 ----

export interface MinMax {
  min: number;
  max: number;
}

export interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
  padding?: number;
}

export interface Point {
  x: number;
  y: number;
}
