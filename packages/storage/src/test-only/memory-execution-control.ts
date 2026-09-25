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

import {
  decodeInteractionCanonicalOutcome,
  isInteractionCanonicalOutcomeValidForRequest,
  interactionCanonicalOutcomesEquivalent,
  type InteractionCanonicalOutcome,
} from '@maka/core/interaction';
import {
  clientCapabilityScopeIdentity,
  type ClientCapabilitySessionGrant,
} from '@maka/core/client-capability-grant';
import { decodeGoalAuthorityRecord } from '@maka/core/goal';
import { assertSafeStorageId } from '../storage-id.js';
import type { GoalAuthorityRepository, GoalAuthoritySnapshot } from '../goal-authority.js';
import {
  normalizeRequest,
  assertId,
  normalizeFilter,
  matches,
  sortPending,
  decodeGrant,
  decodeGrantKey,
  decodeClientCapabilityOutcome,
  identity,
  encode,
  failure,
  decodeFailure,
  STORED_INTERACTION_REQUEST_MAX_BYTES,
  STORED_INTERACTION_OUTCOME_MAX_BYTES,
  STORED_CLIENT_CAPABILITY_SESSION_GRANT_MAX_BYTES,
  InteractionStoreError,
  type InteractionStoreWriter,
  type InteractionRecord,
  type StoredInteractionOutcome,
} from '../interaction-store-contract.js';
import {
  copy,
  equal,
  key,
  rows,
  type MemoryState,
  type MemoryExecutionAuthority,
} from './memory-execution-state.js';

