import { projectDeepResearchEvents, type DeepResearchRun } from '@maka/core/deep-research-run';
import {
  buildDeepResearchImplementationPrompt,
  isDeepResearchSession,
} from '@maka/core/explore-agent';
import { buildDeepResearchTools, type MakaTool } from '@maka/runtime';
import {
  authenticateInteractiveArtifactStoreWriter,
  type InteractiveArtifactStoreWriter,
} from '@maka/storage/artifact-stores';
import {
  authenticateInteractiveDeepResearchStoreWriter,
  type InteractiveDeepResearchStoreWriter,
} from '@maka/storage/deep-research-authority';
import {
  isSessionNotFoundError,
  type ExecutionSessionWriter,
} from '@maka/storage/execution-stores';
import {
  DEEP_RESEARCH_CLIENT_OBJECTIVE_MAX_BYTES,
  DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES,
  DEEP_RESEARCH_IMPLEMENTATION_PROMPT_MAX_BYTES,
  DEEP_RESEARCH_RECENT_REFS_MAX,
  DEEP_RESEARCH_RESULT_MAX_BYTES,
  type DeepResearchQueryInput,
  type DeepResearchQueryResult,
  type OperationOutcome,
} from '../protocol/index.js';
import type { DeepResearchOperationHandlerMap } from './operation-dispatcher.js';
import { SessionAdmissionGate } from './session-admission-gate.js';

export interface HostDeepResearchCoordinatorInput {
  readonly store: InteractiveDeepResearchStoreWriter;
  readonly artifacts: InteractiveArtifactStoreWriter;
  readonly sessions: Pick<ExecutionSessionWriter, 'readHeaderSnapshot'>;
  readonly sessionAdmission: SessionAdmissionGate;
  readonly onProjectionChanged: (sessionId: string) => void;
}

/** Host-owned Deep Research ledger, model-tool, and Client projection boundary. */
export class HostDeepResearchCoordinator {
  readonly handlers: DeepResearchOperationHandlerMap = {
    'deep-research.query': (input) =>
      this.#sessionAdmission.run(input.sessionId, () => this.#query(input)),
  };

  readonly #store: InteractiveDeepResearchStoreWriter;
  readonly #artifacts: InteractiveArtifactStoreWriter;
  readonly #sessions: HostDeepResearchCoordinatorInput['sessions'];
  readonly #sessionAdmission: SessionAdmissionGate;
  readonly #unsubscribe: () => void;

  constructor(input: HostDeepResearchCoordinatorInput) {
    this.#store = authenticateInteractiveDeepResearchStoreWriter(input.store);
    this.#artifacts = authenticateInteractiveArtifactStoreWriter(input.artifacts);
    this.#sessions = input.sessions;
    this.#sessionAdmission = input.sessionAdmission;
    this.#unsubscribe = this.#store.subscribe(({ sessionId }) => {
      input.onProjectionChanged(sessionId);
    });
  }

  toolsForSession(sessionId: string): readonly MakaTool[] {
    return buildDeepResearchTools({
      store: this.#store,
      artifactStore: {
        create: async (input) => {
          if (input.sessionId !== sessionId) {
            throw new Error('Deep Research tool attempted to write another Session');
          }
          return this.#artifacts.create(input);
        },
        get: async (artifactId) =>
          (await this.#artifacts.getInSession(sessionId, artifactId)).record ?? null,
        readText: (artifactId, options) =>
          this.#artifacts.readTextInSession(sessionId, artifactId, options),
        delete: (artifactId) =>
          this.#artifacts.deleteOwnedDeepResearchArtifactInSession(sessionId, artifactId),
      },
    });
  }

  close(): void {
    this.#unsubscribe();
  }

  async #query(input: DeepResearchQueryInput): Promise<OperationOutcome<'deep-research.query'>> {
    const unavailable = await this.#assertSessionAvailable(input.sessionId);
    if (unavailable) return failure(unavailable.code, unavailable.message);
    try {
      const events = await this.#store.readEvents(input.sessionId);
      if (events.length === 0) {
        return success({ kind: 'not_started', sessionId: input.sessionId, revision: 0 });
      }
      const projection = projectDeepResearchEvents(events);
      if (projection.diagnostics.length > 0 || !projection.run) {
        return failure('internal_failure', 'Deep Research projection is unavailable');
      }
      return success(projectDeepResearchRun(projection.run, events.length));
    } catch (error) {
      if (isSessionNotFoundError(error)) return failure('not_found', 'Session does not exist');
      return failure('internal_failure', 'Deep Research projection is unavailable');
    }
  }

  async #assertSessionAvailable(sessionId: string): Promise<
    | {
        code: 'not_found' | 'session_archived' | 'invalid_request' | 'internal_failure';
        message: string;
      }
    | undefined
  > {
    try {
      const header = await this.#sessions.readHeaderSnapshot(sessionId);
      if (header.isArchived || header.status === 'archived') {
        return { code: 'session_archived', message: 'Session is archived' };
      }
      if (!isDeepResearchSession(header.labels)) {
        return {
          code: 'invalid_request',
          message: 'Session is not a Deep Research Session',
        };
      }
      return undefined;
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        return { code: 'not_found', message: 'Session does not exist' };
      }
      return { code: 'internal_failure', message: 'Session authority is unavailable' };
    }
  }
}

