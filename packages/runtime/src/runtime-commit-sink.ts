import { createHash } from 'node:crypto';
import {
  canonicalToolArgsHash as canonicalToolArgsHashCore,
  type RuntimeEvent,
  type ToolRecoveryMode,
} from '@maka/core';

export type { ToolRecoveryMode } from '@maka/core';

export interface ToolPreparedCommit {
  operationId: string;
  journalEventId: string;
  /** Provider-visible function_call fact; it may pre-exist while permission waits. */
  runtimeEvent: RuntimeEvent;
  /** Canonical, non-model-visible fact that T1 was crossed. */
  dispatchRuntimeEvent: RuntimeEvent;
  providerToolCallId: string;
  toolName: string;
  canonicalArgsHash: string;
  recoveryMode: ToolRecoveryMode;
  committedAt: number;
}

export interface ToolOutcomeCommit {
  operationId: string;
  journalEventId: string;
  runtimeEvent: RuntimeEvent;
  committedAt: number;
}

export interface RuntimeCommitResult {
  created: boolean;
  runtimeEventSeq: number;
}

export interface RuntimeCommitSink {
  commitToolPrepared(input: ToolPreparedCommit): Promise<RuntimeCommitResult>;
  commitToolOutcome(input: ToolOutcomeCommit): Promise<RuntimeCommitResult>;
}

export interface ToolOperationIdInput {
  invocationId: string;
  providerToolCallId: string;
}

export function buildToolOperationId(input: ToolOperationIdInput): string {
  if (!input.invocationId || !input.providerToolCallId) {
    throw new Error('Tool operation identity requires invocationId and providerToolCallId');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([input.invocationId, input.providerToolCallId]))
    .digest('hex')
    .slice(0, 32);
  return `toolop_${digest}`;
}

export function canonicalToolArgsHash(toolName: string, normalizedArgs: unknown): string {
  return canonicalToolArgsHashCore(toolName, normalizedArgs);
}
