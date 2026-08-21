import { projectDeepResearchEvents, type DeepResearchRun } from '@maka/core/deep-research-run';
import { projectDeepResearchClientProgress } from '@maka/core/deep-research-client-progress';
import { isDeepResearchSession } from '@maka/core/explore-agent';
import { buildDeepResearchTools } from '@maka/runtime/deep-research-tools';
import { type MakaTool } from '@maka/runtime/tool-runtime';
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
  encodeDeepResearchSnapshot,
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
      if (header.isArchived) {
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

export function projectDeepResearchRun(
  run: DeepResearchRun,
  revision: number,
): DeepResearchQueryResult {
  return encodeDeepResearchSnapshot(projectDeepResearchClientProgress(run), revision);
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
