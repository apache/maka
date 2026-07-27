import type { RuntimeEvent } from './runtime-event.js';

export const TOOL_RECOVERY_BUNDLE_CAPABILITY_V1 = 'tool_recovery_bundle_v1' as const;

export interface RuntimeRecoveryBundleCommit {
  operationId: string;
  reconcileRuntimeEvent: RuntimeEvent;
  outcomeRuntimeEvent?: RuntimeEvent;
  decisionRuntimeEvent: RuntimeEvent;
}

/** A requested stable-storage barrier failed; read-back cannot upgrade it to success. */
export class DurableStoreWriteError extends Error {
  readonly name = 'DurableStoreWriteError';

  constructor(
    message: string,
    readonly storeCause: unknown,
  ) {
    super(message);
  }
}

export interface RuntimeEventStore {
  /** Canonical stores fail the active run closed on every durable write error. */
  readonly durability?: 'best_effort' | 'canonical';
  appendRuntimeEvent(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
    options?: { durable?: boolean },
  ): Promise<void>;
  /** Append the terminal event if absent, or re-establish its stable-storage barrier if present. */
  ensureTerminalRuntimeEventDurable(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
  ): Promise<void>;
  readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
  /** Physical append-log rows only; excludes mutable partial snapshots. */
  readImmutableRuntimeEvents?(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
  readSessionRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]>;
}

export interface RuntimeRecoveryBundleStore extends RuntimeEventStore {
  readonly recoveryBundleCapability: typeof TOOL_RECOVERY_BUNDLE_CAPABILITY_V1;
  commitToolRecoveryBundle(input: RuntimeRecoveryBundleCommit): Promise<void>;
}
