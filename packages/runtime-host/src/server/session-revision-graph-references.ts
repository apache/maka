import type { ToolResultContent } from '@maka/core/events';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  sessionRevisionFamilyId,
  type SessionHeader,
  type StoredMessage,
} from '@maka/core/session';
import { decodeCanonicalToolResultContent } from '@maka/core/tool-result-record-schema';
import {
  agentGraphIdForRootSession,
  conversationCopyLinkedChildReferences,
  deserializeToolResultArchive,
  isArchivedToolResultPlaceholder,
  type AgentGraphCoordinator,
  type ConversationCopyExternalChildReferences,
  type ConversationCopyLinkedChildReference,
} from '@maka/runtime';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { InteractiveArtifactStoreWriter } from '@maka/storage/artifact-stores';

type ConversationCopyKind = 'branch' | 'revision';

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

type GraphReader = Pick<AgentGraphCoordinator, 'readSessionState'>;

interface GraphRevisionDependencies {
  readonly agentRunStore: {
    listSessionRuns(sessionId: string): Promise<readonly AgentRunHeader[]>;
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
    readonly messages: readonly StoredMessage[];
    readonly runtimeEvents: readonly RuntimeEvent[];
    readonly archivedResults: readonly string[];
  },
  dependencies: GraphRevisionDependencies,
): Promise<AgentGraphRevisionReferencePreparation> {
  const requests = collectLinkedChildReferenceRequests(input);
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
  if (
    directChildren.some((child) => !child.subagentParent?.graph || !requestedChildIds.has(child.id))
  ) {
    return failure(
      'operation_unavailable',
      'Session revision requires a terminal result for every retained Agent Graph child',
    );
  }

  const headersById = new Map(input.sessionHeaders.map((header) => [header.id, header]));
  const referencedGraphRootSessionIds = new Set<string>();
  const graphRootSessionIds = new Set([input.sourceSessionId]);
  for (const request of requests) {
    const parentSessionId = headersById.get(request.childSessionId)?.subagentParent
      ?.parentSessionId;
    if (parentSessionId) {
      referencedGraphRootSessionIds.add(parentSessionId);
      graphRootSessionIds.add(parentSessionId);
    }
  }
  for (const rootSessionId of graphRootSessionIds) {
    let state: 'absent' | 'live' | 'terminal';
    try {
      state = await dependencies.graph.readSessionState(rootSessionId);
    } catch {
      return failure('operation_unavailable', 'Retained Agent Graph state is unavailable');
    }
    if (state === 'live') {
      return failure('session_busy', 'A retained Agent Graph is not terminal');
    }
    if (referencedGraphRootSessionIds.has(rootSessionId) && state === 'absent') {
      return failure('operation_unavailable', 'Retained Agent Graph control state is unavailable');
    }
  }

  const references = new Map<string, MutableExternalChildReferences>();
  const runsByChildSession = new Map<string, ReadonlyMap<string, AgentRunHeader>>();
  for (const request of requests) {
    const childSessionId = request.childSessionId;
    const child = headersById.get(childSessionId);
    const parent = child?.subagentParent;
    if (
      !child ||
      !parent?.graph ||
      !familySessionIds.has(parent.parentSessionId) ||
      parent.graph.graphId !== agentGraphIdForRootSession(parent.parentSessionId) ||
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
      let runs: readonly AgentRunHeader[];
      try {
        runs = await dependencies.agentRunStore.listSessionRuns(childSessionId);
      } catch {
        return failure(
          'operation_unavailable',
          'Retained Agent Graph child lineage is unavailable',
        );
      }
      if (runs.some((run) => !isTerminalRunStatus(run.status))) {
        return failure('session_busy', 'A retained Agent Graph child is not terminal');
      }
      runsById = new Map(runs.map((run) => [run.runId, run]));
      runsByChildSession.set(childSessionId, runsById);
    }
    if (!request.runId || !request.turnId) {
      return failure('operation_unavailable', 'Retained Agent Graph result lacks a Run anchor');
    }
    const currentRun = runsById.get(request.runId);
    const resumedRun = request.resumedFromRunId
      ? runsById.get(request.resumedFromRunId)
      : undefined;
    if (
      !currentRun ||
      currentRun.sessionId !== childSessionId ||
      currentRun.turnId !== request.turnId ||
      currentRun.status !== request.status ||
      (request.resumedFromRunId !== undefined &&
        (!resumedRun ||
          resumedRun.sessionId !== childSessionId ||
          currentRun.resumedFromRunId !== request.resumedFromRunId))
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
        artifact.record.turnId !== request.turnId
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

function collectLinkedChildReferenceRequests(input: {
  readonly messages: readonly StoredMessage[];
  readonly runtimeEvents: readonly RuntimeEvent[];
  readonly archivedResults: readonly string[];
}): readonly ConversationCopyLinkedChildReference[] {
  const requests: ConversationCopyLinkedChildReference[] = [];
  const add = (content: ToolResultContent): void => {
    requests.push(...conversationCopyLinkedChildReferences(content));
  };

  for (const message of input.messages) {
    if (message.type === 'tool_result') add(message.content);
  }
  for (const event of input.runtimeEvents) {
    if (event.content?.kind !== 'function_response') continue;
    const content = decodeToolResultContent(event.content.result);
    if (content) add(content);
  }
  for (const serializedResult of input.archivedResults) {
    let value: unknown;
    try {
      value = deserializeToolResultArchive(serializedResult);
    } catch {
      continue;
    }
    const content = decodeToolResultContent(value);
    if (content) add(content);
  }
  return requests;
}

function decodeToolResultContent(value: unknown): ToolResultContent | undefined {
  if (isArchivedToolResultPlaceholder(value)) return undefined;
  try {
    return decodeCanonicalToolResultContent(value);
  } catch {
    return undefined;
  }
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
