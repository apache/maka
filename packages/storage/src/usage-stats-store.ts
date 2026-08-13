import { join } from 'node:path';
import type { UsageRange, UsageStats } from '@maka/core/settings';
import type { SessionHeader } from '@maka/core/session';
import { OPERATIONAL_STATE_DATABASE_NAME } from './operational-state-store.js';
import { createSqliteSessionMetadataStore } from './sqlite-session-metadata-store.js';

type UsageSessionHeader = Pick<SessionHeader, 'id' | 'llmConnectionSlug' | 'model'>;

type UsageAssistantMessage = {
  type: 'assistant';
  turnId: string;
  modelId: string;
};

type UsageTokenMessage = {
  type: 'token_usage';
  id: string;
  turnId: string;
  ts: number;
  input: number;
  output: number;
  cacheMissInput?: number;
  cacheRead?: number;
  cacheCreation?: number;
  reasoning?: number;
  costUsd?: number;
};

type UsageToolCallMessage = {
  type: 'tool_call';
  id: string;
  turnId: string;
  ts: number;
  toolName: string;
  displayName?: string;
};

type UsageToolResultMessage = {
  type: 'tool_result';
  turnId: string;
  ts: number;
  toolUseId: string;
  isError: boolean;
  durationMs?: number;
};

type UsageMessage =
  | UsageAssistantMessage
  | UsageTokenMessage
  | UsageToolCallMessage
  | UsageToolResultMessage;

export async function readUsageStats(
  workspaceRoot: string,
  range: UsageRange,
): Promise<UsageStats> {
  const since = rangeToSince(range);
  const sessions = await readStoredSessions(workspaceRoot);
  const modelLogs = sessions.flatMap(({ header, messages }) => {
    const assistantByTurn = new Map(
      messages
        .filter((message) => message.type === 'assistant')
        .map((message) => [message.turnId, message.modelId]),
    );
    return messages
      .filter((message): message is UsageTokenMessage => message.type === 'token_usage')
      .filter((message) => !since || message.ts >= since)
      .map((message) => ({
        id: message.id,
        ts: message.ts,
        kind: 'model' as const,
        sessionId: header.id,
        turnId: message.turnId,
        provider: header.llmConnectionSlug,
        model: assistantByTurn.get(message.turnId) ?? header.model,
        inputTokens: message.input,
        outputTokens: message.output,
        cacheMiss: message.cacheMissInput,
        cacheRead: message.cacheRead,
        cacheCreation: message.cacheCreation,
        reasoning: message.reasoning,
        costUsd: message.costUsd,
        status: 'success' as const,
      }));
  });

  const toolRows = aggregateToolStats(sessions, since);
  const toolLogs = sessions.flatMap(({ header, messages }) =>
    toolLogRowsFromMessages(header, messages, since),
  );
  const logs = [...modelLogs, ...toolLogs].sort((a, b) => b.ts - a.ts);
  const totalInput = sum(modelLogs.map((log) => log.inputTokens));
  const totalOutput = sum(modelLogs.map((log) => log.outputTokens));
  const cacheMiss = sum(modelLogs.map((log) => log.cacheMiss ?? 0));
  const cacheRead = sum(modelLogs.map((log) => log.cacheRead ?? 0));
  const cacheCreation = sum(modelLogs.map((log) => log.cacheCreation ?? 0));
  const reasoning = sum(modelLogs.map((log) => log.reasoning ?? 0));
  return {
    summary: {
      totalRequests: modelLogs.length,
      totalCostUsd: sum(modelLogs.map((log) => log.costUsd ?? 0)),
      totalTokens: totalInput + totalOutput,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheTokens: cacheRead + cacheCreation,
      cacheMiss,
      cacheRead,
      cacheCreation,
      reasoning,
    },
    logs,
    byProvider: aggregateBy(modelLogs, 'provider'),
    byModel: aggregateBy(modelLogs, 'model'),
    byTool: toolRows,
    pricing: [],
  };
}

async function readStoredSessions(
  workspaceRoot: string,
): Promise<Array<{ header: UsageSessionHeader; messages: UsageMessage[] }>> {
  const metadata = createSqliteSessionMetadataStore(
    join(workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME),
  );
  try {
    const sessions: Array<{ header: UsageSessionHeader; messages: UsageMessage[] }> = [];
    for (const { header } of await metadata.list()) {
      const messages = (await metadata.readMessages(header.id)).flatMap((value) => {
        const message = normalizeUsageMessage(value);
        return message ? [message] : [];
      });
      sessions.push({
        header: {
          id: header.id,
          llmConnectionSlug: header.llmConnectionSlug,
          model: header.model,
        },
        messages,
      });
    }
    return sessions;
  } catch {
    return [];
  } finally {
    metadata.close();
  }
}

function normalizeUsageSessionHeader(value: unknown, sessionId: string): UsageSessionHeader | null {
  if (!isRecord(value)) return null;
  if (value.id !== sessionId) return null;
  if (typeof value.llmConnectionSlug !== 'string') return null;
  if (typeof value.model !== 'string') return null;
  return {
    id: value.id,
    llmConnectionSlug: value.llmConnectionSlug,
    model: value.model,
  };
}

