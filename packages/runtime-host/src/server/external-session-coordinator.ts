import type {
  ExternalSessionAdapter,
  ExternalSessionAdapterRegistry,
  ExternalSessionSummary,
} from '@maka/core/external-session';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import type { SessionExternalOrigin, SessionHeader, StoredMessage } from '@maka/core/session';
import type { ExternalSessionImportLookupResult } from '@maka/storage';
import type { SessionCatalogRecord } from '@maka/storage/execution-stores';
import { ExternalSessionImporter } from '@maka/storage/external-sessions';
import {
  EXTERNAL_SESSION_CWD_MAX_BYTES,
  EXTERNAL_SESSION_IMPORTED_SESSION_IDS_MAX_ITEMS,
  EXTERNAL_SESSION_NAME_MAX_BYTES,
  EXTERNAL_SESSION_PAGE_MAX_ITEMS,
  EXTERNAL_SESSION_RESULT_MAX_BYTES,
  EXTERNAL_SESSION_SOURCE_MAX_ITEMS,
  EXTERNAL_SESSION_SOURCE_SESSION_ID_MAX_BYTES,
  type ExternalSessionCatalogItem,
  type ExternalSessionCatalogQueryInput,
  type ExternalSessionImportInput,
  type OperationError,
  type OperationOutcome,
} from '../protocol/index.js';
import type { ExternalSessionOperationHandlerMap } from './operation-dispatcher.js';
import {
  projectSessionCatalogRecord,
  SessionOperationFailure,
} from './session-catalog-coordinator.js';
import type { SessionAdmissionGate } from './session-admission-gate.js';
import { type HostWorkspaceResolver, WorkspaceResolutionError } from './workspace-resolver.js';

type ExternalSessionStore = {
  createImportedSession(
    input: CreateSessionInput,
    messages: readonly StoredMessage[],
    externalOrigin: SessionExternalOrigin,
  ): Promise<SessionHeader>;
  lookupExternalSessionImports(
    adapterId: string,
    sourceSessionIds: readonly string[],
    recentSessionIdLimit: number,
  ): Promise<readonly ExternalSessionImportLookupResult[]>;
  listHeaders(): Promise<SessionHeader[]>;
  readCatalogRecord(sessionId: string): Promise<SessionCatalogRecord>;
};

export interface HostExternalSessionCoordinatorOptions {
  readonly adapters: ExternalSessionAdapterRegistry;
  readonly admission: SessionAdmissionGate;
  readonly sessions: ExternalSessionStore;
  readonly workspaceResolver: Pick<HostWorkspaceResolver, 'resolve'>;
  readonly resolveTarget: () => Promise<Omit<CreateSessionInput, 'cwd' | 'name'>>;
  readonly prepareImportedSessionHistory: (sessionId: string) => Promise<void>;
  readonly discardImportedSession: (sessionId: string) => Promise<void>;
  readonly requestDrain: () => void;
}

/** Source discovery/conversion stays host-side so raw transcripts never cross the wire. */
export class HostExternalSessionCoordinator {
  readonly handlers: ExternalSessionOperationHandlerMap = {
    'external-session.source.query': () => this.listSources(),
    'external-session.catalog.query': (input) => this.listSessions(input),
    'external-session.import': (input) => this.importSession(input),
  };

  readonly #adapters: ExternalSessionAdapterRegistry;
  readonly #admission: SessionAdmissionGate;
  readonly #sessions: ExternalSessionStore;
  readonly #workspaceResolver: Pick<HostWorkspaceResolver, 'resolve'>;
  readonly #resolveTarget: HostExternalSessionCoordinatorOptions['resolveTarget'];
  readonly #prepareImportedSessionHistory: HostExternalSessionCoordinatorOptions['prepareImportedSessionHistory'];
  readonly #discardImportedSession: HostExternalSessionCoordinatorOptions['discardImportedSession'];
  readonly #requestDrain: () => void;

  /**
   * One import per source at a time, keyed by adapter + source session.
   *
   * A repeat import is a legitimate request — it makes an independent copy, and
   * a test below pins that. A repeat while the first is still running is not:
   * it is one intent counted twice, and it lands two tasks the user has to tell
   * apart and clean up.
   *
   * The guard has to be here rather than on the surface that asked. Import is a
   * Host operation and the Host is what knows one is running; a client only
   * knows about its own. The Settings page that replaced the import dialog can
   * be unmounted mid-import by design, and its in-flight state goes with it —
   * as would a second window's, or the CLI's.
   *
   * Coalesced, not rejected: the second caller gets the first one's outcome,
   * success or failure, because it is the same operation. Entries are keyed on
   * a JSON pair so no separator can be forged out of the ids themselves.
   */
  readonly #importsInFlight = new Map<
    string,
    Promise<OperationOutcome<'external-session.import'>>
  >();

