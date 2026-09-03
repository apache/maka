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
  runtimeInvocationOutcome,
  type RuntimeInvocationRecord,
} from '@maka/core/runtime-invocation';
import { sessionRevisionFamilyId, type SessionHeader } from '@maka/core/session';
import { type AgentGraphCoordinator } from '@maka/runtime/stream-graph-coordinator';
import {
  type ConversationCopyExternalChildReferences,
  type ConversationCopyLinkedChildReference,
} from '@maka/runtime/conversation-copy';
import type { InteractiveArtifactStoreWriter } from '@maka/storage/artifact-stores';

type ConversationCopyKind = 'branch' | 'revision' | 'side_conversation';

export type AgentGraphRevisionReferencePreparation =
  | {
      readonly ok: true;
      readonly references: ReadonlyMap<string, ConversationCopyExternalChildReferences>;
    }
  | {
      readonly ok: false;
      readonly code: 'operation_unavailable' | 'session_busy';
      readonly message: string;
    };

type GraphReader = Pick<AgentGraphCoordinator, 'readGraphState' | 'readSessionState'>;

interface GraphRevisionDependencies {
  readonly runtimeEventStore: {
    listSessionInvocations(sessionId: string): Promise<readonly RuntimeInvocationRecord[]>;
  };
  readonly artifacts: Pick<InteractiveArtifactStoreWriter, 'getInSession'>;
  readonly graph: GraphReader;
  readonly isSessionActive: (sessionId: string) => boolean;
}

interface MutableExternalChildReferences {
  readonly runIds: Set<string>;
  readonly artifactIds: Set<string>;
}

/**
 * Validate historical Agent Graph references retained by a Session revision.
 *
 * A revision remains in the source revision family, so terminal children stay
 * owned by their exact physical parent and are retained by the same lifecycle
 * unit. An ordinary branch has an independent lifecycle and therefore cannot
 * share those child authorities.
 */
