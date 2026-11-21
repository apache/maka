// ========================================
// ChatLine v3.8.0 — 核心类型定义
// 来源：js/global/constants.js, js/background.js, js/timeline/adapters/
// ========================================

/** AI 平台标识 */
export type PlatformId =
  | 'chatgpt' | 'gemini' | 'doubao' | 'deepseek'
  | 'yiyan' | 'tongyi' | 'qwen' | 'kimi'
  | 'yuanbao' | 'grok' | 'perplexity' | 'claude' | 'notebooklm';

/** 平台信息 */
export interface SiteInfo {
  id: PlatformId;
  sites: string[];
  name: string;
  logoPath: string;
  features: PlatformFeatures;
}

/** 平台功能支持 */
export interface PlatformFeatures {
  timeline?: boolean;
  smartInput?: boolean;
  inputAnimation?: boolean;
  quickAsk?: boolean;
  conversationExport?: boolean;
  scrollToBottom?: boolean;
  chatTimes?: boolean;
  stableNodeId?: boolean;
  sidebarStarred?: boolean;
  supportsLongConversationOptimize?: boolean;
  quickAskPosition?: 'bottomLeft' | 'bottomRight';
  chatWidth?: ChatWidthConfig;
}

/** 聊天宽度调整配置 */
export interface ChatWidthConfig {
  targets?: ChatWidthTarget[];
  selectors?: string[];
}

export interface ChatWidthTarget {
  selector: string;
  base?: 'rect';
  properties?: string[];
  staticProperties?: Record<string, string>;
  staticOnly?: boolean;
}

/** 时间轴节点颜色选项 */
export interface TimelineColorOption {
  id: 'black' | 'blue' | 'purple' | 'gemini';
  color: string;
}

/** 代码运行器语言 */
export interface RunnerLanguage {
  id: 'javascript' | 'typescript' | 'sql' | 'html' | 'json' | 'markdown' | 'mermaid';
  name: string;
  mode: string;
  storageKey: string;
  runnerClass: string;
  hljsLang: string | null;
}

/** LaTeX 公式格式 */
export interface FormulaFormat {
  id: string;
  label: string;
  template: string;
}

/** 对话导出格式 */
export type ExportFormat = 'markdown' | 'html' | 'text' | 'json';

/** 对话导出选项 */
export interface ExportOptions {
  format: ExportFormat;
  includeThinking?: boolean;
  includeTimestamps?: boolean;
  platformId?: PlatformId;
}

/** 收藏项 */
export interface StarredItem {
  id: string;
  conversationId: string;
  messageId: string;
  platformId: PlatformId;
  folderId?: string;
  title: string;
  content: string;
  url: string;
  createdAt: string;
}

/** 收藏文件夹 */
export interface StarredFolder {
  id: string;
  name: string;
  color?: string;
  parentId?: string;
  createdAt: string;
}

/** 高亮标注 */
export interface HighlightAnnotation {
  id: string;
  text: string;
  color: string;
  platformId: PlatformId;
  conversationId: string;
  messageId: string;
  startOffset: number;
  endOffset: number;
  createdAt: string;
}

/** Google Drive 同步状态 */
export interface SyncStatus {
  lastSyncAt: string | null;
  enabled: boolean;
  error?: string;
}

/** 全局设置 */
export interface ChatLineSettings {
  timelineActiveColor?: Record<PlatformId, string>;
  runnerJsEnabled?: boolean;
  runnerTypeScriptEnabled?: boolean;
  runnerSQLEnabled?: boolean;
  runnerHtmlEnabled?: boolean;
  runnerJsonEnabled?: boolean;
  runnerMarkdownEnabled?: boolean;
  mermaidRendererEnabled?: boolean;
  formulaFormat?: string;
  highlightColors?: string[];
  chatWidth?: Record<string, string>;
  animationEnabled?: boolean;
  smartEnterEnabled?: boolean;
  syncEnabled?: boolean;
}
