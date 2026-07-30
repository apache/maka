import { randomUUID } from 'node:crypto';
import { generalizedErrorMessage } from '@maka/core/redaction';
import type { ToolInvocationRecord } from '@maka/core/usage-stats/types';
import type { TelemetryRepoLite } from './types.js';

const ARGS_SUMMARY_MAX = 512;

export interface ToolRecorderDeps {
  repo: TelemetryRepoLite;
}

export async function recordToolInvocation(
  deps: ToolRecorderDeps,
  record: ToolInvocationRecord,
): Promise<void> {
  try {
    const ts = record.startedAt + record.durationMs;
    await deps.repo.insertToolInvocation({
      ...record,
      id: `tool_${record.toolCallId ?? randomUUID()}`,
      argsSummary: truncate(record.argsSummary ?? ''),
      bytesIn: record.bytesIn ?? 0,
      bytesOut: record.bytesOut ?? 0,
      date: new Date(ts).toISOString().slice(0, 10),
      ts,
    });
  } catch (error) {
    console.error(`[telemetry] recordToolInvocation failed: ${generalizedErrorMessage(error)}`);
  }
}

function truncate(value: string): string {
  return value.length <= ARGS_SUMMARY_MAX ? value : `${value.slice(0, ARGS_SUMMARY_MAX - 1)}…`;
}
