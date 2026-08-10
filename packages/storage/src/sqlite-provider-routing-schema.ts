import type { DatabaseSync } from 'node:sqlite';

/**
 * Provider Credential routing authority schema (RFC section 8.4).
 *
 * Deliberately a separate scope inside `runtime.sqlite` rather than a
 * `connection-catalog.json` or usage projection:
 * - Profile × model verification must not break the 4 MiB Catalog document
 *   bound (up to 512 entries per profile/basis);
 * - dynamic health (429/cooldown/circuit) must not bump Catalog revisions;
 * - it is execution routing authority, not a billing projection.
 */
export const SQLITE_PROVIDER_ROUTING_SCHEMA_VERSION = 1;

export function migrateSqliteProviderRoutingDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_credential_verification (
      connection_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      credential_revision INTEGER NOT NULL CHECK (credential_revision > 0),
      execution_basis_digest TEXT NOT NULL,
      model_id TEXT NOT NULL CHECK (length(model_id) > 0),
      status TEXT NOT NULL CHECK (status IN ('supported', 'denied')),
      source TEXT NOT NULL CHECK (source IN ('discovered', 'tested')),
      evidence TEXT NOT NULL CHECK (evidence IN ('positive_only', 'authoritative')),
      checked_at INTEGER NOT NULL,
      test_summary_json TEXT,
      PRIMARY KEY (
        connection_id,
        profile_id,
        credential_id,
        credential_revision,
        execution_basis_digest,
        model_id
      )
    );

    CREATE INDEX IF NOT EXISTS provider_credential_verification_basis
      ON provider_credential_verification(
        connection_id,
        profile_id,
        credential_id,
        credential_revision,
        execution_basis_digest
      );

    CREATE TABLE IF NOT EXISTS provider_credential_health (
      connection_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      credential_revision INTEGER NOT NULL CHECK (credential_revision > 0),
      execution_basis_digest TEXT NOT NULL,
      model_id TEXT NOT NULL DEFAULT '',
      circuit_state TEXT NOT NULL CHECK (
        circuit_state IN ('closed', 'open', 'half_open', 'invalid')
      ),
      failure_kind TEXT,
      failure_scope TEXT CHECK (
        failure_scope IS NULL OR failure_scope IN (
          'credential', 'credential_model', 'connection', 'unknown'
        )
      ),
      failure_evidence TEXT CHECK (
        failure_evidence IS NULL OR failure_evidence IN (
          'status', 'header', 'provider_code', 'provider_adapter'
        )
      ),
      blocked_until INTEGER,
      next_probe_at INTEGER,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_failure_at INTEGER,
      last_success_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (
        connection_id,
        profile_id,
        credential_id,
        credential_revision,
        execution_basis_digest,
        model_id
      )
    );

    CREATE INDEX IF NOT EXISTS provider_credential_health_next_probe
      ON provider_credential_health(next_probe_at)
      WHERE next_probe_at IS NOT NULL;

    CREATE INDEX IF NOT EXISTS provider_credential_health_connection
      ON provider_credential_health(connection_id, profile_id);
  `);
}