type DeepResearchSnapshot = Extract<DeepResearchQueryResult, { kind: 'snapshot' }>;

export function projectDeepResearchRun(
  run: DeepResearchRun,
  revision: number,
): DeepResearchQueryResult {
  const recentInspectedRefs = run.steps
    .flatMap((step) => step.inspectedRefs)
    .slice(-DEEP_RESEARCH_RECENT_REFS_MAX)
    .map((ref) => ({
      kind: ref.kind,
      locator: truncateUtf8(ref.locator, DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES),
      label: ref.label ? truncateUtf8(ref.label, DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES) : null,
    }));
  const workerRunIds = [...new Set(run.steps.flatMap((step) => step.workerRunIds))].slice(
    -DEEP_RESEARCH_RECENT_REFS_MAX,
  );
  const implementationPrompt =
    run.status === 'completed' && run.handoff && run.reportArtifactId
      ? truncateUtf8(
          buildDeepResearchImplementationPrompt(run),
          DEEP_RESEARCH_IMPLEMENTATION_PROMPT_MAX_BYTES,
        )
      : null;
  const snapshot: DeepResearchSnapshot = {
    kind: 'snapshot',
    sessionId: run.sessionId,
    revision,
    objective: truncateUtf8(run.objective, DEEP_RESEARCH_CLIENT_OBJECTIVE_MAX_BYTES),
    scopeLevel: run.scopeLevel,
    status: run.status,
    stage: run.stage,
    round: run.round,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    artifactsCount: run.artifacts.length,
    stepsCount: run.steps.length,
    checklist: run.checklist.map((item) => ({
      itemId: item.itemId,
      title: truncateUtf8(item.title, DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES),
      status: item.status,
      blockedReason: item.blockedReason
        ? truncateUtf8(item.blockedReason, DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES)
        : null,
    })),
    reportSections: run.reportSections.map((section) => ({
      key: section.key,
      status: section.status,
    })),
    recentInspectedRefs,
    workerRunIds,
    reportArtifactId: run.reportArtifactId ?? null,
    implementationPrompt: null,
  };
  return fitProjectionToEncodedBudget(snapshot, implementationPrompt);
}

function fitProjectionToEncodedBudget(
  input: DeepResearchSnapshot,
  implementationPrompt: string | null,
): DeepResearchSnapshot {
  let snapshot = input;
  if (encodedBytes(snapshot) > DEEP_RESEARCH_RESULT_MAX_BYTES) {
    snapshot = {
      ...snapshot,
      recentInspectedRefs: snapshot.recentInspectedRefs.map((ref) => ({
        ...ref,
        label: null,
      })),
    };
  }
  while (
    encodedBytes(snapshot) > DEEP_RESEARCH_RESULT_MAX_BYTES &&
    snapshot.recentInspectedRefs.length > 0
  ) {
    snapshot = { ...snapshot, recentInspectedRefs: snapshot.recentInspectedRefs.slice(1) };
  }
  while (
    encodedBytes(snapshot) > DEEP_RESEARCH_RESULT_MAX_BYTES &&
    snapshot.workerRunIds.length > 0
  ) {
    snapshot = { ...snapshot, workerRunIds: snapshot.workerRunIds.slice(1) };
  }
  if (encodedBytes(snapshot) > DEEP_RESEARCH_RESULT_MAX_BYTES) {
    throw new Error('Deep Research projection cannot fit the protocol result budget');
  }
  if (!implementationPrompt) return snapshot;
  return fitOptionalText(snapshot, implementationPrompt, (value) => ({
    ...snapshot,
    implementationPrompt: value,
  }));
}

function fitOptionalText(
  snapshot: DeepResearchSnapshot,
  value: string,
  update: (value: string | null) => DeepResearchSnapshot,
): DeepResearchSnapshot {
  const full = update(value);
  if (encodedBytes(full) <= DEEP_RESEARCH_RESULT_MAX_BYTES) return full;
  const characters = Array.from(value);
  let low = 1;
  let high = characters.length;
  let best = snapshot;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = update(truncateCharacters(value, midpoint));
    if (encodedBytes(candidate) <= DEEP_RESEARCH_RESULT_MAX_BYTES) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}

function truncateCharacters(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;
  if (maxCharacters === 1) return characters[0] ?? '…';
  return `${characters.slice(0, maxCharacters - 1).join('')}…`;
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const marker = '…';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  let bytes = 0;
  let output = '';
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes + markerBytes > maxBytes) break;
    output += character;
    bytes += characterBytes;
  }
  return `${output}${marker}`;
}

function success(result: DeepResearchQueryResult): OperationOutcome<'deep-research.query'> {
  return { ok: true, result };
}

function failure(
  code: Extract<OperationOutcome<'deep-research.query'>, { ok: false }>['error']['code'],
  message: string,
): OperationOutcome<'deep-research.query'> {
  return { ok: false, error: { code, message } };
}
