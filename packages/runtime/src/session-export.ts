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

/**
 * Export one Session, and the subagent subtree under it, as a portable bundle.
 *
 * The preparation is `exportSessionBundleState()` in `@maka/storage`, which
 * already takes a consistent database snapshot, keeps writers out, filters the
 * copy down to the exported Sessions, carries the context-offload closure, and
 * proves the result with `PRAGMA foreign_key_check`. This module is the thin
 * part: point it at a workspace, ask for a quiescent Session, and seal what
 * comes back with the bundle codec.
 *
 * What it adds on top is the manifest — the Sessions carried, the schema
 * versions the SOURCE database registers, and the connection by slug and model
 * so an importer can resolve it locally. No credential is carried: the state
 * allow-list in the export policy decides what is copied, and configuration is
 * not on it.
 */

import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SessionBundleFileError,
  type OpaqueStateIdentityDescriptor,
  type SessionBundleArtifact,
  type SessionBundleFileErrorDetails,
  type SessionBundleLimits,
} from '@maka/storage/session-bundle-contract';
import type { StorageRootLease } from '@maka/storage/root-authority';
import { createSessionBundleFileService } from '@maka/storage/session-bundle-file-service';
import {
  exportSessionBundleState,
  SessionBundleExportError,
  SESSION_BUNDLE_OMITTED_EVENT_TYPES,
  type SessionBundleExportPlan,
} from '@maka/storage/session-bundle-policy';

export const SESSION_EXPORT_MEDIA_TYPE =
  'application/vnd.maka.session-export+json;version=1' as const;

/** Generous by design; the codec is what enforces them. */
export const SESSION_EXPORT_BUNDLE_LIMITS: SessionBundleLimits = {
  maxCompressedBytes: 2 * 1024 ** 3,
  maxDecompressedTarBytes: 8 * 1024 ** 3,
  maxPayloadBytes: 8 * 1024 ** 3,
  maxFileBytes: 2 * 1024 ** 3,
  maxEntryCount: 1_000_000,
  maxManifestBytes: 4 * 1024 ** 2,
  maxStateIdentityBytes: 4 * 1024 ** 2,
  maxPathBytes: 4096,
  maxPathDepth: 32,
};

export interface SessionExportManifest {
  format: 'maka.session-export';
  formatVersion: 1;
  exportedAt: number;
  rootSessionId: string;
  /** The root Session and its subagent descendants, root first. */
  sessionIds: string[];
  /** Versions the SOURCE database registers, so a later importer reads no fiction. */
  schema: Record<string, number>;
  /** Named for local resolution; no credential is carried. */
  connection: { llmConnectionSlug: string; model: string };
  /** State entries the bundle carries, and the ones the policy left behind. */
  includedEntries: string[];
  excludedEntries: string[];
  diagnosticsOmitted: true;
  omittedEventTypes: readonly string[];
}

export interface ExportSessionBundleInput {
  workspaceRoot: string;
  sessionId: string;
  /** Written only if absent; an existing path is never overwritten. */
  destination: string;
  limits?: SessionBundleLimits;
  now?: () => number;
  /**
   * Storage Root authority the caller already holds.
   *
   * The Runtime Host takes it at startup and holds it for its lifetime, and
   * the lock is an election that refuses a second hold -- so the Host can only
   * do this by lending what it has. A caller with no authority of its own, the
   * CLI included, omits it and the authority is elected as before.
   */
  lease?: StorageRootLease<'interactive', 'write'>;
}

export type ExportSessionBundleFailure =
  | { kind: 'workspace_not_found'; workspaceRoot: string }
  | { kind: 'session_not_found' }
  /** The Session, or one of its descendants, is mid-turn. */
  | { kind: 'session_active'; message: string }
  /** The source database registers a schema this build does not read. */
  | { kind: 'schema_unsupported'; message: string }
  /** An artifact row that does not name a regular file inside the artifact root. */
  | { kind: 'artifact_unsafe'; message: string }
  /** A record names bytes the workspace does not have. */
  | { kind: 'artifact_missing'; message: string }
  | { kind: 'destination_exists' }
  | { kind: 'bundle_limit'; details: SessionBundleFileErrorDetails }
  | { kind: 'io_failed'; message: string };

export type ExportSessionBundleResult =
  | { ok: true; artifact: SessionBundleArtifact; export: SessionExportManifest }
  | { ok: false; reason: ExportSessionBundleFailure };

