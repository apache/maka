// src/types/index.ts
// ========================================
// 飞书转存专家 - 核心类型定义
// ========================================

/**
 * 导出格式
 */
export enum ExportFormat {
  PDF = 'pdf',
  WORD = 'word',
  MARKDOWN = 'markdown',
  HTML = 'html',
  IMAGE = 'image'
}

/**
 * 导出选项
 */
export interface ExportOptions {
  /** 导出格式 */
  format: ExportFormat;

  /** 是否包含图片 */
  includeImages?: boolean;

  /** 图片质量 (1-100) */
  imageQuality?: number;

  /** 页面方向 */
  orientation?: 'portrait' | 'landscape';

  /** 页面大小 */
  pageSize?: 'A4' | 'A3' | 'Letter';

  /** 是否分页 */
  paginate?: boolean;

  /** 文件名模板 */
  filenameTemplate?: string;
}

/**
 * 导出结果
 */
export interface ExportResult {
  /** 是否成功 */
  success: boolean;

  /** 导出数据 (Blob 或 URL) */
  data?: Blob | string;

  /** 文件名 */
  filename?: string;

  /** MIME 类型 */
  mimeType?: string;

  /** 错误信息 */
  error?: string;
}

/**
 * 飞书文档信息
 */
export interface FeishuDocument {
  /** 文档 ID */
  id: string;

  /** 文档标题 */
  title: string;

  /** 文档类型 */
  type: 'doc' | 'sheet' | 'bitable' | 'mindmap' | 'file';

  /** 创建时间 */
  createdAt: string;

  /** 更新时间 */
  updatedAt: string;

  /** 作者 */
  author?: {
    id: string;
    name: string;
    avatar?: string;
  };

  /** 文档 URL */
  url: string;
}

/**
 * 导出进度
 */
export interface ExportProgress {
  /** 当前步骤 */
  step: string;

  /** 进度百分比 (0-100) */
  progress: number;

  /** 当前处理的项 */
  current?: number;

  /** 总项数 */
  total?: number;

  /** 状态消息 */
  message?: string;
}

/**
 * 消息类型
 */
export type MessageType =
  | 'EXPORT_DOCUMENT'
  | 'EXPORT_PROGRESS'
  | 'EXPORT_COMPLETE'
  | 'COPY_CONTENT'
  | 'SAVE_TO_PERSONAL_SPACE'
  | 'GET_DOCUMENT_INFO';

/**
 * Chrome 消息
 */
export interface ChromeMessage<T = unknown> {
  type: MessageType;
  action?: string;
  data?: T;
  tabId?: number;
}

/**
 * 消息响应
 */
export interface MessageResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * 存储键
 */
export enum StorageKey {
  CONFIG = 'feishu_export_config',
  HISTORY = 'feishu_export_history',
  CACHE = 'feishu_export_cache'
}

/**
 * 配置选项
 */
export interface FeishuExportConfig {
  /** 默认导出格式 */
  defaultFormat: ExportFormat;

  /** 是否自动下载 */
  autoDownload: boolean;

  /** 下载位置 */
  downloadPath?: string;

  /** 是否显示进度通知 */
  showProgress: boolean;

  /** 图片处理选项 */
  imageOptions: {
    quality: number;
    maxWidth: number;
    format: 'png' | 'jpeg' | 'webp';
  };

  /** PDF 选项 */
  pdfOptions: {
    orientation: 'portrait' | 'landscape';
    pageSize: 'A4' | 'A3' | 'Letter';
    margin: number;
  };
}

/**
 * 导出历史记录
 */
export interface ExportHistory {
  /** 唯一 ID */
  id: string;

  /** 文档信息 */
  document: FeishuDocument;

  /** 导出格式 */
  format: ExportFormat;

  /** 导出时间 */
  exportedAt: string;

  /** 文件大小 */
  fileSize?: number;

  /** 文件路径 (如果保存到本地) */
  filePath?: string;
}
