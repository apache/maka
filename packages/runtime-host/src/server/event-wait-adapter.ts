/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { ObservedEventWaitRecord } from '@maka/core/event-wait';

export type EventWaitObservationResult = {
  /** Checkpoint only after the returned facts have been processed. */
  readonly cursor?: string;
  readonly eventKey?: string;
} & (
  | { readonly kind: 'pending' }
  | {
      readonly kind: 'unknown';
      readonly reason: string;
      /**
       * Minimum delay for this provider/connection, in relative milliseconds. The adapter
       * must normalize source timestamps/units before returning it. The manager preserves
       * the full delay across wait cleanup and restart; local backoff caps do not shorten it.
       */
      readonly retryAfterMs?: number;
    }
  | {
      readonly kind: 'satisfied' | 'invalidated' | 'source_unavailable';
      readonly receiptKey: string;
      readonly evidenceRefs: readonly string[];
    }
);

export type EventWaitObservationAccess =
  | { readonly kind: 'allowed'; readonly context: unknown }
  | { readonly kind: 'revoked'; readonly reason: string }
  | {
      readonly kind: 'unknown';
      readonly reason: string;
      /** Same normalized, source-wide minimum delay as an unknown observation result. */
      readonly retryAfterMs?: number;
    };

export interface EventWaitReadContext {
  readonly wait: ObservedEventWaitRecord;
  readonly access: unknown;
  readonly cursor: string | null;
  readonly signal: AbortSignal;
}

export interface EventWaitSubscription {
  /** Synchronous, idempotent release; signal abort must also release transport resources. */
  close(): void;
}

export interface EventWaitSourceAdapter {
  readonly providerId: string;
  readonly resourceType: string;
  readonly conditionType: string;
  readonly conditionVersion: number;
  /**
   * snapshot: authoritative current state retains the condition's facts.
   * history: read must replay durable history from the checkpoint, including offline events.
   * A transient notification-only source cannot implement this contract.
   */
  readonly reconciliation: 'snapshot' | 'history';
  /** Synchronous bounded parameter validation; no I/O or model reasoning. */
  validate(wait: ObservedEventWaitRecord): void;
  read(input: EventWaitReadContext): Promise<EventWaitObservationResult>;
  /**
   * Resolves only after notification intake is ready. The manager then reads authoritative
   * facts, closing the subscribe/read gap. Notifications only mark a wait dirty; no result,
   * authorization or execution request is accepted through this callback.
   * Implementations must support polling reconciliation when subscription capacity is full.
   */
  subscribe?(input: EventWaitReadContext, changed: () => void): Promise<EventWaitSubscription>;
}

function key(provider: string, resource: string, condition: string, version: number): string {
  return JSON.stringify([provider, resource, condition, version]);
}

export class EventWaitAdapterRegistry {
  readonly #adapters = new Map<string, EventWaitSourceAdapter>();
  constructor(adapters: readonly EventWaitSourceAdapter[]) {
    for (const adapter of adapters) {
      if (
        !['snapshot', 'history'].includes(adapter.reconciliation) ||
        !Number.isSafeInteger(adapter.conditionVersion) ||
        adapter.conditionVersion < 1 ||
        [adapter.providerId, adapter.resourceType, adapter.conditionType].some(
          (v) => typeof v !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(v),
        )
      )
        throw new TypeError('Invalid event wait adapter');
      const id = key(
        adapter.providerId,
        adapter.resourceType,
        adapter.conditionType,
        adapter.conditionVersion,
      );
      if (this.#adapters.has(id)) throw new TypeError('Duplicate event wait adapter');
      this.#adapters.set(id, adapter);
    }
  }
  get(wait: ObservedEventWaitRecord): EventWaitSourceAdapter | undefined {
    return this.#adapters.get(
      key(
        wait.resource.providerId,
        wait.resource.resourceType,
        wait.condition.typeId,
        wait.condition.version,
      ),
    );
  }
  validate(wait: ObservedEventWaitRecord): EventWaitSourceAdapter {
    const adapter = this.get(wait);
    if (!adapter) throw new TypeError('Unsupported event wait condition');
    adapter.validate(wait);
    return adapter;
  }
}
