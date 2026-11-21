// ============================================================================
// crxMouse Chrome Gestures v7.0.5 — Reverse-Engineered Type Definitions
// ============================================================================

// ---------------------------------------------------------------------------
// 手势动作 (Gesture Actions) — the central action dispatched on completion
// ---------------------------------------------------------------------------

/** 鼠标手势动作类别 */
export type GestureActionCategory =
  | 'tab'          // 标签页操作 (新建/关闭/切换/复制/移动/固定)
  | 'navigation'   // 导航 (前进/后退/刷新/停止/上一页/下一页)
  | 'scroll'       // 滚动 (上/下/左/右/顶部/底部)
  | 'window'       // 窗口操作 (新建/最大化/最小化/关闭)
  | 'clipboard'    // 剪贴板 (复制 URL/标题/链接/图片/文本)
  | 'search'       // 搜索 (Google/Bing/Baidu/DuckDuckGo/Yandex/Yahoo/自定义)
  | 'bookmark'     // 书签 (添加/管理)
  | 'chrome'       // Chrome 内部页面 (设置/下载/历史/扩展/Flags)
  | 'script'       // 用户脚本 (Run Script)
  | 'link'         // 链接操作 (打开/复制/保存)
  | 'image'        // 图片操作 (打开/复制 URL/保存/搜索)
  | 'text'         // 文本操作 (复制/搜索)
  | 'screenshot'   // 截图 (Capture)
  | 'system'       // 系统级 (全屏/隐私窗口)
  | 'none';        // 空动作/取消

