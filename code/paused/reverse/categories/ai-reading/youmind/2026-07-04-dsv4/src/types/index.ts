// YouMind v0.3.0.33 — 核心类型定义
// 升级自 v0.3.0-alpha21 → alpha33

export type NoteSource = 'webpage' | 'youtube' | 'x' | 'pdf' | 'image';

export interface YouMindNote {
  id: string;
  title: string;
  content: string;
  source: NoteSource;
  sourceUrl: string;
  tags: string[];
  annotations: Annotation[];
  createdAt: string;
  updatedAt: string;
  folderId?: string;
}

export interface Annotation {
  id: string;
  text: string;
  note: string;
  color: string;
  startOffset: number;
  endOffset: number;
}

export interface YouTubeTranscript {
  videoId: string;
  segments: TranscriptSegment[];
  language: string;
}

export interface TranscriptSegment {
  text: string;
  start: number;
  duration: number;
}

// v0.3.0.33 新增集成
export interface JinaAIScraperConfig { enabled: boolean; apiKey?: string; }
export interface SupadataConfig { enabled: boolean; apiKey?: string; }