export async function prepareAgentGraphRevisionReferences(
  input: {
    readonly kind: ConversationCopyKind;
    readonly sourceSessionId: string;
    readonly sourceHeader: SessionHeader;
    readonly sessionHeaders: readonly SessionHeader[];
    readonly copyTurnIds: readonly string[];
    readonly requests: readonly ConversationCopyLinkedChildReference[];
  },
  dependencies: GraphRevisionDependencies,
): Promise<AgentGraphRevisionReferencePreparation> {
  const requests = input.requests;
  const retainedTurnIds = new Set(input.copyTurnIds);
  const sourceFamilyId = sessionRevisionFamilyId(input.sourceHeader);
  const familySessionIds = new Set(
    input.sessionHeaders
      .filter((header) => sessionRevisionFamilyId(header) === sourceFamilyId)
      .map((header) => header.id),
  );
  const directChildren = input.sessionHeaders.filter(
    (header) =>
      header.subagentParent?.parentSessionId === input.sourceSessionId &&
      retainedTurnIds.has(header.subagentParent.spawnedBy.parentTurnId),
  );

  if (input.kind === 'branch' && (requests.length > 0 || directChildren.length > 0)) {
    return failure(
      'operation_unavailable',
      'Ordinary branches cannot share linked child Session ownership with their source',
    );
  }
  if (input.kind === 'branch') {
    return { ok: true, references: new Map() };
  }
  const requestedChildIds = new Set(requests.map((request) => request.childSessionId));
  const unrepresentedChildren = directChildren.filter((child) => !requestedChildIds.has(child.id));
  if (
    input.kind === 'side_conversation' &&
    unrepresentedChildren.some((child) => dependencies.isSessionActive(child.id))
  ) {
    return failure('session_busy', 'A retained linked child is still active');
  }
  const headersById = new Map(input.sessionHeaders.map((header) => [header.id, header]));
  const referencedGraphs = new Map<string, Set<string>>();
  const retainGraph = (header: SessionHeader | undefined) => {
    const parent = header?.subagentParent;
    if (!parent?.graph) return;
    const graphIds = referencedGraphs.get(parent.parentSessionId) ?? new Set<string>();
    graphIds.add(parent.graph.graphId);
    referencedGraphs.set(parent.parentSessionId, graphIds);
  };
  for (const request of requests) retainGraph(headersById.get(request.childSessionId));
  if (input.kind === 'side_conversation') {
    for (const child of directChildren) retainGraph(child);
  }
  const retainedSessionGraphFailure = async () => {
    try {
      if ((await dependencies.graph.readSessionState(input.sourceSessionId)) === 'live') {
        return failure('session_busy', 'A retained Agent Graph is not terminal');
      }
    } catch {
      return failure('operation_unavailable', 'Retained Agent Graph state is unavailable');
    }
    return undefined;
  };
  const retainedExactGraphFailure = async () => {
    for (const [rootSessionId, graphIds] of referencedGraphs) {
      for (const graphId of graphIds) {
        let state: 'absent' | 'live' | 'terminal';
        try {
          state = await dependencies.graph.readGraphState(rootSessionId, graphId);
        } catch {
          return failure('operation_unavailable', 'Retained Agent Graph state is unavailable');
        }
        if (state === 'live') {
          return failure('session_busy', 'A retained Agent Graph is not terminal');
        }
        if (state === 'absent') {
          return failure(
            'operation_unavailable',
            'Retained Agent Graph control state is unavailable',
          );
        }
      }
    }
    return undefined;
  };
  if (input.kind === 'side_conversation') {
    const graphFailure = await retainedExactGraphFailure();
    if (graphFailure) return graphFailure;
  }
  if (
    directChildren.some(
      (child) =>
        (input.kind === 'revision' && !child.subagentParent?.graph) ||
        !requestedChildIds.has(child.id),
    )
  ) {
    return failure(
      'operation_unavailable',
      input.kind === 'side_conversation'
        ? 'Side Conversation requires a terminal result for every retained linked child'
        : 'Session revision requires a terminal result for every retained Agent Graph child',
    );
  }
  if (input.kind === 'revision') {
    const graphFailure = await retainedSessionGraphFailure();
    if (graphFailure) return graphFailure;
    const exactGraphFailure = await retainedExactGraphFailure();
    if (exactGraphFailure) return exactGraphFailure;
  }

  const references = new Map<string, MutableExternalChildReferences>();
  const runsByChildSession = new Map<string, ReadonlyMap<string, RuntimeInvocationRecord>>();
  for (const request of requests) {
    const childSessionId = request.childSessionId;
    const child = headersById.get(childSessionId);
    const parent = child?.subagentParent;
    if (
      !child ||
      !parent ||
      !familySessionIds.has(parent.parentSessionId) ||
      (input.kind === 'revision' && !parent.graph) ||
      (parent.graph !== undefined &&
        !referencedGraphs.get(parent.parentSessionId)?.has(parent.graph.graphId)) ||
      !retainedTurnIds.has(parent.spawnedBy.parentTurnId)
    ) {
      return failure(
        'operation_unavailable',
        'Linked child reference does not belong to the retained Agent Graph revision family',
      );
    }
    if (dependencies.isSessionActive(childSessionId)) {
      return failure('session_busy', 'A retained Agent Graph child is still active');
    }
    if (!isTerminalRunStatus(request.status)) {
      return failure('session_busy', 'A retained Agent Graph result is not terminal');
    }

    let runsById = runsByChildSession.get(childSessionId);
    if (!runsById) {
      let runs: readonly RuntimeInvocationRecord[];
      try {
        runs = await dependencies.runtimeEventStore.listSessionInvocations(childSessionId);
      } catch {
        return failure(
          'operation_unavailable',
          'Retained Agent Graph child lineage is unavailable',
        );
      }
      if (runs.some((run) => runtimeInvocationOutcome(run) === undefined)) {
        return failure('session_busy', 'A retained Agent Graph child is not terminal');
      }
      runsById = new Map(runs.map((run) => [run.runId, run]));
      runsByChildSession.set(childSessionId, runsById);
    }
    if (!request.runId || !request.turnId) {
      return failure('operation_unavailable', 'Retained Agent Graph result lacks a Run anchor');
    }
    const currentRun = runsById.get(request.runId);
    if (
      !currentRun ||
      currentRun.sessionId !== childSessionId ||
      currentRun.turnId !== request.turnId ||
      !linkedResultStatusMatchesRun(request, currentRun)
    ) {
      return failure('operation_unavailable', 'Retained Agent Graph run reference is unavailable');
    }
    const lineage = traceChildRunLineage(currentRun, runsById, childSessionId);
    if (
      !lineage ||
      (request.resumedFromRunId !== undefined && !lineage.runIds.has(request.resumedFromRunId))
    ) {
      return failure('operation_unavailable', 'Retained Agent Graph run reference is unavailable');
    }
    for (const artifactId of request.artifactIds) {
      const artifact = await dependencies.artifacts
        .getInSession(childSessionId, artifactId)
        .catch(() => null);
      if (
        !artifact?.record ||
        artifact.record.sessionId !== childSessionId ||
        artifact.record.status === 'deleted' ||
        !lineage.turnIds.has(artifact.record.turnId)
      ) {
        return failure('operation_unavailable', 'Retained Agent Graph Artifact is unavailable');
      }
    }
    const accepted = references.get(childSessionId) ?? {
      runIds: new Set<string>(),
      artifactIds: new Set<string>(),
    };
    accepted.runIds.add(request.runId);
    if (request.resumedFromRunId) accepted.runIds.add(request.resumedFromRunId);
    for (const artifactId of request.artifactIds) accepted.artifactIds.add(artifactId);
    references.set(childSessionId, accepted);
  }
  return { ok: true, references };
}