/** 单个手势动作定义 */
export interface GestureAction {
  /** 动作内部标识符 (e.g., "G_back", "L_open", "I_search") */
  id: string;
  /** 动作显示名称 (i18n key: "G_back" -> "Back") */
  name: string;
  /** 动作分类 */
  category: GestureActionCategory;
  /** 动作图标 (CSS class or SVG path) */
  icon?: string;
  /** 是否为内置动作 (vs 用户自定义) */
  builtin: boolean;
  /** 额外参数 (URL、搜索引擎、脚本内容等) */
  params?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// 鼠标轨迹 (Mouse Trail)
// ---------------------------------------------------------------------------

/** 单段轨迹方向 */
export type TrailDirection =
  | 'U'   // 上 (Up)
  | 'D'   // 下 (Down)
  | 'L'   // 左 (Left)
  | 'R'   // 右 (Right)
  | 'UR'  // 右上
  | 'UL'  // 左上
  | 'DR'  // 右下
  | 'DL'  // 左下;

/** 鼠标轨迹点 */
export interface TrailPoint {
  x: number;
  y: number;
  timestamp: number;
}

/** 完整的鼠标手势轨迹 */
export interface MouseTrail {
  /** 起始点 */
  startPoint: TrailPoint;
  /** 轨迹点序列 */
  points: TrailPoint[];
  /** 解析后的方向序列 (e.g. ["D", "R"]) */
  directions: TrailDirection[];
  /** 原始手势字符串 (e.g. "DR") */
  gestureString: string;
}

// ---------------------------------------------------------------------------
// 手势配置 (Gesture Config)
// ---------------------------------------------------------------------------

/** 手势激活键 */
export type GestureActivationButton = 'right' | 'left' | 'middle';

/** 手势停用修饰键 */
export type GestureDeactivationKey = 'none' | 'ctrl' | 'alt' | 'shift';

/** 手势显示位置 (九宫格) */
export type GesturePosition =
  | 'TL' | 'TC' | 'TR'
  | 'CL' | 'CC' | 'CR'
  | 'BL' | 'BC' | 'BR';

/** 单个手势规则配置 */
export interface GestureRule {
  /** 手势唯一 ID */
  id: string;
  /** 手势字符串 (e.g. "DR" = 下+右) */
  gesture: string;
  /** 对应的动作 ID */
  actionId: string;
  /** 可选的动作标签 (覆盖动作默认名称) */
  label?: string;
  /** 作用域: 全局或指定域名列表 */
  scope: 'global' | string[];
  /** 是否为内置热门手势 */
  popular?: boolean;
  /** 创建时间戳 */
  createdAt?: number;
}

/** 鼠标手势配置 (全局) */
export interface GestureConfig {
  /** 是否启用鼠标手势 */
  enabled: boolean;
  /** 激活键 */
  activationButton: GestureActivationButton;
  /** 停用修饰键 */
  deactivationKey: GestureDeactivationKey;
  /** 默认启用 (ON by default) */
  onByDefault: boolean;
  /** 最小轨迹长度 (px) */
  minTrackLength: number;
  /** 手势超时 (ms) */
  timeout: number;
  /** 显示位置 */
  position: GesturePosition;
  /** 显示轨迹 */
  showTrail: boolean;
  /** 显示方向 */
  showDirection: boolean;
  /** 显示动作名称 */
  showActionName: boolean;
  /** 轨迹线颜色 */
  lineColor: string;
  /** 轨迹线宽度 */
  lineWidth: number;
  /** 文本颜色 */
  textColor: string;
  /** 背景颜色 */
  backgroundColor: string;
  /** 字体大小 */
  fontSize: number;
  /** 透明度 (0-1) */
  opacity: number;
  /** 手势规则列表 */
  gestures: GestureRule[];
  /** 站点黑名单 */
  blacklist: string[];
}

// ---------------------------------------------------------------------------
// 滚轮手势配置 (Scroll/Wheel Gesture)
// ---------------------------------------------------------------------------

/** 滚轮手势配置 */
export interface ScrollGestureConfig {
  /** 是否启用滚动手势 */
  enabled: boolean;
  /** 是否启用平滑滚动 */
  smoothScroll: boolean;
  /** 滚动速度 */
  scrollSpeed: number;
  /** 是否启用滚动加速 */
  scrollAcceleration: boolean;
  /** 滚动效果 (Page Up/Down/Top/Bottom) */
  scrollEffects: boolean;
  /** 反向方向 */
  reverseDirection: boolean;
}

// ---------------------------------------------------------------------------
// 超级拖拽配置 (Super Drag)
// ---------------------------------------------------------------------------

/** 拖拽操作类型 */
export type DragType = 'link' | 'image' | 'text';

/** 超级拖拽动作配置 */
export interface DragAction {
  id: string;
  type: DragType;
  gesture: string;
  actionId: string;
  label?: string;
  scope: 'global' | string[];
}

/** 超级拖拽配置 */
export interface DragConfig {
  /** 是否启用超级拖拽 */
  enabled: boolean;
  /** 是否启用拖拽链接 */
  enableDragLink: boolean;
  /** 是否启用拖拽图片 */
  enableDragImage: boolean;
  /** 是否启用拖拽文本 */
  enableDragText: boolean;
  /** 是否在文本框中启用拖拽文本 */
  enableDragTextInInput: boolean;
  /** 识别 URL 字符串为链接 */
  recognizeUrlAsLink: boolean;
  /** 链接含图片时优先拖拽图片 */
  imageFirstInLink: boolean;
  /** 拖拽外观启用 */
  showAppearance: boolean;
  /** 停用键 */
  deactivationKey: string;
  /** 拖拽动作列表 */
  actions: DragAction[];
}

// ---------------------------------------------------------------------------
// 摇杆手势配置 (Rocker Gesture)
// ---------------------------------------------------------------------------

/** 摇杆方向 */
export type RockerDirection = 'left' | 'right' | 'middle';

/** 摇杆动作 */
export interface RockerAction {
  /** 按住哪个键 */
  hold: RockerDirection;
  /** 点击哪个键 */
  click: RockerDirection;
  /** 触发的动作 ID */
  actionId: string;
  /** 触发时机: mousedown 或 mouseup */
  triggerOn: 'mousedown' | 'mouseup';
}

/** 摇杆手势配置 */
export interface RockerConfig {
  /** 是否启用摇杆手势 */
  enabled: boolean;
  /** 触发动作 */
  triggerAction: 'mousedown' | 'mouseup';
  /** 摇杆动作列表 */
  actions: RockerAction[];
}

// ---------------------------------------------------------------------------
// 光标主题 (Cursor Theme)
// ---------------------------------------------------------------------------

/** 光标主题定义 */
export interface CursorTheme {
  /** 主题 ID/目录名 (e.g. "Cat_paw") */
  id: string;
  /** 主题名称 */
  name: string;
  /** 光标图片 URL (PNG/SVG) */
  imageUrl: string;
  /** 是否为内置主题 */
  builtin: boolean;
  /** 光标热点 (hotspot) X 坐标 */
  hotspotX?: number;
  /** 光标热点 (hotspot) Y 坐标 */
  hotspotY?: number;
}

/** 用户自定义光标 */
export interface CustomCursor extends CursorTheme {
  builtin: false;
  /** 光标缩放 */
  scale: number;
}

// ---------------------------------------------------------------------------
// GA / 分析事件 (Analytics Event)
// ---------------------------------------------------------------------------

/** 分析事件载荷 */
export interface AnalyticsEvent {
  /** 事件名称 */
  eventName: string;
  /** 事件载荷 */
  payload: Record<string, unknown>;
  /** 时间戳 */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// VAST 广告检测 (VAST Ad Detection) — component XJZ / WwI
// ---------------------------------------------------------------------------

/** VAST 广告信息 (由 RWf 模块解析) */
export interface VastAdInfo {
  adId: string;
  creatives: VastCreative[];
}

export interface VastCreative {
  creativeId: string;
  media: VastMediaFile[];
}

export interface VastMediaFile {
  url: string;
  width?: string;
  height?: string;
  type?: string;
}

// ---------------------------------------------------------------------------
// 反馈事件 (Feedback Event) — content script <-> service_worker bridge
// ---------------------------------------------------------------------------

/** 内容脚本与服务端的反馈消息 */
export interface FeedbackEvent {
  /** 事件名 */
  event: string;
  /** 当前页面 URL */
  url: string;
  /** 事件载荷 */
  detail?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 全局存储键类型
// ---------------------------------------------------------------------------

/** chrome.storage 存储的顶层配置形状 */
export interface CrxMouseStorage {
  /** 主配置 (JSON 序列化) */
  crxmouse_config?: string;
  /** GUID 标识 */
  guid_key?: string;
  /** Obfuscated constants key (proconstantinator) */
  proconstantinator_key?: Record<number, string>;
  /** 手势规则 (JSON 序列化) */
  gesture_rules?: string;
  /** 摇杆规则 */
  rocker_rules?: string;
  /** 拖拽规则 */
  drag_rules?: string;
  /** 滚动配置 */
  scroll_config?: string;
  /** 光标选择 */
  selected_cursor?: string;
  /** 自定义光标数据 */
  custom_cursors?: string;
  /** 黑名单 */
  blacklist?: string;
  /** 同步状态 */
  sync_enabled?: boolean;
  /** 高级功能 (analytics consent) */
  advanced_features_consent?: boolean;
  /** 分析事件缓冲 */
  analytics_event_buffer?: AnalyticsEvent[];
  /** 热门手势缓存 */
  popular_gestures_cache?: Record<string, GestureRule[]>;
}

// ---------------------------------------------------------------------------
// 消息协议 (chrome.runtime.sendMessage)
// ---------------------------------------------------------------------------

/** Service worker 与 content script 的消息类型 */
export type CrxMessageTopic =
  | 'VAST'            // VAST 广告检测结果
  | 'proconstantinator' // 混淆常量
  | 'feedback'        // 反馈事件
  | 'XJZ_feedback'    // content script XJZ 模块反馈
  | 'WwI_feedback'    // content script WwI 模块反馈
  | 'getExtensionVersion'
  | 'gaEvent'
  | 'showOnboardingLater'
  | 'href'            // 链接点击
  | 'ahref';          // 右键/中键链接

export interface CrxMessage {
  topic?: CrxMessageTopic;
  type?: string;
  msg?: unknown;
  href?: string;
  ahref?: string;
  payload?: Record<string, unknown>;
  eventName?: string;
}

// ---------------------------------------------------------------------------
// MpiUO 模块注册表 (自研模块系统)
// ---------------------------------------------------------------------------

/** MpiUO 模块定义 */
export interface MpiUOModule {
  /** 初始化函数 */
  init: (...args: unknown[]) => void | Promise<void>;
  /** 是否已就绪 */
  ready?: boolean;
  /** 初始化进行中 */
  initInProgress?: boolean;
  /** 初始化错误 */
  error?: unknown;
  /** 依赖模块列表 */
  deps?: string[];
  /** 模块实例 */
  instance?: unknown;
  /** 模块类 */
  class?: new (...args: unknown[]) => unknown;
}
