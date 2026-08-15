import type { SessionHeader } from '@maka/core/session';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { InteractiveLongTermMemoryWriter } from '@maka/storage/long-term-memory-store';
import type { RuntimePolicyReader } from '@maka/storage/runtime-policy-stores';
import {
  MemoryExtractionEngine,
  type MemoryExtractionGate,
  type MemoryExtractionSourceCapabilities,
  type MemoryExtractionSourceSnapshot,
  type MemoryRememberResult,
} from '@maka/runtime/memory-extraction';

import { type HistoryCompactCheckpoint } from '@maka/runtime/history-compact-checkpoint';

import type { RuntimeHostResidency } from './host-kernel.js';
import type { HostMemoryExtractionModel } from './execution-model-authority.js';
import { MemoryExtractionSessionLane } from './memory-extraction-session-lane.js';

type MemoryExtractionStore = Pick<
  InteractiveLongTermMemoryWriter,
  | 'commitExtraction'
  | 'initializeExtractionCursor'
  | 'readExtractionCursor'
  | 'readPendingExtractionFailure'
  | 'readExtractionReceipt'
  | 'recordCompactionPolicyDenial'
  | 'readCompactionPolicyDenials'
  | 'settleExtractionFailure'
>;

/** Host adapter for authority, residency, drain, and Session serialization. */
export class HostMemoryExtractionCoordinator {
  readonly #background = new Map<string, Promise<void>>();
  readonly #engine: MemoryExtractionEngine;
  #draining = false;

  constructor(
    private readonly input: {
      readonly store: MemoryExtractionStore;
      readonly policy: Readonly<RuntimePolicyReader>;
      readonly sessions: { readHeader(sessionId: string): Promise<SessionHeader> };
      readonly runtimeEvents: {
        readSessionRuntimeEventEntries(
          sessionId: string,
        ): Promise<Array<{ readonly ordinal: number; readonly event: RuntimeEvent }>>;
      };
      readonly historyCompaction: {
        readLatestCheckpoint(sessionId: string): Promise<HistoryCompactCheckpoint | undefined>;
        readCheckpoints(sessionId: string): Promise<readonly HistoryCompactCheckpoint[]>;
      };
      readonly model: HostMemoryExtractionModel;
      readonly lane: MemoryExtractionSessionLane;
      readonly acquireResidency: () => RuntimeHostResidency;
      readonly now?: () => number;
    },
  ) {
    this.#engine = new MemoryExtractionEngine({
      readGate: (sessionId) => this.readGateForSession(sessionId),
      readSessionEvents: (sessionId) =>
        this.input.runtimeEvents.readSessionRuntimeEventEntries(sessionId),
      readCursor: (sessionId) => this.input.store.readExtractionCursor(sessionId),
      initializeCursor: (sessionId, processedOrdinal) =>
        this.input.store.initializeExtractionCursor(sessionId, processedOrdinal),
      readPendingFailure: (sessionId) => this.input.store.readPendingExtractionFailure(sessionId),
      recordCompactionPolicyDenial: (denial) =>
        this.input.store.recordCompactionPolicyDenial(denial),
      readCompactionPolicyDenials: (sessionId) =>
        this.input.store.readCompactionPolicyDenials(sessionId),
      readLatestCompactionCheckpoint: (sessionId) =>
        this.input.historyCompaction.readLatestCheckpoint(sessionId),
      readCompactionCheckpoints: (sessionId) =>
        this.input.historyCompaction.readCheckpoints(sessionId),
      readReceipt: (operationId) => this.input.store.readExtractionReceipt(operationId),
      generate: ({ snapshot, prompt, stage, abortSignal }) =>
        this.input.model.generate({ snapshot, prompt, stage, abortSignal }),
      commit: (request) => this.input.store.commitExtraction(request),
      settleFailure: (request) => this.input.store.settleExtractionFailure(request),
      ...(input.now ? { now: input.now } : {}),
    });
  }

  sourceCapabilities(
    automaticGate: MemoryExtractionGate = { allowed: false, reason: 'unavailable' },
  ): MemoryExtractionSourceCapabilities {
    return Object.freeze({
      gate: () => this.readGate(),
      automaticGate: () => automaticGate,
      remember: (snapshot: MemoryExtractionSourceSnapshot) => this.remember(snapshot),
      extract: (snapshot: MemoryExtractionSourceSnapshot) => this.extract(snapshot),
    });
  }

  beginDrain(): void {
    this.#draining = true;
  }

  async close(): Promise<void> {
    this.beginDrain();
    while (this.#background.size > 0) {
      await Promise.allSettled([...this.#background.values()]);
    }
  }

  private async remember(snapshot: MemoryExtractionSourceSnapshot): Promise<MemoryRememberResult> {
    if (snapshot.trigger !== 'remember' || this.#draining) return unavailable();
    try {
      return await this.input.lane.run(
        snapshot.sessionId,
        () => this.#engine.execute(snapshot),
        'foreground',
      );
    } catch {
      return unavailable();
    }
  }

  private extract(snapshot: MemoryExtractionSourceSnapshot): void {
    if (snapshot.trigger !== 'extract' && snapshot.trigger !== 'compaction') {
      return;
    }
    // A late Compaction checkpoint still enters the lane during drain: an
    // explicit disabled/incognito policy is settled durably, while drain alone
    // remains recoverable after restart.
    if (this.#draining && snapshot.trigger !== 'compaction') return;
    if (snapshot.trigger === 'compaction' && !snapshot.compactionCheckpointId) return;
    const key = `${snapshot.sessionId}\0${
      snapshot.trigger === 'compaction' ? snapshot.compactionCheckpointId : snapshot.turnId
    }`;
    if (this.#background.has(key)) return;
    const residency = this.#draining ? undefined : this.input.acquireResidency();
    const task = this.input.lane
      .run(
        snapshot.sessionId,
        async () => {
          await this.#engine.execute(snapshot);
        },
        'background',
      )
      .catch(() => undefined)
      .finally(() => {
        this.#background.delete(key);
        residency?.release();
      });
    this.#background.set(key, task);
  }

  private async readGateForSession(sessionId: string): Promise<MemoryExtractionGate> {
    const gate = await this.readGate();
    if (!gate.allowed) return gate;
    try {
      const header = await this.input.sessions.readHeader(sessionId);
      return header.subagentParent || header.isArchived
        ? { allowed: false, reason: 'ineligible' }
        : { allowed: true };
    } catch {
      return { allowed: false, reason: 'unavailable' };
    }
  }

  private async readGate(): Promise<MemoryExtractionGate> {
    const policy = (await this.input.policy.getSnapshot()).policy;
    if (policy.privacy.incognitoActive) return { allowed: false, reason: 'incognito' };
    if (!policy.memory.enabled) return { allowed: false, reason: 'disabled' };
    if (this.#draining) return { allowed: false, reason: 'unavailable' };
    return { allowed: true };
  }
}

function unavailable(): MemoryRememberResult {
  return { status: 'unavailable', requestedItems: [] };
}
