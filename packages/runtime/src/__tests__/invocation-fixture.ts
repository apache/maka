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

import { randomUUID } from 'node:crypto';
import type { RuntimeEvent, RuntimeEventInvocationOpenedContent } from '@maka/core/runtime-event';
import {
  buildInvocationOpenedEvent,
  type RuntimeInvocationRecord,
} from '@maka/core/runtime-invocation';

export interface SeededInvocationIdentity {
  readonly sessionId: string;
  readonly invocationId: string;
  readonly runId: string;
  readonly turnId: string;
}

export type TestInvocationOpeningOverrides = Omit<
  Partial<RuntimeEventInvocationOpenedContent>,
  'configuration'
> & { configuration?: Partial<RuntimeEventInvocationOpenedContent['configuration']> };

export interface SeedInvocationInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly invocationId?: string;
  readonly openedAt?: number;
  readonly opening?: TestInvocationOpeningOverrides;
}

/**
 * The opening a test gets when it does not care what the run was routed to.
 *
 * `configuration` merges field by field, so a test states only the setting it
 * is about. `route` replaces whole: which fields it carries depends on where
 * the route came from, and merging halves of two routes makes neither.
 */
export function testInvocationOpening(
  overrides: TestInvocationOpeningOverrides = {},
): RuntimeEventInvocationOpenedContent {
  const { configuration, ...rest } = overrides;
  return {
    kind: 'invocation_opened',
    protocol: 'invocation_opened_v1',
    route: {
      provenance: 'runtime',
      backendKind: 'fake',
      llmConnectionId: 'fake-connection',
      llmConnectionSlug: 'fake',
      modelId: 'fake-model',
    },
    ...rest,
    configuration: {
      cwd: '/tmp',
      permissionMode: 'ask',
      collaborationMode: 'agent',
      orchestrationMode: 'default',
      orchestrationSource: 'session',
      toolMode: 'direct',
      ...configuration,
    },
    root: overrides.root ?? { kind: 'user' },
    source: overrides.source ?? { kind: 'fresh' },
  };
}

/**
 * One invocation as a reader sees it, without a store.
 *
 * `outcome` writes the terminal event that decides it; leaving it out leaves the
 * invocation running, which is what "no terminal event" means everywhere else.
 */
export function testInvocationRecord(input: {
  sessionId: string;
  runId: string;
  turnId: string;
  invocationId?: string;
  openedAt?: number;
  closedAt?: number;
  outcome?: 'completed' | 'failed' | 'aborted';
  failureClass?: string;
  opening?: TestInvocationOpeningOverrides;
}): RuntimeInvocationRecord {
  const invocationId = input.invocationId ?? input.runId;
  const openedAt = input.openedAt ?? 1;
  const identity = {
    sessionId: input.sessionId,
    invocationId,
    runId: input.runId,
    turnId: input.turnId,
  };
  return {
    ...identity,
    openedAt,
    opening: testInvocationOpening(input.opening),
    ...(input.outcome
      ? {
          terminalEvent: {
            id: `${invocationId}-terminal`,
            ...identity,
            ts: input.closedAt ?? openedAt + 1,
            partial: false,
            role: 'system',
            author: 'system',
            status: input.outcome,
            actions: {
              endInvocation: true,
              ...(input.failureClass ? { stateDelta: { failureClass: input.failureClass } } : {}),
            },
          },
        }
      : {}),
  };
}

/** The event that opens one invocation, ready to append. */
export function testInvocationOpenedEvent(input: SeedInvocationInput): RuntimeEvent {
  return buildInvocationOpenedEvent({
    id: randomUUID(),
    run: {
      sessionId: input.sessionId,
      invocationId: input.invocationId ?? input.runId,
      runId: input.runId,
      turnId: input.turnId,
    },
    openedAt: input.openedAt ?? Date.now(),
    opening: testInvocationOpening(input.opening),
  });
}

/** The one invocation that opened this run, or a failure naming what is missing. */
export async function readInvocation(
  stores: {
    runtimeEventStore: {
      listSessionInvocations(sessionId: string): Promise<readonly RuntimeInvocationRecord[]>;
    };
  },
  sessionId: string,
  runId: string,
): Promise<RuntimeInvocationRecord> {
  const found = (await stores.runtimeEventStore.listSessionInvocations(sessionId)).find(
    (candidate) => candidate.runId === runId,
  );
  if (!found) throw new Error(`Session ${sessionId} has no invocation for run ${runId}`);
  return found;
}

/** Open one invocation on the spine, the way the runtime would. */
export async function seedInvocation(
  runtimeEventStore: {
    appendRuntimeEvent(sessionId: string, runId: string, event: RuntimeEvent): Promise<unknown>;
  },
  input: SeedInvocationInput,
): Promise<SeededInvocationIdentity> {
  const event = testInvocationOpenedEvent(input);
  await runtimeEventStore.appendRuntimeEvent(input.sessionId, input.runId, event);
  return {
    sessionId: event.sessionId,
    invocationId: event.invocationId,
    runId: event.runId,
    turnId: event.turnId,
  };
}
