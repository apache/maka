import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ConnectionTestSummary } from '@maka/core/runtime-policy';
import type {
  CredentialCircuitState,
  CredentialProfileVerificationRecord,
  ProviderFailureRoutingHint,
  ProviderFailureKind,
} from '@maka/core/provider-credential-routing';
import { acquireOperationalStateDatabase } from './operational-state-store.js';

/**
 * Versioned, non-secret execution basis digest (RFC section 8.4).
 *
 * Covers Provider type, normalized endpoint, API protocol, the current
 * model's relay/request overlay basis, and the Connection-level
 * request-headers credential identity/revision. Never contains secret
 * content or a secret hash: changing an endpoint, protocol, headers or key
 * request configuration invalidates old health naturally, while changing
 * only a Profile label/weight does not clear health.
 */
export const EXECUTION_BASIS_DIGEST_VERSION = 'provider-execution-basis-v1' as const;

export interface ExecutionBasisInput {
  readonly providerType: string;
  readonly endpoint: string;
  readonly apiProtocol: string | undefined;
  readonly requestHeadersCredentialId: string | null;
  readonly requestHeadersCredentialRevision: number | null;
  readonly requestBodyOverlayJson: string | null;
}

export function executionBasisDigest(input: ExecutionBasisInput): string {
  const canonical = JSON.stringify({
    version: EXECUTION_BASIS_DIGEST_VERSION,
    providerType: input.providerType,
    endpoint: input.endpoint,
    apiProtocol: input.apiProtocol ?? null,
    requestHeadersCredentialId: input.requestHeadersCredentialId ?? null,
    requestHeadersCredentialRevision: input.requestHeadersCredentialRevision ?? null,
    requestBodyOverlayJson: input.requestBodyOverlayJson ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Credential-scoped routing health row (model_id='' is the global row). */
export interface ProviderCredentialHealthRow {
  readonly connectionId: string;
  readonly profileId: string;
  readonly credentialId: string;
  readonly credentialRevision: number;
  readonly executionBasisDigest: string;
  readonly modelId: string;
  readonly circuitState: CredentialCircuitState;
  readonly failureKind: ProviderFailureKind | null;
  readonly failureScope: ProviderFailureRoutingHint['scope'] | null;
  readonly blockedUntil: number | null;
  readonly nextProbeAt: number | null;
  readonly consecutiveFailures: number;
  readonly lastFailureAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly updatedAt: number;
}

export interface ProviderCredentialRoutingStore {
  /** Read verification for one Profile (all bases/models). */
  readProfileVerification(
    connectionId: string,
    profileId: string,
  ): Promise<readonly CredentialProfileVerificationRecord[]>;
  /**
   * Upsert a single explicit verification item (profile test or
   * positive-only discovery). Never infers "missing model == denied".
   */
  upsertVerification(record: CredentialProfileVerificationRecord): Promise<void>;
  /**
   * Atomically replace the enabled-model verification set for one
   * Profile/basis (authoritative full discovery). Rows outside the new set
   * are removed.
   */
  replaceVerificationBasis(
    connectionId: string,
    profileId: string,
    credentialId: string,
    credentialRevision: number,
    executionBasisDigest: string,
    records: readonly CredentialProfileVerificationRecord[],
  ): Promise<void>;
  /** Read credential health rows (global + per-model) for a Profile/basis. */
  readHealth(
    connectionId: string,
    profileId: string,
    credentialId: string,
    credentialRevision: number,
    executionBasisDigest: string,
  ): Promise<readonly ProviderCredentialHealthRow[]>;
  /**
   * Record a successful outcome. No-op when no row exists and the circuit is
   * clean; otherwise closes the circuit and clears the failure streak.
   */
  settleSuccess(
    connectionId: string,
    profileId: string,
    credentialId: string,
    credentialRevision: number,
    executionBasisDigest: string,
    modelId: string,
    now: number,
  ): Promise<void>;
  /**
   * Record a failed outcome according to the routing hint. Account-scoped
   * failures open/invalidate circuits; connection/unknown scopes never touch
   * Profile health.
   */
  settleFailure(
    connectionId: string,
    profileId: string,
    credentialId: string,
    credentialRevision: number,
    executionBasisDigest: string,
    modelId: string,
    hint: ProviderFailureRoutingHint,
    now: number,
  ): Promise<void>;
  /**
   * Atomically claim a half-open probe for a circuit: at most one probe per
   * circuit. Returns false when the circuit is not eligible to probe.
   */
  claimHalfOpenProbe(
    connectionId: string,
    profileId: string,
    credentialId: string,
    credentialRevision: number,
    executionBasisDigest: string,
    modelId: string,
    now: number,
  ): Promise<boolean>;
  /** Delete every verification and health row for a Connection. */
  deleteConnection(connectionId: string): Promise<void>;
  /** Delete every verification and health row for one Profile. */
  deleteProfile(connectionId: string, profileId: string): Promise<void>;
  /**
   * Garbage-collect rows whose Profile no longer exists in the Catalog,
   * stale credential/execution-basis verification, and over-aged closed
   * health rows. `liveProfileKeys` is (connectionId, profileId) pairs from
   * the current Catalog.
   */
  cleanup(liveProfileKeys: ReadonlySet<string>, now: number): Promise<void>;
}

export function createSqliteProviderCredentialRoutingStore(
  workspaceRoot: string,
): ProviderCredentialRoutingStore {
  return new SqliteProviderCredentialRoutingStore(workspaceRoot);
}

const CLOSED_HEALTH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

class SqliteProviderCredentialRoutingStore implements ProviderCredentialRoutingStore {
  readonly #database: DatabaseSync;

  constructor(workspaceRoot: string) {
    this.#database = acquireOperationalStateDatabase(workspaceRoot).database;
  }

  readProfileVerification(
    connectionId: string,
    profileId: string,
  ): Promise<readonly CredentialProfileVerificationRecord[]> {
    const rows = this.#database
      .prepare(
        `SELECT connection_id, profile_id, credential_id, credential_revision,
                execution_basis_digest, model_id, status, source, evidence,
                checked_at, test_summary_json
         FROM provider_credential_verification
         WHERE connection_id = ? AND profile_id = ?`,
      )
      .all(connectionId, profileId) as Array<Record<string, unknown>>;
    return Promise.resolve(rows.map((row) => decodeVerificationRow(row)));
  }

  upsertVerification(record: CredentialProfileVerificationRecord): Promise<void> {
    this.#database
      .prepare(
        `INSERT INTO provider_credential_verification(
           connection_id, profile_id, credential_id, credential_revision,
           execution_basis_digest, model_id, status, source, evidence,
           checked_at, test_summary_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(
           connection_id, profile_id, credential_id, credential_revision,
           execution_basis_digest, model_id)
         DO UPDATE SET
           status = excluded.status,
           source = excluded.source,
           evidence = excluded.evidence,
           checked_at = excluded.checked_at,
           test_summary_json = excluded.test_summary_json`,
      )
      .run(
        record.connectionId,
        record.profileId,
        record.credentialId,
        record.credentialRevision,
        record.executionBasisDigest,
        record.modelId,
        record.status,
        record.source,
        record.evidence,
        record.checkedAt,
        record.testSummary ? JSON.stringify(record.testSummary) : null,
      );
    return Promise.resolve();
  }

  replaceVerificationBasis(
    connectionId: string,
    profileId: string,
    credentialId: string,
    credentialRevision: number,
    basis: string,
    records: readonly CredentialProfileVerificationRecord[],
  ): Promise<void> {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database
        .prepare(
          `DELETE FROM provider_credential_verification
           WHERE connection_id = ? AND profile_id = ? AND credential_id = ?
             AND credential_revision = ? AND execution_basis_digest = ?`,
        )
        .run(connectionId, profileId, credentialId, credentialRevision, basis);
      const insert = this.#database.prepare(
        `INSERT INTO provider_credential_verification(
           connection_id, profile_id, credential_id, credential_revision,
           execution_basis_digest, model_id, status, source, evidence,
           checked_at, test_summary_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const record of records) {
        insert.run(
          record.connectionId,
          record.profileId,
          record.credentialId,
          record.credentialRevision,
          record.executionBasisDigest,
          record.modelId,
          record.status,
          record.source,
          record.evidence,
          record.checkedAt,
          record.testSummary ? JSON.stringify(record.testSummary) : null,
        );
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return Promise.resolve();
  }

  readHealth(
    connectionId: string,
    profileId: string,
    credentialId: string,
    credentialRevision: number,
    basis: string,
  ): Promise<readonly ProviderCredentialHealthRow[]> {
    const rows = this.#database
      .prepare(
        `SELECT connection_id, profile_id, credential_id, credential_revision,
                execution_basis_digest, model_id, circuit_state, failure_kind,
                failure_scope, failure_evidence, blocked_until, next_probe_at,
                consecutive_failures, last_failure_at, last_success_at, updated_at
         FROM provider_credential_health
         WHERE connection_id = ? AND profile_id = ? AND credential_id = ?
           AND credential_revision = ? AND execution_basis_digest = ?`,
      )
      .all(connectionId, profileId, credentialId, credentialRevision, basis) as Array<
      Record<string, unknown>
    >;
    return Promise.resolve(rows.map((row) => decodeHealthRow(row)));
  }

  settleSuccess(
    connectionId: string,
    profileId: string,
    credentialId: string,
    credentialRevision: number,
    basis: string,
    modelId: string,
    now: number,
  ): Promise<void> {
    const update = this.#database.prepare(
      `UPDATE provider_credential_health
       SET circuit_state = 'closed',
           failure_kind = NULL,
           failure_scope = NULL,
           blocked_until = NULL,
           next_probe_at = NULL,
           consecutive_failures = 0,
           last_failure_at = NULL,
           last_success_at = ?,
           updated_at = ?
       WHERE connection_id = ? AND profile_id = ? AND credential_id = ?
         AND credential_revision = ? AND execution_basis_digest = ? AND model_id = ?`,
    );
    const result = update.run(
      now,
      now,
      connectionId,
      profileId,
      credentialId,
      credentialRevision,
      basis,
      modelId,
    );
    // No-op when there was no row and no circuit was ever opened: a clean
    // success must not manufacture write amplification (RFC 8.4).
    return Promise.resolve();
  }

  settleFailure(
    connectionId: string,
    profileId: string,
    credentialId: string,
    credentialRevision: number,
    basis: string,
    modelId: string,
    hint: ProviderFailureRoutingHint,
    now: number,
  ): Promise<void> {
    if (hint.scope !== 'credential' && hint.scope !== 'credential_model') {
      // connection / unknown scopes never change Profile health.
      return Promise.resolve();
    }
    const row = this.#database
      .prepare(
        `SELECT circuit_state, consecutive_failures
         FROM provider_credential_health
         WHERE connection_id = ? AND profile_id = ? AND credential_id = ?
           AND credential_revision = ? AND execution_basis_digest = ? AND model_id = ?`,
      )
      .get(connectionId, profileId, credentialId, credentialRevision, basis, modelId) as
      | { circuit_state?: unknown; consecutive_failures?: unknown }
      | undefined;

    const next = computeFailureState(
      row ? (String(row.circuit_state) as CredentialCircuitState) : 'closed',
      typeof row?.consecutive_failures === 'number' ? row.consecutive_failures : 0,
      hint,
      now,
    );
    this.#database
      .prepare(
        `INSERT INTO provider_credential_health(
           connection_id, profile_id, credential_id, credential_revision,
           execution_basis_digest, model_id, circuit_state, failure_kind,
           failure_scope, failure_evidence, blocked_until, next_probe_at,
           consecutive_failures, last_failure_at, last_success_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(
           connection_id, profile_id, credential_id, credential_revision,
           execution_basis_digest, model_id)
         DO UPDATE SET
           circuit_state = excluded.circuit_state,
           failure_kind = excluded.failure_kind,
           failure_scope = excluded.failure_scope,
           failure_evidence = excluded.failure_evidence,
           blocked_until = excluded.blocked_until,
           next_probe_at = excluded.next_probe_at,
           consecutive_failures = excluded.consecutive_failures,
           last_failure_at = excluded.last_failure_at,
           last_success_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(
        connectionId,
        profileId,
        credentialId,
        credentialRevision,
        basis,
        modelId,
        next.circuitState,
        next.failureKind,
        next.failureScope,
        next.failureEvidence,
        next.blockedUntil,
        next.nextProbeAt,
        next.consecutiveFailures,
        now,
        now,
      );
    return Promise.resolve();
  }

  claimHalfOpenProbe(
    connectionId: string,
    profileId: string,
    credentialId: string,
    credentialRevision: number,
    basis: string,
    modelId: string,
    now: number,
  ): Promise<boolean> {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#database
        .prepare(
          `SELECT circuit_state, blocked_until, next_probe_at
           FROM provider_credential_health
           WHERE connection_id = ? AND profile_id = ? AND credential_id = ?
             AND credential_revision = ? AND execution_basis_digest = ? AND model_id = ?`,
        )
        .get(connectionId, profileId, credentialId, credentialRevision, basis, modelId) as
        | {
            circuit_state?: unknown;
            blocked_until?: unknown;
            next_probe_at?: unknown;
          }
        | undefined;
      const state = row ? String(row.circuit_state) : 'closed';
      const blockedUntil = typeof row?.blocked_until === 'number' ? row.blocked_until : undefined;
      const nextProbeAt = typeof row?.next_probe_at === 'number' ? row.next_probe_at : undefined;
      if (state === 'closed' || state === 'invalid') {
        this.#database.exec('COMMIT');
        return Promise.resolve(false);
      }
      const probeEligible = Math.max(blockedUntil ?? 0, nextProbeAt ?? 0) <= now;
      if (state === 'half_open' || !probeEligible) {
        // Already half-open (another probe in flight) or cooldown not elapsed.
        this.#database.exec('COMMIT');
        return Promise.resolve(false);
      }
      this.#database
        .prepare(
          `UPDATE provider_credential_health
           SET circuit_state = 'half_open', updated_at = ?
           WHERE connection_id = ? AND profile_id = ? AND credential_id = ?
             AND credential_revision = ? AND execution_basis_digest = ? AND model_id = ?`,
        )
        .run(now, connectionId, profileId, credentialId, credentialRevision, basis, modelId);
      this.#database.exec('COMMIT');
      return Promise.resolve(true);
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  deleteConnection(connectionId: string): Promise<void> {
    this.#database
      .prepare('DELETE FROM provider_credential_verification WHERE connection_id = ?')
      .run(connectionId);
    this.#database
      .prepare('DELETE FROM provider_credential_health WHERE connection_id = ?')
      .run(connectionId);
    return Promise.resolve();
  }

  deleteProfile(connectionId: string, profileId: string): Promise<void> {
    this.#database
      .prepare(
        'DELETE FROM provider_credential_verification WHERE connection_id = ? AND profile_id = ?',
      )
      .run(connectionId, profileId);
    this.#database
      .prepare('DELETE FROM provider_credential_health WHERE connection_id = ? AND profile_id = ?')
      .run(connectionId, profileId);
    return Promise.resolve();
  }

  cleanup(liveProfileKeys: ReadonlySet<string>, now: number): Promise<void> {
    const staleVerification = this.#database
      .prepare(
        `SELECT connection_id, profile_id FROM provider_credential_verification
         GROUP BY connection_id, profile_id`,
      )
      .all() as Array<{ connection_id?: unknown; profile_id?: unknown }>;
    const staleHealth = this.#database
      .prepare(
        `SELECT connection_id, profile_id FROM provider_credential_health
         GROUP BY connection_id, profile_id`,
      )
      .all() as Array<{ connection_id?: unknown; profile_id?: unknown }>;
    const stale = new Set<string>();
    for (const row of [...staleVerification, ...staleHealth]) {
      const key = `${String(row.connection_id)}\u0000${String(row.profile_id)}`;
      if (!liveProfileKeys.has(key)) stale.add(key);
    }
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      for (const key of stale) {
        const separator = key.indexOf('\u0000');
        const connectionId = key.slice(0, separator);
        const profileId = key.slice(separator + 1);
        this.#database
          .prepare(
            'DELETE FROM provider_credential_verification WHERE connection_id = ? AND profile_id = ?',
          )
          .run(connectionId, profileId);
        this.#database
          .prepare(
            'DELETE FROM provider_credential_health WHERE connection_id = ? AND profile_id = ?',
          )
          .run(connectionId, profileId);
      }
      // Retire old closed health rows; open/invalid rows are kept.
      this.#database
        .prepare(
          `DELETE FROM provider_credential_health
           WHERE circuit_state = 'closed'
             AND updated_at < ?`,
        )
        .run(now - CLOSED_HEALTH_RETENTION_MS);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    return Promise.resolve();
  }
}

interface FailureState {
  readonly circuitState: CredentialCircuitState;
  readonly failureKind: ProviderFailureKind | null;
  readonly failureScope: ProviderFailureRoutingHint['scope'] | null;
  readonly failureEvidence: ProviderFailureRoutingHint['evidence'] | null;
  readonly blockedUntil: number | null;
  readonly nextProbeAt: number | null;
  readonly consecutiveFailures: number;
}

const PROBE_CADENCE_MS = 60_000;
const MAX_COOLDOWN_MS = 5 * 60_000;

function computeFailureState(
  previous: CredentialCircuitState,
  previousFailures: number,
  hint: ProviderFailureRoutingHint,
  now: number,
): FailureState {
  const failures = previousFailures + 1;
  switch (hint.kind) {
    case 'auth':
      // Confirmed auth failure: invalid until credential revision changes or
      // a manual retest passes.
      return {
        circuitState: 'invalid',
        failureKind: hint.kind,
        failureScope: hint.scope,
        failureEvidence: hint.evidence,
        blockedUntil: null,
        nextProbeAt: null,
        consecutiveFailures: failures,
      };
    case 'provider_billing':
      // Credential-scoped billing: open circuit.
      return {
        circuitState: 'open',
        failureKind: hint.kind,
        failureScope: hint.scope,
        failureEvidence: hint.evidence,
        blockedUntil: null,
        nextProbeAt: now + PROBE_CADENCE_MS,
        consecutiveFailures: failures,
      };
    case 'usage_limit':
      // Block until an official reset; otherwise probe cadence only.
      return {
        circuitState: 'open',
        failureKind: hint.kind,
        failureScope: hint.scope,
        failureEvidence: hint.evidence,
        blockedUntil: hint.retryAt ?? null,
        nextProbeAt: now + PROBE_CADENCE_MS,
        consecutiveFailures: failures,
      };
    case 'rate_limit':
      // Respect an official retryAt, else a bounded exponential cooldown.
      return {
        circuitState: 'open',
        failureKind: hint.kind,
        failureScope: hint.scope,
        failureEvidence: hint.evidence,
        blockedUntil: hint.retryAt ?? null,
        nextProbeAt: Math.min(
          now + PROBE_CADENCE_MS * 2 ** Math.min(failures, 5),
          now + MAX_COOLDOWN_MS,
        ),
        consecutiveFailures: failures,
      };
    case 'provider_permission': {
      if (hint.scope !== 'credential_model') {
        // Ambiguous permission: never globally disable a Profile.
        return {
          circuitState: previous,
          failureKind: hint.kind,
          failureScope: hint.scope,
          failureEvidence: hint.evidence,
          blockedUntil: null,
          nextProbeAt: null,
          consecutiveFailures: failures,
        };
      }
      return {
        circuitState: 'open',
        failureKind: hint.kind,
        failureScope: hint.scope,
        failureEvidence: hint.evidence,
        blockedUntil: null,
        nextProbeAt: now + PROBE_CADENCE_MS,
        consecutiveFailures: failures,
      };
    }
    case 'abort':
    case 'context_overflow':
    case 'network':
    case 'provider_unavailable':
    case 'timeout':
    case 'unknown':
      // These do not change Profile health (RFC 8.2).
      return {
        circuitState: previous,
        failureKind: hint.kind,
        failureScope: hint.scope,
        failureEvidence: hint.evidence,
        blockedUntil: null,
        nextProbeAt: null,
        consecutiveFailures: failures,
      };
  }
}

function decodeVerificationRow(row: Record<string, unknown>): CredentialProfileVerificationRecord {
  const testSummaryJson = typeof row.test_summary_json === 'string' ? row.test_summary_json : null;
  const base: CredentialProfileVerificationRecord = {
    connectionId: String(row.connection_id),
    profileId: String(row.profile_id),
    credentialId: String(row.credential_id),
    credentialRevision: Number(row.credential_revision),
    executionBasisDigest: String(row.execution_basis_digest),
    modelId: String(row.model_id),
    status: row.status === 'denied' ? 'denied' : 'supported',
    source: row.source === 'tested' ? 'tested' : 'discovered',
    evidence: row.evidence === 'authoritative' ? 'authoritative' : 'positive_only',
    checkedAt: Number(row.checked_at),
  };
  return testSummaryJson
    ? { ...base, testSummary: JSON.parse(testSummaryJson) as ConnectionTestSummary }
    : base;
}

function decodeHealthRow(row: Record<string, unknown>): ProviderCredentialHealthRow {
  return {
    connectionId: String(row.connection_id),
    profileId: String(row.profile_id),
    credentialId: String(row.credential_id),
    credentialRevision: Number(row.credential_revision),
    executionBasisDigest: String(row.execution_basis_digest),
    modelId: String(row.model_id),
    circuitState: String(row.circuit_state) as CredentialCircuitState,
    failureKind: (row.failure_kind as ProviderFailureKind | null) ?? null,
    failureScope: (row.failure_scope as ProviderFailureRoutingHint['scope'] | null) ?? null,
    blockedUntil: (row.blocked_until as number | null) ?? null,
    nextProbeAt: (row.next_probe_at as number | null) ?? null,
    consecutiveFailures: Number(row.consecutive_failures),
    lastFailureAt: (row.last_failure_at as number | null) ?? null,
    lastSuccessAt: (row.last_success_at as number | null) ?? null,
    updatedAt: Number(row.updated_at),
  };
}
