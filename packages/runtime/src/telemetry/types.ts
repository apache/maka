import type { LlmCallRecord, ToolInvocationRecord } from '@maka/core/usage-stats/types';

export interface TelemetryRepoLite {
  insertLlmCall(record: PersistedLlmCallRecord): Promise<void>;
  insertToolInvocation(record: PersistedToolInvocationRecord): Promise<void>;
}

export type PersistedLlmCallRecord = LlmCallRecord & {
  id: string;
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  totalTokensSource?: 'reported' | 'derived';
  costUsd: number;
  date: string;
  ts: number;
};

export type PersistedToolInvocationRecord = ToolInvocationRecord & {
  id: string;
  argsSummary?: string;
  bytesIn: number;
  bytesOut: number;
  date: string;
  ts: number;
};