export function agentGraphRevisionAdmissionSessionIds(input: {
  readonly sourceSessionId: string;
  readonly sessionHeaders: readonly SessionHeader[];
  readonly copyTurnIds: readonly string[];
  readonly requests: readonly ConversationCopyLinkedChildReference[];
}): readonly string[] {
  const retainedTurnIds = new Set(input.copyTurnIds);
  const sessionIds = new Set(input.requests.map((request) => request.childSessionId));
  for (const header of input.sessionHeaders) {
    const parent = header.subagentParent;
    if (
      parent?.parentSessionId === input.sourceSessionId &&
      retainedTurnIds.has(parent.spawnedBy.parentTurnId)
    ) {
      sessionIds.add(header.id);
    }
  }
  return [...sessionIds];
}

function failure(
  code: 'operation_unavailable' | 'session_busy',
  message: string,
): AgentGraphRevisionReferencePreparation {
  return { ok: false, code, message };
}

function isTerminalRunStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function linkedResultStatusMatchesRun(
  request: ConversationCopyLinkedChildReference,
  run: RuntimeInvocationRecord,
): boolean {
  const outcome = runtimeInvocationOutcome(run);
  return (
    outcome === request.status ||
    (request.status === 'failed' && request.failureClass === 'Timeout' && outcome === 'cancelled')
  );
}

function traceChildRunLineage(
  current: RuntimeInvocationRecord,
  runsById: ReadonlyMap<string, RuntimeInvocationRecord>,
  childSessionId: string,
): { readonly runIds: ReadonlySet<string>; readonly turnIds: ReadonlySet<string> } | undefined {
  const runIds = new Set<string>();
  const turnIds = new Set<string>();
  let cursor: RuntimeInvocationRecord | undefined = current;
  while (cursor) {
    if (cursor.sessionId !== childSessionId || runIds.has(cursor.runId)) return undefined;
    runIds.add(cursor.runId);
    turnIds.add(cursor.turnId);
    const lineage = cursor.opening.lineage;
    const previousRunId = lineage?.retriedFromRunId ?? lineage?.resumedFromRunId;
    if (!previousRunId) break;
    cursor = runsById.get(previousRunId);
    if (!cursor) return undefined;
  }
  return { runIds, turnIds };
}
