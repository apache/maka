// 飞书转存专家 v0.7.27 — 核心类型定义 (dsv4)
// 升级自 v0.1.80 → v0.7.27：功能从飞书扩展到全平台

export type DocPlatform =
  | 'feishu' | 'kdocs' | 'tencent-doc' | 'yuque'
  | 'wechat-mp' | 'scys' | 'notion' | 'general';

export type ExportFormat =
  | 'pdf' | 'word' | 'markdown' | 'html' | 'image' | 'excel' | 'ppt' | 'text';

export interface DocExportConfig {
  platform: DocPlatform;
  format: ExportFormat;
  options: ExportOptions;
}

export interface ExportOptions {
  includeImages?: boolean;
  includeAttachments?: boolean;
  preserveFormatting?: boolean;
  pageSize?: 'A4' | 'Letter' | 'Legal';
  orientation?: 'portrait' | 'landscape';
  imageQuality?: number;
  mergePages?: boolean;
  extractTables?: boolean;
}

export interface CourseInfo {
  platform: string;
  courseId: string;
  title: string;
  chapters: ChapterInfo[];
}

export interface ChapterInfo {
  id: string;
  title: string;
  duration: number;
  videoUrl?: string;
  attachments?: AttachmentInfo[];
}

export interface AttachmentInfo {
  name: string;
  url: string;
  size: number;
  type: string;
}

// v0.7.27 新增平台
export interface ScysArticle { url: string; title: string; content: string; images: string[]; }
export interface KDocsDocument { id: string; title: string; type: 'doc' | 'sheet' | 'slide'; exportFormats: ExportFormat[]; }