export async function exportSessionBundle(
  input: ExportSessionBundleInput,
): Promise<ExportSessionBundleResult> {
  if (!(await isDirectory(input.workspaceRoot))) {
    return {
      ok: false,
      reason: { kind: 'workspace_not_found', workspaceRoot: input.workspaceRoot },
    };
  }
  if (await exists(input.destination)) {
    return { ok: false, reason: { kind: 'destination_exists' } };
  }

  const staging = await mkdtemp(join(tmpdir(), 'maka-session-export-'));
  try {
    const stateRoot = join(staging, 'state');
    const workspaceRoot = join(staging, 'workspace');
    // The codec seals a state tree beside a workspace tree. A Session's own
    // files are the state; the user's project directory is not part of the
    // conversation and is deliberately absent.
    await mkdir(workspaceRoot, { recursive: true });

    let plan: SessionBundleExportPlan;
    try {
      plan = await exportSessionBundleState({
        stateRoot: input.workspaceRoot,
        // Maka's desktop layout keeps state and configuration in one directory,
        // so these are shared on purpose. Configuration stays out of the bundle
        // because the policy copies an allow-list of state entries, not because
        // the roots are apart.
        configRoot: input.workspaceRoot,
        allowShared: true,
        destinationRoot: stateRoot,
        sessionId: input.sessionId,
        ...(input.lease ? { lease: input.lease } : {}),
        requireQuiescent: true,
        includeSubtree: true,
        omitDiagnostics: true,
      });
    } catch (error) {
      const failure = asExportFailure(error, input.workspaceRoot);
      if (failure) return { ok: false, reason: failure };
      throw error;
    }

    const manifest: SessionExportManifest = {
      format: 'maka.session-export',
      formatVersion: 1,
      exportedAt: (input.now ?? Date.now)(),
      rootSessionId: plan.sessionId,
      sessionIds: plan.sessionIds,
      schema: plan.sourceSchema,
      connection: plan.connection,
      includedEntries: plan.includedEntries,
      excludedEntries: plan.excludedEntries,
      diagnosticsOmitted: true,
      omittedEventTypes: SESSION_BUNDLE_OMITTED_EVENT_TYPES,
    };
    const stateIdentity: OpaqueStateIdentityDescriptor = {
      mediaType: SESSION_EXPORT_MEDIA_TYPE,
      bytes: Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'),
    };

    const artifact = await createSessionBundleFileService().pack({
      snapshot: { stateRoot, workspaceRoot, stateIdentity },
      envelope: { sessionId: plan.sessionId },
      destination: input.destination,
      limits: input.limits ?? SESSION_EXPORT_BUNDLE_LIMITS,
    });
    return { ok: true, artifact, export: manifest };
  } catch (error) {
    if (error instanceof SessionBundleFileError) {
      if (error.details?.quota !== undefined) {
        return { ok: false, reason: { kind: 'bundle_limit', details: error.details } };
      }
      // The precheck fails fast, but the packer publishes atomically and can
      // still lose the race. Reporting that as a generic IO failure would give
      // a caller a different exit code for the same outcome.
      if (error.code === 'destination_exists') {
        return { ok: false, reason: { kind: 'destination_exists' } };
      }
      return { ok: false, reason: { kind: 'io_failed', message: error.message } };
    }
    const failure = asExportFailure(error, input.workspaceRoot);
    if (failure) return { ok: false, reason: failure };
    return { ok: false, reason: { kind: 'io_failed', message: String(error) } };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

function asExportFailure(
  error: unknown,
  workspaceRoot: string,
): ExportSessionBundleFailure | undefined {
  if (!(error instanceof SessionBundleExportError)) return undefined;
  switch (error.code) {
    case 'session_active':
      return { kind: 'session_active', message: error.message };
    case 'schema_unsupported':
      return { kind: 'schema_unsupported', message: error.message };
    case 'symlink':
    case 'path_escape':
    case 'unsupported_entry':
      return { kind: 'artifact_unsafe', message: error.message };
    case 'missing_entry':
      return { kind: 'artifact_missing', message: error.message };
    case 'invalid_root':
      // The policy reports a missing Session through this code too, and only
      // the message separates it from a directory that is not a workspace.
      return /session does not exist/i.test(error.message)
        ? { kind: 'session_not_found' }
        : { kind: 'workspace_not_found', workspaceRoot };
    case 'destination_not_empty':
      return { kind: 'destination_exists' };
    default:
      return { kind: 'io_failed', message: error.message };
  }
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path)
    .then((metadata) => metadata.isDirectory())
    .catch(() => false);
}

async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}
