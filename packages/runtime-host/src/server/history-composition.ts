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

import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { InteractiveUsageStoresWriter } from '@maka/storage/usage-stores';
import type { GoalProjection } from '../protocol/index.js';
import type { RuntimeHostCompositionContext } from './host-kernel.js';
import { CanonicalSessionProjectionReader } from './canonical-session-projection.js';
import { HostCanonicalPermissionOutcomeReader } from './canonical-permission-outcome-reader.js';
import type { HostMessageCoordinator } from './message-coordinator.js';
import type { RootAdmissionOwner } from './root-admission-owner.js';
import type { SessionAdmissionGate } from './session-admission-gate.js';
import { SessionContinuityCoordinator } from './session-continuity-coordinator.js';
import { createSessionTranscriptReader } from './session-transcript-reader.js';
import type { HostTaskLedgerCoordinator } from './task-ledger-coordinator.js';

export interface RuntimeHostHistoryComposition {
  readonly canonicalProjection: CanonicalSessionProjectionReader;
  readonly canonicalPermissionOutcomes: HostCanonicalPermissionOutcomeReader;
  readonly continuity: SessionContinuityCoordinator;
  close(): void;
}

interface RuntimeHostHistoryChangeSubscriptions {
  close(): void;
}

/** Owns canonical history readers, continuity, and their durable change subscriptions. */
export function createRuntimeHostHistoryComposition(input: {
  readonly stores: ExecutionStoresWriter<'interactive'>;
  readonly usage: Pick<InteractiveUsageStoresWriter, 'subscribeSessionUsageChanges'>;
  readonly taskLedger: Pick<HostTaskLedgerCoordinator, 'subscribe'>;
  readonly rootAdmissions: RootAdmissionOwner;
  readonly messages: Pick<HostMessageCoordinator, 'projection'>;
  readonly readGoal: (sessionId: string) => GoalProjection | null;
  readonly sessionAdmission: SessionAdmissionGate;
  readonly hostEpoch: string;
  readonly requestDrain: () => void;
  readonly publishSessionCatalog: (sessionId: string) => void;
  readonly sessionAccessAuthority?: RuntimeHostCompositionContext['sessionAccessAuthority'];
}): RuntimeHostHistoryComposition {
  const canonicalProjection = new CanonicalSessionProjectionReader({
    stores: input.stores,
    rootAdmissions: input.rootAdmissions,
    messages: input.messages,
    readGoal: input.readGoal,
  });
  const canonicalPermissionOutcomes = new HostCanonicalPermissionOutcomeReader({
    store: input.stores.interactionStore,
  });
  const continuity = new SessionContinuityCoordinator(
    input.hostEpoch,
    (sessionId) => canonicalProjection.read(sessionId),
    input.sessionAdmission,
    input.requestDrain,
    createSessionTranscriptReader({ stores: input.stores, canonicalPermissionOutcomes }),
    input.publishSessionCatalog,
    input.sessionAccessAuthority,
  );
  const subscriptions = subscribeRuntimeHostHistoryChanges({
    stores: input.stores,
    usage: input.usage,
    taskLedger: input.taskLedger,
    continuity,
  });
  return Object.freeze({
    canonicalProjection,
    canonicalPermissionOutcomes,
    continuity,
    close: () => subscriptions.close(),
  });
}

export function subscribeRuntimeHostHistoryChanges(input: {
  readonly stores: Pick<ExecutionStoresWriter<'interactive'>, 'sessionStore'>;
  readonly usage: Pick<InteractiveUsageStoresWriter, 'subscribeSessionUsageChanges'>;
  readonly taskLedger: Pick<HostTaskLedgerCoordinator, 'subscribe'>;
  readonly continuity: Pick<
    SessionContinuityCoordinator,
    'enqueueCanonicalRefresh' | 'enqueueSessionDomainChanged'
  >;
}): RuntimeHostHistoryChangeSubscriptions {
  const releases: Array<() => void> = [];
  try {
    releases.push(
      input.stores.sessionStore.subscribeTranscriptChanges((sessionId) =>
        input.continuity.enqueueCanonicalRefresh(sessionId),
      ),
    );
    releases.push(
      input.usage.subscribeSessionUsageChanges((sessionId) =>
        input.continuity.enqueueSessionDomainChanged(sessionId, 'usage'),
      ),
    );
    releases.push(
      input.taskLedger.subscribe(({ sessionId }) =>
        input.continuity.enqueueSessionDomainChanged(sessionId, 'task'),
      ),
    );
  } catch (error) {
    releaseRuntimeHostHistoryChanges(releases, error);
  }
  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      releaseRuntimeHostHistoryChanges(releases);
    },
  };
}

function releaseRuntimeHostHistoryChanges(
  releases: readonly (() => void)[],
  cause?: unknown,
): never | void {
  const errors: unknown[] = cause === undefined ? [] : [cause];
  for (const release of releases) {
    try {
      release();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Unable to release Runtime Host history subscriptions');
  }
}
