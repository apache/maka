// ========================================
// Chat Memo — 核心数据类型定义
// 来源：js/background.js, js/core/base.js, js/core/storage-manager.js
// ========================================

/** 支持的 AI 平台标识 */
export type PlatformId =
  | 'chatgpt'
  | 'deepseek'
  | 'gemini'
  | 'claude'
  | 'yuanbao'
  | 'doubao'
  | 'kimi'
  | 'qianwen';

/** 平台显示名称映射 */
export const PLATFORM_NAMES: Record<PlatformId, string> = {
  chatgpt: 'ChatGPT',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  claude: 'Claude',
  yuanbao: '腾讯元宝',
  doubao: '豆包',
  kimi: 'Kimi',
  qianwen: '千问',
};

/** 消息发送者 */
export type MessageSender = 'user' | 'AI';

/** 单条消息 */
export interface Message {
  /** 消息唯一标识 (msg_{sender}_position_{index}) */
  messageId: string;
  /** 发送者 */
  sender: MessageSender;
  /** 消息正文 */
  content: string;
  /** AI 模型的思考过程（可选，如 DeepSeek R1） */
  thinking?: string;
  /** 消息在对话中的位置索引 */
  position: number;
  /** 创建时间 (ISO 8601) */
  createdAt: string;
  /** 最后更新时间 (ISO 8601) */
  updatedAt: string;
  /** 原始时间戳（兼容字段） */
  timestamp?: string;
}

/** 对话/会话 */
export interface Conversation {
  /** 对话唯一标识 (conv_{timestamp}_{random}) */
  conversationId: string;
  /** 对话链接 (去参数后的 URL path) */
  link: string;
  /** 对话标题 */
  title: string;
  /** 所属平台 */
  platform: PlatformId;
  /** 消息列表 */
  messages: Message[];
  /** 平台外部 ID（部分平台有独立 ID） */
  externalId?: string | null;
  /** 最后消息时间（显示排序用） */
  lastMessageAt?: string;
  /** 创建时间 (ISO 8601) */
  createdAt: string;
  /** 最后更新时间 (ISO 8601) */
  updatedAt: string;
  /** 原始时间戳（兼容字段） */
  timestamp?: string;
}

/** 扩展设置 */
export interface Settings {
  /** 是否开启自动保存 */
  autoSave: boolean;
}

/** 默认设置 */
export const DEFAULT_SETTINGS: Settings = {
  autoSave: true,
};

/** 存储使用统计 */
export interface StorageUsage {
  /** 总对话数 */
  totalConversations: number;
  /** 今日新增 */
  todayNewConversations: number;
  /** 占用字节数 */
  storageBytes: number;
  /** 各平台对话数 */
  platformCounts: Record<string, number>;
}

/** 导出类型 */
export type ExportType = 'separate' | 'merged';

/** 导出元数据 */
export interface ExportMetadata {
  /** 导出标题 */
  title?: string;
  /** 搜索关键词 */
  searchTerm?: string;
  /** 筛选条件 */
  filter?: {
    startDate?: string;
    endDate?: string;
    platforms?: PlatformId[];
  };
}

/** 悬浮标签位置 */
export interface FloatTagPosition {
  /** 水平锚点 */
  anchor: 'left' | 'right';
  /** 距锚点边缘距离 (px) */
  distance: number;
  /** 垂直锚点 */
  verticalAnchor: 'top' | 'bottom';
  /** 距垂直锚点距离 (px) */
  verticalDistance: number;
  /** 是否贴边 */
  isEdgeDocked?: boolean;
  /** 贴边方向 */
  dockedSide?: 'left' | 'right' | null;
}

/** 分析事件数据 */
export interface AnalyticsEvent {
  uuid: string;
  event: string;
  version: string;
  ts: string;
  platform?: string;
  trigger?: string;
  msg_count?: number;
  char_count?: number;
  error_type?: string;
}

// ========================================
// Chrome Extension 消息类型
// ========================================

/** Background → Content / Popup 的消息 */
export type BackgroundMessage =
  | { type: 'settingsUpdated'; settings: Settings }
  | { type: 'toggleSidebar' };

/** Content/Popup → Background 的消息 */
export type ClientMessage =
  | { type: 'connectDB' }
  | { type: 'findConversationByUrl'; url: string }
  | { type: 'findConversationById'; conversationId: string }
  | { type: 'createConversation'; conversation: Partial<Conversation> }
  | { type: 'updateConversation'; conversation: Conversation }
  | { type: 'getConversationById'; conversationId: string }
  | { type: 'getAllConversations' }
  | { type: 'deleteConversation'; conversationId: string }
  | { type: 'getStorageUsage' }
  | { type: 'updateSettings'; settings: Settings }
  | { type: 'getSettings' }
  | { type: 'exportConversationsByRange'; conversationIds: string[]; exportType: ExportType; metadata?: ExportMetadata }
  | { type: 'clearStorage' }
  | { type: 'openSidePanel' }
  | { type: 'analyticsEvent'; event: string; data: Record<string, unknown> };

/** 消息响应 */
export interface MessageResponse<T = unknown> {
  status?: 'ok';
  error?: string;
  conversation?: Conversation | null;
  conversationId?: string;
  conversations?: Conversation[];
  usage?: StorageUsage;
  settings?: Settings;
  url?: string | null;
}