const interactions = (s: MemoryState) => rows<InteractionRecord>(s, 'interactions');
const grants = (s: MemoryState) => rows<ClientCapabilitySessionGrant>(s, 'clientGrants');
function grantKey(input: unknown) {
  const k = decodeGrantKey(input, 'input');
  return key(
    k.sessionId,
    k.providerId,
    k.contractId,
    k.capability,
    k.scope.kind,
    clientCapabilityScopeIdentity(k.scope),
  );
}
function grant(s: MemoryState, input: ClientCapabilitySessionGrant) {
  const value = decodeGrant(copy(input), 'input');
  encode(value, STORED_CLIENT_CAPABILITY_SESSION_GRANT_MAX_BYTES);
  const id = grantKey(value),
    old = grants(s).get(id);
  if (old) return old;
  grants(s).set(id, value);
  return value;
}
function required(s: MemoryState, requestId: string) {
  assertId(requestId);
  const record = interactions(s).get(requestId);
  if (!record)
    throw new InteractionStoreError('request_not_found', 'Interaction request does not exist');
  return record;
}
function outcome(s: MemoryState, requestId: string, input: InteractionCanonicalOutcome) {
  const record = required(s, requestId);
  let canonical: InteractionCanonicalOutcome;
  try {
    canonical = decodeInteractionCanonicalOutcome(copy(input));
  } catch (error) {
    decodeFailure('input', 'Invalid Interaction outcome', error);
  }
  if (!isInteractionCanonicalOutcomeValidForRequest(record.request.request, canonical))
    throw new InteractionStoreError('invalid_input', 'Outcome is not valid for its request');
  const candidate = { ...identity(record.request), outcome: canonical };
  encode(candidate, STORED_INTERACTION_OUTCOME_MAX_BYTES);
  const settled: InteractionRecord & { outcome: StoredInteractionOutcome } = {
    request: record.request,
    outcome: record.outcome ?? candidate,
  };
  interactions(s).set(requestId, settled);
  return {
    status: 'stable' as const,
    matches: interactionCanonicalOutcomesEquivalent(settled.outcome.outcome, canonical),
    record: settled,
  };
}
export function createMemoryInteractionStore(
  a: MemoryExecutionAuthority,
): InteractionStoreWriter & { close(): void } {
  const store: InteractionStoreWriter & { close(): void } = {
    close: () => {},
    readInteraction: async (requestId) =>
      a.read((s) => {
        assertId(requestId);
        return interactions(s).get(requestId);
      }),
    listSessionPending: async (sessionId) => store.listPending({ sessionId }),
    listPending: async (filter = {}) =>
      a.read((s) => {
        normalizeFilter(filter);
        return sortPending(
          [...interactions(s).values()]
            .filter((r) => !r.outcome && matches(r.request, filter))
            .map((r) => r.request),
        );
      }),
    readClientCapabilitySessionGrant: async (input) =>
      a.read((s) => grants(s).get(grantKey(input))),
    establishRequest: async (input) => {
      const candidate = normalizeRequest(copy(input), 'input');
      encode(candidate, STORED_INTERACTION_REQUEST_MAX_BYTES);
      try {
        return a.write('interaction.establish', (s) => {
          const old = interactions(s).get(candidate.requestId);
          if (old)
            return {
              status: 'stable' as const,
              matches: equal(old.request, candidate),
              record: old,
            };
          const record = { request: candidate };
          interactions(s).set(candidate.requestId, record);
          return { status: 'stable' as const, matches: true, record };
        });
      } catch (error) {
        return {
          status: 'unresolved' as const,
          failure: failure(error, 'Request publication could not be stabilized'),
        };
      }
    },
    commitOutcome: async (requestId, input) =>
      a.write('interaction.outcome', (s) => outcome(s, requestId, input)),
    commitClientCapabilitySessionGrant: async (input) =>
      a.write('interaction.grant', (s) => grant(s, input)),
    commitClientCapabilityOutcome: async (requestId, input, grantInput) =>
      a.write('interaction.capabilityOutcome', (s) => {
        const record = required(s, requestId);
        if (record.request.request.kind !== 'client_capability')
          throw new InteractionStoreError('invalid_input', 'Expected Client Capability request');
        const canonical = decodeClientCapabilityOutcome(copy(input));
        const candidate =
          grantInput === undefined ? undefined : decodeGrant(copy(grantInput), 'input');
        const shouldGrant =
          canonical.kind === 'client_capability_decision' && canonical.decision === 'allow';
        if (shouldGrant !== (candidate !== undefined))
          throw new InteractionStoreError(
            'invalid_input',
            'Allow requires exactly one Session Grant',
          );
        if (
          candidate &&
          (!equal(decodeGrantKey(candidate, 'input'), {
            sessionId: record.request.sessionId,
            ...record.request.request.target,
          }) ||
            candidate.grantedAt !== canonical.committedAt)
        )
          throw new InteractionStoreError('invalid_input', 'Grant does not match request');
        const result = outcome(s, requestId, canonical);
        if (result.matches && candidate) grant(s, candidate);
        return result;
      }),
  };
  return store;
}
export function createMemoryGoalStore(a: MemoryExecutionAuthority): GoalAuthorityRepository {
  return {
    close: () => {},
    list: () =>
      a.read((s) =>
        [...rows<GoalAuthoritySnapshot>(s, 'goals').values()].sort((x, y) =>
          x.record.goal.sessionId.localeCompare(y.record.goal.sessionId),
        ),
      ),
    read: (sessionId) =>
      a.read((s) => {
        assertSafeStorageId(sessionId, 'Invalid Session');
        return rows<GoalAuthoritySnapshot>(s, 'goals').get(sessionId) ?? null;
      }),
    commit: (input) =>
      a.write('goal.commit', (s) => {
        assertSafeStorageId(input.sessionId, 'Invalid Session');
        if (
          input.expectedAuthorityRevision !== null &&
          (!Number.isSafeInteger(input.expectedAuthorityRevision) ||
            input.expectedAuthorityRevision < 0)
        )
          throw new TypeError('Goal authority expected revision is invalid');
        const record = input.record === null ? null : decodeGoalAuthorityRecord(copy(input.record));
        if (record && record.goal.sessionId !== input.sessionId)
          throw new TypeError('Goal authority Session identity changed');
        const table = rows<GoalAuthoritySnapshot>(s, 'goals'),
          old = table.get(input.sessionId),
          actual = old?.authorityRevision ?? null;
        if (actual !== input.expectedAuthorityRevision)
          return { kind: 'revision_conflict', actualAuthorityRevision: actual };
        if (!record) {
          table.delete(input.sessionId);
          return { kind: 'committed', snapshot: null };
        }
        const snapshot = { authorityRevision: (actual ?? -1) + 1, record };
        table.set(input.sessionId, snapshot);
        return { kind: 'committed', snapshot };
      }),
  };
}