function normalizeUsageMessage(value: unknown): UsageMessage | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'assistant':
      if (typeof value.turnId !== 'string') return null;
      if (typeof value.modelId !== 'string') return null;
      return { type: 'assistant', turnId: value.turnId, modelId: value.modelId };
    case 'token_usage':
      if (typeof value.id !== 'string') return null;
      if (typeof value.turnId !== 'string') return null;
      if (!isFiniteNumber(value.ts)) return null;
      if (!isFiniteNumber(value.input)) return null;
      if (!isFiniteNumber(value.output)) return null;
      if (!isOptionalFiniteNumber(value.cacheMissInput)) return null;
      if (!isOptionalFiniteNumber(value.cacheRead)) return null;
      if (!isOptionalFiniteNumber(value.cacheCreation)) return null;
      if (!isOptionalFiniteNumber(value.reasoning)) return null;
      if (!isOptionalFiniteNumber(value.costUsd)) return null;
      return {
        type: 'token_usage',
        id: value.id,
        turnId: value.turnId,
        ts: value.ts,
        input: value.input,
        output: value.output,
        cacheMissInput: value.cacheMissInput,
        cacheRead: value.cacheRead,
        cacheCreation: value.cacheCreation,
        reasoning: value.reasoning,
        costUsd: value.costUsd,
      };
    case 'tool_call':
      if (typeof value.id !== 'string') return null;
      if (typeof value.turnId !== 'string') return null;
      if (!isFiniteNumber(value.ts)) return null;
      if (typeof value.toolName !== 'string') return null;
      if (value.displayName !== undefined && typeof value.displayName !== 'string') return null;
      return {
        type: 'tool_call',
        id: value.id,
        turnId: value.turnId,
        ts: value.ts,
        toolName: value.toolName,
        displayName: value.displayName,
      };
    case 'tool_result':
      if (typeof value.turnId !== 'string') return null;
      if (!isFiniteNumber(value.ts)) return null;
      if (typeof value.toolUseId !== 'string') return null;
      if (typeof value.isError !== 'boolean') return null;
      if (!isOptionalFiniteNumber(value.durationMs)) return null;
      return {
        type: 'tool_result',
        turnId: value.turnId,
        ts: value.ts,
        toolUseId: value.toolUseId,
        isError: value.isError,
        durationMs: value.durationMs,
      };
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

function rangeToSince(range: UsageRange): number | null {
  const now = Date.now();
  switch (range) {
    case '24h':
      return now - 24 * 60 * 60 * 1000;
    case '7d':
      return now - 7 * 24 * 60 * 60 * 1000;
    case '30d':
      return now - 30 * 24 * 60 * 60 * 1000;
    case 'all':
      return null;
  }
}

function aggregateBy(logs: UsageStats['logs'], key: 'provider' | 'model') {
  const rows = new Map<string, { requests: number; tokens: number; costUsd: number }>();
  for (const log of logs) {
    const id = log[key];
    const current = rows.get(id) ?? { requests: 0, tokens: 0, costUsd: 0 };
    current.requests += 1;
    current.tokens += log.inputTokens + log.outputTokens;
    current.costUsd += log.costUsd ?? 0;
    rows.set(id, current);
  }
  return [...rows.entries()]
    .map(([id, row]) => ({ [key]: id, ...row }))
    .sort((a, b) => b.requests - a.requests) as never;
}

// Aggregate tool usage by tool name across EVERY session so 工具统计 shows one row
// per tool (not one row per tool-per-session, which repeated the same tool name).
// tool_call.id ↔ tool_result.toolUseId matching stays scoped to each session's
// messages — ids are only unique within a session — while the counts, failures,
// and durations merge into a single global row keyed by tool name.
function aggregateToolStats(
  sessions: Array<{ messages: UsageMessage[] }>,
  since: number | null,
): UsageStats['byTool'] {
  const rows = new Map<
    string,
    { calls: number; success: number; errors: number; totalDuration: number; durationCount: number }
  >();
  for (const { messages } of sessions) {
    const results = new Map(
      messages
        .filter((message): message is UsageToolResultMessage => message.type === 'tool_result')
        .map((message) => [message.toolUseId, message]),
    );
    const calls = messages.filter(
      (message): message is UsageToolCallMessage => message.type === 'tool_call',
    );
    for (const call of calls) {
      if (since && call.ts < since) continue;
      const result = results.get(call.id);
      const current = rows.get(call.toolName) ?? {
        calls: 0,
        success: 0,
        errors: 0,
        totalDuration: 0,
        durationCount: 0,
      };
      current.calls += 1;
      if (result?.isError) current.errors += 1;
      else current.success += 1;
      if (result?.durationMs !== undefined) {
        current.totalDuration += result.durationMs;
        current.durationCount += 1;
      }
      rows.set(call.toolName, current);
    }
  }
  return [...rows.entries()]
    .map(([tool, row]) => ({
      tool,
      calls: row.calls,
      success: row.success,
      errors: row.errors,
      avgDurationMs: row.durationCount ? Math.round(row.totalDuration / row.durationCount) : 0,
    }))
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
}

function toolLogRowsFromMessages(
  header: UsageSessionHeader,
  messages: UsageMessage[],
  since: number | null,
): UsageStats['logs'] {
  const calls = messages.filter(
    (message): message is UsageToolCallMessage => message.type === 'tool_call',
  );
  const results = new Map(
    messages
      .filter((message): message is UsageToolResultMessage => message.type === 'tool_result')
      .map((message) => [message.toolUseId, message]),
  );
  return calls
    .filter((call) => !since || call.ts >= since)
    .map((call) => {
      const result = results.get(call.id);
      const ts = result?.ts ?? call.ts;
      return {
        id: `tool:${call.id}`,
        ts,
        kind: 'tool' as const,
        sessionId: header.id,
        turnId: call.turnId,
        provider: header.llmConnectionSlug,
        model: header.model,
        toolName: call.displayName ?? call.toolName,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: result?.durationMs,
        status: result?.isError ? ('error' as const) : ('success' as const),
      };
    });
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