  constructor(options: HostExternalSessionCoordinatorOptions) {
    this.#adapters = options.adapters;
    this.#admission = options.admission;
    this.#sessions = options.sessions;
    this.#workspaceResolver = options.workspaceResolver;
    this.#resolveTarget = options.resolveTarget;
    this.#prepareImportedSessionHistory = options.prepareImportedSessionHistory;
    this.#discardImportedSession = options.discardImportedSession;
    this.#requestDrain = options.requestDrain;
  }

  async recover(): Promise<void> {
    const headers = await this.#sessions.listHeaders();
    for (const header of headers) {
      if (header.transcriptLedgerVersion === 0) {
        await this.#prepareStagedSession(header.id);
      }
    }
  }

  async listSources(): Promise<OperationOutcome<'external-session.source.query'>> {
    const detected = await Promise.all(
      this.#adapters.list().map(async (adapter) => {
        try {
          return (await adapter.detect()) && wireAdapterId(adapter.id) ? adapter.id : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    return {
      ok: true,
      result: {
        adapterIds: detected
          .filter((id): id is string => id !== undefined)
          .slice(0, EXTERNAL_SESSION_SOURCE_MAX_ITEMS),
      },
    };
  }

  async listSessions(
    input: ExternalSessionCatalogQueryInput,
  ): Promise<OperationOutcome<'external-session.catalog.query'>> {
    const adapter = this.#adapters.get(input.adapterId);
    if (!adapter) return queryFailure('invalid_request', 'External Session source is unsupported');
    if (!(await this.#isDetected(adapter))) {
      return queryFailure('operation_unavailable', 'External Session source is unavailable');
    }
    try {
      const cwd = input.workspace
        ? (await this.#workspaceResolver.resolve(input.workspace)).cwd
        : undefined;
      const offset = input.cursor === undefined ? 0 : Number(input.cursor);
      const sessions = (
        await adapter.listSessions({
          ...(cwd === undefined ? {} : { cwd }),
          ...(input.includeArchived === undefined
            ? {}
            : { includeArchived: input.includeArchived }),
        })
      )
        .map(toWireSummary)
        .filter((summary): summary is ExternalSessionCatalogItem => summary !== undefined);
      const candidates = sessions.slice(offset, offset + EXTERNAL_SESSION_PAGE_MAX_ITEMS);
      const imports = await this.#sessions.lookupExternalSessionImports(
        input.adapterId,
        candidates.map(({ id }) => id),
        EXTERNAL_SESSION_IMPORTED_SESSION_IDS_MAX_ITEMS,
      );
      const importsBySource = new Map(imports.map((state) => [state.sourceSessionId, state]));
      const enrichedCandidates = candidates.map((session) => {
        const state = importsBySource.get(session.id);
        return {
          ...session,
          importState: {
            importedCount: state?.livePublishedImportCount ?? 0,
            importedSessionIds: state?.recentSessionIds ?? [],
            isImporting: this.#importsInFlight.has(importKey(input.adapterId, session.id)),
          },
        };
      });
      const page = boundedCatalogPage(enrichedCandidates, offset, sessions.length);
      const nextOffset = offset + page.length;
      return {
        ok: true,
        result: {
          sessions: page,
          nextCursor: nextOffset < sessions.length ? String(nextOffset) : null,
        },
      };
    } catch (error) {
      if (error instanceof WorkspaceResolutionError) {
        return queryFailure('invalid_request', error.message);
      }
      return queryFailure('persistence_failed', 'External Session catalog could not be read');
    }
  }

  async importSession(
    input: ExternalSessionImportInput,
  ): Promise<OperationOutcome<'external-session.import'>> {
    const key = importKey(input.adapterId, input.sourceSessionId);
    const running = this.#importsInFlight.get(key);
    if (running) return running;
    const attempt = this.#importSession(input);
    this.#importsInFlight.set(key, attempt);
    try {
      return await attempt;
    } finally {
      this.#importsInFlight.delete(key);
    }
  }

  async #importSession(
    input: ExternalSessionImportInput,
  ): Promise<OperationOutcome<'external-session.import'>> {
    const adapter = this.#adapters.get(input.adapterId);
    if (!adapter) return importFailure('invalid_request', 'External Session source is unsupported');
    if (!(await this.#isDetected(adapter))) {
      return importFailure('operation_unavailable', 'External Session source is unavailable');
    }

    let target: Omit<CreateSessionInput, 'cwd' | 'name'>;
    try {
      target = await this.#resolveTarget();
    } catch (error) {
      if (error instanceof SessionOperationFailure) {
        return importFailure(error.code, error.message);
      }
      return importFailure('persistence_failed', 'Session defaults are unavailable');
    }

    let commitAttempted = false;
    const importer = new ExternalSessionImporter(this.#adapters, {
      createImportedSession: async (sessionInput, messages, externalOrigin) => {
        commitAttempted = true;
        return this.#sessions.createImportedSession(sessionInput, messages, externalOrigin);
      },
    });
    let header: SessionHeader;
    try {
      header = await importer.import({
        adapterId: input.adapterId,
        sourceSessionId: input.sourceSessionId,
        target,
      });
    } catch (error) {
      if (!commitAttempted) {
        return importFailure(
          isSourceSessionNotFound(error) ? 'not_found' : 'invalid_request',
          isSourceSessionNotFound(error)
            ? 'External Session does not exist'
            : 'External Session could not be converted',
        );
      }
      this.#requestDrain();
      return importFailure(
        'commit_outcome_unknown',
        'External Session import outcome is unknown; check the Session list before retrying',
      );
    }

    let prepared: boolean;
    try {
      prepared = await this.#prepareStagedSession(header.id);
    } catch {
      this.#requestDrain();
      return importFailure(
        'commit_outcome_unknown',
        'External Session import outcome is unknown; check the Session list before retrying',
      );
    }
    if (!prepared) {
      return importFailure('persistence_failed', 'External Session history could not be prepared');
    }

    try {
      const record = await this.#sessions.readCatalogRecord(header.id);
      return { ok: true, result: { session: projectSessionCatalogRecord(record) } };
    } catch {
      this.#requestDrain();
      return importFailure(
        'commit_outcome_unknown',
        'External Session import outcome is unknown; check the Session list before retrying',
      );
    }
  }

  async #isDetected(adapter: ExternalSessionAdapter): Promise<boolean> {
    try {
      return await adapter.detect();
    } catch {
      return false;
    }
  }

  async #prepareStagedSession(sessionId: string): Promise<boolean> {
    return this.#admission.run(sessionId, async () => {
      try {
        await this.#prepareImportedSessionHistory(sessionId);
        return true;
      } catch {
        await this.#discardImportedSession(sessionId);
        return false;
      }
    });
  }
}

