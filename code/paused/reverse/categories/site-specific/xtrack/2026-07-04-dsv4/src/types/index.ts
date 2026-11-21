// X-Track v1.3.1 — 核心类型定义 (dsv4 重做)
// 新增发现：assets/ai-BQqb46CV.js (221KB) — AI 相关模块

export interface Tweet {
  id: string;
  authorId: string;
  author?: User;
  content: string;
  createdAt: string;
  stats: TweetStats;
  tweetType: TweetType;
  media?: MediaItem[];
}

export interface User {
  id: string;
  screenName: string;
  name: string;
  avatarUrl: string;
}

export interface TweetStats {
  likes: number;
  retweets: number;
  replies: number;
  views: number;
}

export enum TweetType { ORIGINAL = 'ORIGINAL', RETWEET = 'RETWEET', QUOTE = 'QUOTE', REPLY = 'REPLY', ARTICLE = 'ARTICLE' }

export interface MediaItem { type: 'image' | 'video' | 'gif'; url: string; previewUrl?: string; }

export interface HistoryEntry {
  id?: number;
  tweetId: string;
  viewedAt: string;
  duration: number;
  type: HistoryType;
}

export type HistoryType = 'dwell' | 'click' | 'scroll';

// v1.3.1 dsv4 新发现：AI 功能模块
export interface AIAnalysisResult {
  tweetId: string;
  summary?: string;
  sentiment?: 'positive' | 'negative' | 'neutral';
  topics?: string[];
  suggestedBookmarks?: boolean;
}
