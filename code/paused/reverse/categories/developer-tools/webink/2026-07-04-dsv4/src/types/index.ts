// WebInk v0.5.1 — 核心类型定义
// 升级自 v0.4.2：新增 side_panel 支持、更多 Mermaid 图表、wasm CSP

export interface WebInkConfig {
  enableHighlight?: boolean;
  enableMonaco?: boolean;
  mermaidTheme?: string;
  autoCopy?: boolean;
  preserveImages?: boolean;
  includeMetadata?: boolean;
  generateTOC?: boolean;
}

export interface ExtractedContent {
  title: string;
  url: string;
  markdown: string;
  html: string;
  metadata: {
    author?: string;
    date?: string;
    wordCount: number;
    readTime: number;
  };
  toc: TocItem[];
}

export interface TocItem {
  level: number;
  text: string;
  id: string;
  children: TocItem[];
}

export type ExportFormat = 'markdown' | 'html' | 'pdf' | 'text';
export type HighlightStyle = 'github' | 'monokai' | 'dracula' | 'vs' | 'vs-dark';