function toWireSummary(summary: ExternalSessionSummary): ExternalSessionCatalogItem | undefined {
  if (
    !wireSourceSessionId(summary.id) ||
    typeof summary.name !== 'string' ||
    typeof summary.cwd !== 'string'
  ) {
    return undefined;
  }
  const name = truncateUtf8(summary.name, EXTERNAL_SESSION_NAME_MAX_BYTES);
  if (name.length === 0) return undefined;
  const createdAt = safeTimestamp(summary.createdAt);
  const updatedAt = safeTimestamp(summary.updatedAt);
  return {
    id: summary.id,
    name,
    hostCwd: truncateUtf8(summary.cwd, EXTERNAL_SESSION_CWD_MAX_BYTES),
    importState: { importedCount: 0, importedSessionIds: [], isImporting: false },
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(typeof summary.archived === 'boolean' ? { archived: summary.archived } : {}),
  };
}

function boundedCatalogPage(
  candidates: readonly ExternalSessionCatalogItem[],
  offset: number,
  totalCount: number,
): ExternalSessionCatalogItem[] {
  const page: ExternalSessionCatalogItem[] = [];
  for (const candidate of candidates) {
    const nextPage = [...page, candidate];
    const nextOffset = offset + nextPage.length;
    const result = {
      sessions: nextPage,
      nextCursor: nextOffset < totalCount ? String(nextOffset) : null,
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > EXTERNAL_SESSION_RESULT_MAX_BYTES) {
      break;
    }
    page.push(candidate);
  }
  return page;
}

function wireSourceSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= EXTERNAL_SESSION_SOURCE_SESSION_ID_MAX_BYTES &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function wireAdapterId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = '';
  let byteLength = 0;
  for (const codePoint of value) {
    const nextLength = Buffer.byteLength(codePoint, 'utf8');
    if (byteLength + nextLength > maxBytes) break;
    result += codePoint;
    byteLength += nextLength;
  }
  return result;
}

function safeTimestamp(value: number | undefined): number | undefined {
  return value !== undefined &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 8_640_000_000_000_000
    ? value
    : undefined;
}

function isSourceSessionNotFound(error: unknown): boolean {
  return error instanceof Error && /Session not found|Session does not exist/i.test(error.message);
}

function importKey(adapterId: string, sourceSessionId: string): string {
  return JSON.stringify([adapterId, sourceSessionId]);
}

function queryFailure(
  code: OperationError<'external-session.catalog.query'>['code'],
  message: string,
): OperationOutcome<'external-session.catalog.query'> {
  return { ok: false, error: { code, message } };
}

function importFailure(
  code: OperationError<'external-session.import'>['code'],
  message: string,
): OperationOutcome<'external-session.import'> {
  return { ok: false, error: { code, message } };
}
