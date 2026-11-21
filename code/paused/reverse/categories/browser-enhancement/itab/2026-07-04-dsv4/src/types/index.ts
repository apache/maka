// iTab v2.1.17 — 核心类型定义 (dsv4)
// 重大变更：content_scripts 改为空数组，全部通过 scripting 动态注入

export interface ITabComponent {
  id: string;
  type: 'search' | 'bookmark' | 'widget' | 'notes' | 'weather' | 'calendar';
  position: { x: number; y: number; width: number; height: number };
  config: Record<string, unknown>;
}

export interface SearchEngine {
  id: string;
  name: string;
  url: string;
  icon: string;
  isDefault: boolean;
}

export interface Wallpaper {
  id: string;
  url: string;
  source: 'local' | 'bing' | 'unsplash' | 'custom';
  blur?: number;
  brightness?: number;
}

export interface ITabSettings {
  theme: 'light' | 'dark' | 'auto';
  wallpaper: Wallpaper;
  searchEngine: SearchEngine;
  components: ITabComponent[];
  layout: 'grid' | 'free' | 'focus';
  sidebar?: { enabled: boolean; position: 'left' | 'right' };
}

// v2.1.17 dsv4 发现
export interface PDFExportConfig {
  enabled: boolean;
  workerPath: string; // assets/pdf.worker-DgsYzxK6.js (970KB)
}
