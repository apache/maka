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

import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { copyOpaqueStateIdentityDescriptor } from './session-bundle-contract.js';
import type {
  OpaqueStateIdentityDescriptor,
  PreparedSessionBundleSnapshot,
} from './session-bundle-contract.js';
import { isSessionBundleUstarPathV1 } from './session-bundle-ustar.js';
import { createSessionCopyCleanupAuthority } from './session-copy-cleanup.js';
import { isSafeSessionId } from './session-store.js';
import type { ProcessLifetimeOwner } from './process-lifetime-owner.js';

export const SESSION_SNAPSHOT_POLICY_VERSION = 1 as const;
export const SESSION_SNAPSHOT_STAGING_SCHEMA_VERSION = 1 as const;

const SNAPSHOT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SNAPSHOT_CLEANUP_ID_PATTERN =
  /^snapshot-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const CONFIRMATION_GRANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_OWNER_RECORD_BYTES = 1_024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const NO_FOLLOW_OPEN_FLAG = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;

export type SessionSnapshotWorkspaceEntryKind = 'file' | 'directory';

export type SessionSnapshotWorkspaceExclusionCategory =
  | 'dependency_tree'
  | 'source_control'
  | 'cache'
  | 'log'
  | 'runtime_scratch'
  | 'confirmed_secret_path';

export type SessionSnapshotWorkspaceConfirmationCategory = 'suspected_secret_path';

export type SessionSnapshotWorkspaceRejectionCategory =
  | 'known_secret_file'
  | 'unsafe_path'
  | 'unsupported_entry';

export type SessionSnapshotWorkspacePolicyDecision =
  | { readonly kind: 'include' }
  | {
      readonly kind: 'exclude';
      readonly category: SessionSnapshotWorkspaceExclusionCategory;
    }
  | {
      readonly kind: 'confirm';
      readonly category: SessionSnapshotWorkspaceConfirmationCategory;
      /** Normalized topmost directory whose complete subtree the decision covers. */
      readonly confirmationPath: string;
    }
  | {
      readonly kind: 'reject';
      readonly category: SessionSnapshotWorkspaceRejectionCategory;
    };

export interface SessionSnapshotWorkspaceEntry {
  /** Slash-separated relative path supplied without normalization aliases. */
  readonly relativePath: string;
  readonly kind: SessionSnapshotWorkspaceEntryKind;
}

export interface SessionSnapshotWorkspacePolicy {
  readonly version: typeof SESSION_SNAPSHOT_POLICY_VERSION;
  /**
   * Receives normalized relative paths. A preparer must stop descending as
   * soon as a directory is excluded, including by a confirmed exclusion;
   * descendant entries are not counted. A confirmed include permits descent
   * but does not override later high-confidence secret rejections.
   */
  classify(entry: SessionSnapshotWorkspaceEntry): SessionSnapshotWorkspacePolicyDecision;
}

const INCLUDE = Object.freeze({ kind: 'include' } as const);

// This fail-closed rejection set is deliberately narrower than the workspace
// measurement rules introduced by #1353. Snapshot rejection is reserved for
// names that identify known secret material; public certificate encodings and
// other ambiguous formats are not rejected by extension alone.
const PUBLIC_ENV_TEMPLATE_PATTERN = /^\.env\.(?:example|sample|template)$/i;
const KNOWN_SECRET_WORKSPACE_DIRECTORY_NAMES = new Set(['.ssh']);
const SUSPECTED_SECRET_WORKSPACE_DIRECTORY_NAMES = new Set(['credentials', 'private', 'secrets']);
const KNOWN_SECRET_WORKSPACE_FILE_PATTERNS = [
  /^\.env(?:\..*)?$/i,
  /^\.(?:npmrc|netrc|pypirc|terraformrc)$/i,
  /^\.git-credentials(?:\.lock)?$/i,
  /^(?:credentials?|secrets?)(?:\.(?:cfg|conf|ini|json|log|properties|toml|ya?ml))?$/i,
  /(?:^|[-_.])(?:id_(?:rsa|dsa|ecdsa|ed25519)|private[-_.]?key)(?:$|[-_.])/i,
  /^(?:private|privkey)\.pem$/i,
  /\.(?:key|p12|pfx)$/i,
] as const;

/**
 * V1 portable-workspace policy. The coordinator pins this exact policy, while
 * the trusted filesystem preparer is its enforcement point: the coordinator
 * does not re-traverse or attest the prepared destination. The preparer remains
 * responsible for applying every decision and rejecting symlinks, hard links,
 * special files, path races, case conflicts, and quota violations.
 */
export const SESSION_SNAPSHOT_WORKSPACE_POLICY_V1: SessionSnapshotWorkspacePolicy = Object.freeze({
  version: SESSION_SNAPSHOT_POLICY_VERSION,
  classify(entry: SessionSnapshotWorkspaceEntry): SessionSnapshotWorkspacePolicyDecision {
    const decoded = decodeWorkspaceEntry(entry);
    if (decoded.kind === 'reject') return decoded;
    const { segments, basename: name } = decoded;
    const lowerSegments = segments.map((segment) => segment.toLowerCase());
    const lowerName = name.toLowerCase();

    if (lowerSegments.includes('.git')) {
      return { kind: 'exclude', category: 'source_control' };
    }
    if (lowerSegments.includes('node_modules')) {
      return { kind: 'exclude', category: 'dependency_tree' };
    }
    if (
      lowerSegments.includes('.cache') ||
      lowerSegments.includes('.maka-cache') ||
      lowerSegments.includes('.turbo')
    ) {
      return { kind: 'exclude', category: 'cache' };
    }
    if (lowerSegments.includes('.maka-runtime') || lowerSegments.includes('.maka-activation')) {
      return { kind: 'exclude', category: 'runtime_scratch' };
    }
    if (isKnownSecretEntry(entry.kind, lowerSegments, lowerName)) {
      return { kind: 'reject', category: 'known_secret_file' };
    }
    const confirmationPath = findSuspectedSecretDirectoryPath(entry.kind, segments, lowerSegments);
    if (confirmationPath !== undefined) {
      return { kind: 'confirm', category: 'suspected_secret_path', confirmationPath };
    }
    if (
      lowerSegments.includes('logs') ||
      lowerSegments.includes('.logs') ||
      (entry.kind === 'file' && lowerName.endsWith('.log'))
    ) {
      return { kind: 'exclude', category: 'log' };
    }
    return INCLUDE;
  },
});

export interface SessionSnapshotCancellation {
  readonly signal: AbortSignal;
  /** Absolute Unix time in milliseconds. */
  readonly deadlineAt?: number;
}

/**
 * Trusted host/owner authority for one complete Session mutation boundary.
 *
 * Before invoking `operation`, an implementation must stop admitting new
 * mutations for this Maka Session, drain already-admitted state, Artifact and
 * workspace mutations, and reject non-terminal Activations, background
 * processes, pending approvals, and externally resumable actions. It must keep
 * that boundary until `operation` settles, serialize preparations for the same
 * Session, and honor cancellation/deadline while waiting. This interface does
 * not make a process-local mutex authoritative by itself: every real writer
 * must already be governed by the supplied Host/Owner implementation.
 */
export interface SessionSnapshotQuiescenceAuthority {
  runQuiescent<T>(
    input: {
      readonly makaSessionId: string;
      readonly cancellation: SessionSnapshotCancellation;
    },
    operation: () => Promise<T>,
  ): Promise<T>;
}

export interface SessionSnapshotStatePreparer {
  /** Creates the exact, previously absent root and closes every source/destination handle. */
  prepareState(input: {
    readonly makaSessionId: string;
    readonly destinationRoot: string;
    readonly cancellation: SessionSnapshotCancellation;
  }): Promise<OpaqueStateIdentityDescriptor>;
}

export interface SessionSnapshotWorkspacePreparation {
  /** Number of included files and directories, including empty directories. */
  readonly includedEntries: number;
  /** Number of topmost excluded entries; descendants of an excluded directory are not counted. */
  readonly excludedEntries: number;
  /** Bounded audit diagnostics; paths and file contents are deliberately absent. */
  readonly excludedEntriesByCategory: Readonly<
    Record<SessionSnapshotWorkspaceExclusionCategory, number>
  >;
  readonly payloadBytes: number;
}

export type SessionSnapshotWorkspaceConfirmationAction = 'include' | 'exclude';

/**
 * Trusted control-plane lookup for a previously recorded explicit user choice.
 *
 * Implementations must authenticate the principal, verify ownership of the
 * Maka Session, and bind the grant to the exact policy version, normalized
 * confirmation path and current Workspace source revision/digest. Decisions
 * live outside Session state, workspaces, staging roots and Session Bundles.
 * This lookup must not wait for interactive user input while the Session is
 * quiescent; an absent or stale decision returns `undefined` and fails snapshot
 * preparation closed.
 */
export interface SessionSnapshotWorkspaceConfirmationAuthority {
  resolveConfirmation(input: {
    readonly makaSessionId: string;
    readonly confirmationGrantId: string;
    readonly policyVersion: typeof SESSION_SNAPSHOT_POLICY_VERSION;
    readonly category: SessionSnapshotWorkspaceConfirmationCategory;
    readonly confirmationPath: string;
    readonly cancellation: SessionSnapshotCancellation;
  }): Promise<{ readonly action: SessionSnapshotWorkspaceConfirmationAction } | undefined>;
}

export interface SessionSnapshotWorkspaceConfirmationResolver {
  /**
   * Resolves the policy's confirmation decision into a final include/exclude
   * decision. Repeated descendants of one confirmed directory reuse the same
   * control-plane lookup for this preparation.
   */
  resolve(
    entry: SessionSnapshotWorkspaceEntry,
  ): Promise<
    | { readonly kind: 'include' }
    | { readonly kind: 'exclude'; readonly category: 'confirmed_secret_path' }
  >;
}

export interface SessionSnapshotWorkspacePreparer {
  /**
   * Trusted enforcement point for the supplied workspace policy. Creates the
   * exact, previously absent root, applies every policy decision without
   * downgrading it, resolves every `confirm` decision before copying or
   * descending, and closes every source/destination handle. The coordinator
   * validates the returned root and bounded counters, but does not independently
   * traverse the result to prove that the policy was applied.
   */
  prepareWorkspace(input: {
    readonly makaSessionId: string;
    readonly destinationRoot: string;
    readonly policy: SessionSnapshotWorkspacePolicy;
    readonly confirmation: SessionSnapshotWorkspaceConfirmationResolver;
    readonly cancellation: SessionSnapshotCancellation;
  }): Promise<SessionSnapshotWorkspacePreparation>;
}

/**
 * Trusted platform adapter that verifies a staging root is private to the
 * current principal. On Windows this must inspect the effective ACL of both
 * the parent and each newly created snapshot directory; POSIX mode bits are
 * neither available nor an adequate substitute there.
 */
export interface SessionSnapshotPrivateStagingRootAuthority {
  verifyPrivateStagingRoot(input: {
    readonly canonicalPath: string;
  }): Promise<{ readonly canonicalPath: string }>;
}

export interface PrepareQuiescentSessionSnapshotInput {
  readonly makaSessionId: string;
  /** Opaque, control-plane-issued grant; never persisted in the Session Bundle. */
  readonly confirmationGrantId?: string;
  readonly signal?: AbortSignal;
  /** Absolute Unix time in milliseconds. */
  readonly deadlineAt?: number;
}

export interface PreparedSessionBundleHandle {
  readonly snapshot: PreparedSessionBundleSnapshot;
  readonly policyVersion: typeof SESSION_SNAPSHOT_POLICY_VERSION;
  readonly workspace: SessionSnapshotWorkspacePreparation;
  /**
   * Idempotent after successful cleanup; failures remain retryable. Path and
   * identity checks fail closed on replacements observable before deletion, but
   * do not defend against an adversarial same-principal replacement in the final
   * path-based filesystem-operation window.
   */
  release(): Promise<void>;
}

export interface QuiescentSessionSnapshotCoordinator {
  prepare(input: PrepareQuiescentSessionSnapshotInput): Promise<PreparedSessionBundleHandle>;
}

export type SessionSnapshotErrorCode =
  | 'invalid_input'
  | 'snapshot_busy'
  | 'snapshot_cancelled'
  | 'session_not_quiescent'
  | 'source_changed'
  | 'unsafe_source'
  | 'policy_rejected'
  | 'quota_exceeded'
  | 'cleanup_failed'
  | 'io_failure';

export type SessionSnapshotPhase =
  | 'admission'
  | 'staging'
  | 'state'
  | 'workspace'
  | 'publication'
  | 'cleanup';

export interface SessionSnapshotErrorDetails {
  readonly phase?: SessionSnapshotPhase;
  /** Cleanup also failed; the top-level code still classifies the primary failure. */
  readonly cleanupFailed?: true;
  readonly policyCategory?:
    | SessionSnapshotWorkspaceRejectionCategory
    | SessionSnapshotWorkspaceConfirmationCategory;
  readonly limit?: number;
  readonly observed?: number;
}

export interface SessionSnapshotErrorOptions extends ErrorOptions {
  readonly details?: SessionSnapshotErrorDetails;
}

export class SessionSnapshotError extends Error {
  readonly details?: Readonly<SessionSnapshotErrorDetails>;

  constructor(
    readonly code: SessionSnapshotErrorCode,
    message: string,
    options: SessionSnapshotErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SessionSnapshotError';
    if (options.details !== undefined) this.details = Object.freeze({ ...options.details });
  }
}

export interface FileQuiescentSessionSnapshotCoordinatorOptions {
  /**
   * Private control-plane directory outside live state and workspace roots.
   * Code running as the same OS principal and able to mutate this parent is in
   * the trusted computing boundary; Node's path-based recursive removal cannot
   * make an adversarial final-check-to-delete race impossible.
   */
  readonly stagingParent: string;
  readonly quiescence: SessionSnapshotQuiescenceAuthority;
  readonly state: SessionSnapshotStatePreparer;
  readonly workspace: SessionSnapshotWorkspacePreparer;
  /** Persistent owner/recovery authority for every private staging root. */
  readonly stagingCleanup: SessionSnapshotStagingCleanupAuthority;
  /** Optional control-plane lookup; suspected paths fail closed when absent. */
  readonly confirmationAuthority?: SessionSnapshotWorkspaceConfirmationAuthority;
  /** Required on Windows; optional additional verification on POSIX platforms. */
  readonly privateStagingRootAuthority?: SessionSnapshotPrivateStagingRootAuthority;
  readonly now?: () => number;
  readonly newSnapshotId?: () => string;
}

export interface SessionSnapshotStagingLease {
  readonly snapshotId: string;
  readonly ownerToken: string;
  readonly makaSessionId: string;
}

export interface SessionSnapshotStagingCleanupRecovery {
  readonly removed: string[];
  readonly failed: Array<{ readonly snapshotId: string; readonly error: unknown }>;
}

/**
 * Persistent lifetime authority for snapshot staging. Production startup must
 * call `recover()` after acquiring its ProcessLifetimeOwner and before serving
 * snapshot requests.
 */
export interface SessionSnapshotStagingCleanupAuthority {
  /** Absolute staging parent this authority's persisted leases are bound to. */
  readonly stagingParent: string;
  ownCreation<T>(lease: SessionSnapshotStagingLease, operation: () => Promise<T>): Promise<T>;
  cleanup(lease: SessionSnapshotStagingLease): Promise<void>;
  recover(): Promise<SessionSnapshotStagingCleanupRecovery>;
}

/**
 * Reuses the Session-copy persisted cleanup lease engine in a separate
 * operational-state root. The separate root prevents either recovery domain
 * from interpreting and deleting the other domain's resources.
 */
export function createFileSessionSnapshotStagingCleanupAuthority(input: {
  readonly cleanupStateRoot: string;
  readonly stagingParent: string;
  readonly processLifetimeOwner: ProcessLifetimeOwner;
  readonly privateStagingRootAuthority?: SessionSnapshotPrivateStagingRootAuthority;
}): SessionSnapshotStagingCleanupAuthority {
  if (!isAbsolute(input.cleanupStateRoot)) {
    throw new TypeError('Session snapshot cleanupStateRoot must be absolute');
  }
  if (!isAbsolute(input.stagingParent)) {
    throw new TypeError('Session snapshot stagingParent must be absolute');
  }
  return new FileSessionSnapshotStagingCleanupAuthority({
    cleanupStateRoot: resolve(input.cleanupStateRoot),
    stagingParent: resolve(input.stagingParent),
    processLifetimeOwner: input.processLifetimeOwner,
    privateStagingRootAuthority: input.privateStagingRootAuthority,
  });
}

class FileSessionSnapshotStagingCleanupAuthority implements SessionSnapshotStagingCleanupAuthority {
  readonly stagingParent: string;
  readonly #cleanup: ReturnType<typeof createSessionCopyCleanupAuthority>;

  constructor(input: {
    cleanupStateRoot: string;
    stagingParent: string;
    processLifetimeOwner: ProcessLifetimeOwner;
    privateStagingRootAuthority: SessionSnapshotPrivateStagingRootAuthority | undefined;
  }) {
    this.stagingParent = input.stagingParent;
    this.#cleanup = createSessionCopyCleanupAuthority({
      workspaceRoot: input.cleanupStateRoot,
      processLifetimeOwner: input.processLifetimeOwner,
      // A creating snapshot already has enough durable identity to be removed;
      // unlike a Session copy, it has no remote creation protocol to resume.
      resumeSessionCopy: async () => {},
      removeSession: async (cleanupId) => {
        const lease = decodeSnapshotCleanupId(cleanupId);
        await removePersistedSnapshotStaging({
          parent: input.stagingParent,
          snapshotId: lease.snapshotId,
          ownerToken: lease.ownerToken,
          privateRootAuthority: input.privateStagingRootAuthority,
        });
      },
    });
  }

  ownCreation<T>(lease: SessionSnapshotStagingLease, operation: () => Promise<T>): Promise<T> {
    const normalized = normalizeSnapshotStagingLease(lease);
    return this.#cleanup.ownCreation(
      {
        sessionId: encodeSnapshotCleanupId(normalized),
        kind: 'revision',
        sourceSessionId: normalized.makaSessionId,
        sourceTurnId: normalized.snapshotId,
        ownerId: `snapshot:${normalized.ownerToken}`,
      },
      operation,
    );
  }

  cleanup(lease: SessionSnapshotStagingLease): Promise<void> {
    return this.#cleanup.cleanup(encodeSnapshotCleanupId(normalizeSnapshotStagingLease(lease)));
  }

  async recover(): Promise<SessionSnapshotStagingCleanupRecovery> {
    const recovery = await this.#cleanup.recover();
    return {
      removed: recovery.removed.map((cleanupId) => decodeSnapshotCleanupId(cleanupId).snapshotId),
      failed: recovery.failed.map(({ sessionId, error }) => ({
        snapshotId: decodeSnapshotCleanupId(sessionId).snapshotId,
        error,
      })),
    };
  }
}

export function createFileQuiescentSessionSnapshotCoordinator(
  options: FileQuiescentSessionSnapshotCoordinatorOptions,
): QuiescentSessionSnapshotCoordinator {
  return new FileQuiescentSessionSnapshotCoordinator(options);
}

class FileQuiescentSessionSnapshotCoordinator implements QuiescentSessionSnapshotCoordinator {
  readonly #stagingParent: string;
  readonly #stagingCleanup: SessionSnapshotStagingCleanupAuthority;
  readonly #quiescence: SessionSnapshotQuiescenceAuthority;
  readonly #state: SessionSnapshotStatePreparer;
  readonly #workspace: SessionSnapshotWorkspacePreparer;
  readonly #confirmationAuthority: SessionSnapshotWorkspaceConfirmationAuthority | undefined;
  readonly #privateStagingRootAuthority: SessionSnapshotPrivateStagingRootAuthority | undefined;
  readonly #now: () => number;
  readonly #newSnapshotId: () => string;

  constructor(options: FileQuiescentSessionSnapshotCoordinatorOptions) {
    if (!isAbsolute(options.stagingParent)) {
      throw new TypeError('Session snapshot stagingParent must be absolute');
    }
    if ('policy' in options) {
      throw new TypeError('Session snapshot V1 safety policy cannot be overridden');
    }
    this.#stagingParent = resolve(options.stagingParent);
    if (resolve(options.stagingCleanup.stagingParent) !== this.#stagingParent) {
      throw new TypeError('Session snapshot staging cleanup authority is bound to another parent');
    }
    this.#stagingCleanup = options.stagingCleanup;
    this.#quiescence = options.quiescence;
    this.#state = options.state;
    this.#workspace = options.workspace;
    this.#confirmationAuthority = options.confirmationAuthority;
    this.#privateStagingRootAuthority = options.privateStagingRootAuthority;
    this.#now = options.now ?? Date.now;
    this.#newSnapshotId = options.newSnapshotId ?? randomUUID;
  }

  async prepare(input: PrepareQuiescentSessionSnapshotInput): Promise<PreparedSessionBundleHandle> {
    const makaSessionId = requireMakaSessionId(input.makaSessionId);
    const confirmationGrantId = requireOptionalConfirmationGrantId(input.confirmationGrantId);
    const cancellation = createCancellation(input, this.#now);
    let prepared: OwnedPreparedSessionBundleHandle | undefined;
    let stagingLease: SessionSnapshotStagingLease | undefined;
    let stagingLeaseOwned = false;
    let operationStarted = false;
    try {
      cancellation.assertActive();
      const result = await this.#quiescence.runQuiescent(
        { makaSessionId, cancellation: cancellation.value },
        async () => {
          if (operationStarted) {
            throw new SessionSnapshotError(
              'io_failure',
              'Session snapshot quiescence operation was invoked more than once',
              { details: { phase: 'admission' } },
            );
          }
          operationStarted = true;
          cancellation.assertActive();
          stagingLease = {
            snapshotId: requireSnapshotId(this.#newSnapshotId()),
            ownerToken: randomUUID(),
            makaSessionId,
          };
          return this.#stagingCleanup.ownCreation(stagingLease, async () => {
            stagingLeaseOwned = true;
            cancellation.assertActive();
            const staging = await OwnedSnapshotStaging.create(
              this.#stagingParent,
              stagingLease!.snapshotId,
              stagingLease!.ownerToken,
              this.#privateStagingRootAuthority,
            );
            const stateIdentity = copyOpaqueStateIdentityDescriptor(
              await this.#state.prepareState({
                makaSessionId,
                destinationRoot: staging.stateRoot,
                cancellation: cancellation.value,
              }),
            );
            cancellation.assertActive();
            await assertPreparedRoot(staging.stateRoot, 'state');

            const workspace = normalizeWorkspacePreparation(
              await this.#workspace.prepareWorkspace({
                makaSessionId,
                destinationRoot: staging.workspaceRoot,
                policy: SESSION_SNAPSHOT_WORKSPACE_POLICY_V1,
                confirmation: createWorkspaceConfirmationResolver({
                  makaSessionId,
                  confirmationGrantId,
                  authority: this.#confirmationAuthority,
                  cancellation: cancellation.value,
                }),
                cancellation: cancellation.value,
              }),
            );
            cancellation.assertActive();
            await assertPreparedRoot(staging.workspaceRoot, 'workspace');
            cancellation.assertActive();

            const published = await staging.publish();
            cancellation.assertActive();
            const handle = new OwnedPreparedSessionBundleHandle(
              published,
              stateIdentity,
              workspace,
              SESSION_SNAPSHOT_POLICY_VERSION,
              this.#stagingCleanup,
              stagingLease!,
            );
            prepared = handle;
            return handle;
          });
        },
      );
      cancellation.assertActive();
      if (!prepared || result !== prepared) {
        throw new SessionSnapshotError(
          'io_failure',
          'Session snapshot quiescence operation did not return its prepared handle',
          { details: { phase: 'admission' } },
        );
      }
      return result;
    } catch (error) {
      const primaryError = normalizePreparationError(error);
      if (prepared || (stagingLease && stagingLeaseOwned)) {
        try {
          if (prepared) await prepared.release();
          else await this.#stagingCleanup.cleanup(stagingLease!);
        } catch (cleanupError) {
          throw primaryErrorWithCleanupFailure(primaryError, cleanupError);
        }
      }
      throw primaryError;
    } finally {
      cancellation.close();
    }
  }
}

interface SnapshotOwnerRecord {
  readonly schemaVersion: typeof SESSION_SNAPSHOT_STAGING_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly ownerToken: string;
  readonly rootDev: string;
  readonly rootIno: string;
}

interface FilesystemIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface SnapshotOwnerBinding {
  readonly path: string;
  readonly cleanupPath: string;
  readonly record: SnapshotOwnerRecord;
  readonly identity: FilesystemIdentity;
}

interface PublishedSnapshotStaging {
  readonly parent: string;
  readonly root: string;
  readonly cleanupRoot: string;
  readonly stateRoot: string;
  readonly workspaceRoot: string;
  readonly owner: SnapshotOwnerBinding;
  readonly identity: FilesystemIdentity;
}

class OwnedSnapshotStaging {
  readonly stateRoot: string;
  readonly workspaceRoot: string;
  readonly #preparingRoot: string;
  readonly #publishedRoot: string;
  readonly #cleanupRoot: string;
  readonly #ownerFile: string;
  readonly #ownerCleanupFile: string;
  readonly #snapshotId: string;
  readonly #ownerToken: string;
  #owner: SnapshotOwnerBinding | undefined;
  #identity: FilesystemIdentity | undefined;
  #published = false;

  private constructor(parent: string, snapshotId: string, ownerToken: string) {
    this.#preparingRoot = join(parent, `.snapshot-${snapshotId}.preparing`);
    this.#publishedRoot = join(parent, `snapshot-${snapshotId}`);
    this.#cleanupRoot = join(parent, `.snapshot-${snapshotId}.${ownerToken}.cleanup`);
    this.#ownerFile = join(parent, `.snapshot-${snapshotId}.owner.json`);
    this.#ownerCleanupFile = join(parent, `.snapshot-${snapshotId}.${ownerToken}.owner-cleanup`);
    this.#snapshotId = snapshotId;
    this.#ownerToken = ownerToken;
    this.stateRoot = join(this.#preparingRoot, 'state');
    this.workspaceRoot = join(this.#preparingRoot, 'workspace');
  }

  static async create(
    parent: string,
    snapshotId: string,
    ownerToken: string,
    privateRootAuthority: SessionSnapshotPrivateStagingRootAuthority | undefined,
  ): Promise<OwnedSnapshotStaging> {
    const canonicalParent = await preparePrivateStagingParent(parent, privateRootAuthority);
    const staging = new OwnedSnapshotStaging(canonicalParent, snapshotId, ownerToken);
    let rootCreated = false;
    try {
      await assertMissing(staging.#preparingRoot);
      await assertMissing(staging.#publishedRoot);
      await assertMissing(staging.#cleanupRoot);
      await assertMissing(staging.#ownerCleanupFile);
      await mkdir(staging.#preparingRoot, { mode: 0o700 });
      rootCreated = true;
      staging.#identity = await readDirectoryIdentity(staging.#preparingRoot);
      try {
        await verifyPrivateStagingDirectory(staging.#preparingRoot, privateRootAuthority);
      } catch (verificationError) {
        throw new SessionSnapshotError('unsafe_source', 'Session snapshot staging root is unsafe', {
          cause: verificationError,
          details: { phase: 'staging' },
        });
      }
      const record: SnapshotOwnerRecord = {
        schemaVersion: SESSION_SNAPSHOT_STAGING_SCHEMA_VERSION,
        snapshotId: staging.#snapshotId,
        ownerToken: staging.#ownerToken,
        rootDev: staging.#identity.dev.toString(),
        rootIno: staging.#identity.ino.toString(),
      };
      staging.#owner = await writeOwnerRecord(
        staging.#ownerFile,
        staging.#ownerCleanupFile,
        record,
      );
      return staging;
    } catch (error) {
      const primaryError = normalizeStagingCreationError(error);
      if (rootCreated && staging.#identity) {
        try {
          await removeDirectoryBoundToIdentity({
            parent: canonicalParent,
            root: staging.#preparingRoot,
            cleanupRoot: staging.#cleanupRoot,
            identity: staging.#identity,
          });
        } catch (cleanupError) {
          throw primaryErrorWithCleanupFailure(primaryError, cleanupError);
        }
      } else if (rootCreated) {
        throw primaryErrorWithCleanupFailure(
          primaryError,
          new Error('Snapshot root identity is unavailable'),
        );
      }
      throw primaryError;
    }
  }

  async publish(): Promise<PublishedSnapshotStaging> {
    if (this.#published) {
      throw new SessionSnapshotError(
        'io_failure',
        'Session snapshot staging is already published',
        {
          details: { phase: 'publication' },
        },
      );
    }
    try {
      if (!this.#identity || !this.#owner) {
        throw new Error('Snapshot ownership is unavailable');
      }
      await assertOwnedRoot(this.#preparingRoot, this.#owner, this.#identity);
      await rename(this.#preparingRoot, this.#publishedRoot);
      this.#published = true;
      const identity = await readDirectoryIdentity(this.#publishedRoot);
      if (!sameFilesystemIdentity(identity, this.#identity)) {
        throw new Error('Published root identity changed');
      }
      await assertOwnerRecord(this.#owner);
      return {
        parent: dirname(this.#publishedRoot),
        root: this.#publishedRoot,
        cleanupRoot: this.#cleanupRoot,
        stateRoot: join(this.#publishedRoot, 'state'),
        workspaceRoot: join(this.#publishedRoot, 'workspace'),
        owner: this.#owner,
        identity,
      };
    } catch (error) {
      throw new SessionSnapshotError('io_failure', 'Unable to publish Session snapshot staging', {
        cause: error,
        details: { phase: 'publication' },
      });
    }
  }
}

class OwnedPreparedSessionBundleHandle implements PreparedSessionBundleHandle {
  readonly snapshot: PreparedSessionBundleSnapshot;
  readonly workspace: SessionSnapshotWorkspacePreparation;
  readonly policyVersion: typeof SESSION_SNAPSHOT_POLICY_VERSION;
  readonly #stagingCleanup: SessionSnapshotStagingCleanupAuthority;
  readonly #stagingLease: SessionSnapshotStagingLease;
  #releaseTask: Promise<void> | undefined;
  #released = false;

  constructor(
    staging: PublishedSnapshotStaging,
    stateIdentity: OpaqueStateIdentityDescriptor,
    workspace: SessionSnapshotWorkspacePreparation,
    policyVersion: typeof SESSION_SNAPSHOT_POLICY_VERSION,
    stagingCleanup: SessionSnapshotStagingCleanupAuthority,
    stagingLease: SessionSnapshotStagingLease,
  ) {
    this.#stagingCleanup = stagingCleanup;
    this.#stagingLease = stagingLease;
    this.snapshot = Object.freeze({
      stateRoot: staging.stateRoot,
      workspaceRoot: staging.workspaceRoot,
      stateIdentity: Object.freeze(copyOpaqueStateIdentityDescriptor(stateIdentity)),
    });
    this.workspace = Object.freeze({ ...workspace });
    this.policyVersion = policyVersion;
  }

  async release(): Promise<void> {
    if (this.#released) return;
    if (this.#releaseTask) return this.#releaseTask;
    const task = this.#releaseOnce();
    this.#releaseTask = task;
    try {
      await task;
      this.#released = true;
    } finally {
      if (!this.#released) this.#releaseTask = undefined;
    }
  }

  async #releaseOnce(): Promise<void> {
    try {
      await this.#stagingCleanup.cleanup(this.#stagingLease);
    } catch (error) {
      throw cleanupFailure(error);
    }
  }
}

function decodeWorkspaceEntry(
  entry: SessionSnapshotWorkspaceEntry,
):
  | { readonly kind: 'valid'; readonly segments: readonly string[]; readonly basename: string }
  | { readonly kind: 'reject'; readonly category: 'unsafe_path' | 'unsupported_entry' } {
  if (entry.kind !== 'file' && entry.kind !== 'directory') {
    return { kind: 'reject', category: 'unsupported_entry' };
  }
  if (
    typeof entry.relativePath !== 'string' ||
    entry.relativePath.length === 0 ||
    entry.relativePath.includes('\\') ||
    entry.relativePath.includes('\0') ||
    entry.relativePath.startsWith('/') ||
    entry.relativePath.endsWith('/')
  ) {
    return { kind: 'reject', category: 'unsafe_path' };
  }
  const segments = entry.relativePath.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return { kind: 'reject', category: 'unsafe_path' };
  }
  const bundlePath = `workspace/${entry.relativePath}${entry.kind === 'directory' ? '/' : ''}`;
  if (!isSessionBundleUstarPathV1(bundlePath)) {
    return { kind: 'reject', category: 'unsafe_path' };
  }
  return { kind: 'valid', segments, basename: segments.at(-1)! };
}

function isKnownSecretEntry(
  kind: SessionSnapshotWorkspaceEntryKind,
  lowerSegments: readonly string[],
  lowerName: string,
): boolean {
  if (lowerSegments.some((segment) => KNOWN_SECRET_WORKSPACE_DIRECTORY_NAMES.has(segment))) {
    return true;
  }
  if (kind === 'directory') return false;
  if (PUBLIC_ENV_TEMPLATE_PATTERN.test(lowerName) || lowerName.endsWith('.pub')) return false;
  if (KNOWN_SECRET_WORKSPACE_FILE_PATTERNS.some((pattern) => pattern.test(lowerName))) return true;
  if (lowerName === 'service-account.json' || lowerName === 'service-account-key.json') {
    return true;
  }
  return (
    (lowerSegments.at(-2) === '.docker' && lowerName === 'config.json') ||
    (lowerSegments.at(-2) === '.kube' && lowerName === 'config') ||
    (lowerSegments.at(-2) === 'gcloud' &&
      lowerSegments.at(-3) === '.config' &&
      lowerName === 'application_default_credentials.json')
  );
}

function findSuspectedSecretDirectoryPath(
  kind: SessionSnapshotWorkspaceEntryKind,
  segments: readonly string[],
  lowerSegments: readonly string[],
): string | undefined {
  const directorySegmentCount =
    kind === 'directory' ? lowerSegments.length : lowerSegments.length - 1;
  const index = lowerSegments
    .slice(0, directorySegmentCount)
    .findIndex((segment) => SUSPECTED_SECRET_WORKSPACE_DIRECTORY_NAMES.has(segment));
  return index < 0 ? undefined : segments.slice(0, index + 1).join('/');
}

function createWorkspaceConfirmationResolver(input: {
  readonly makaSessionId: string;
  readonly confirmationGrantId: string | undefined;
  readonly authority: SessionSnapshotWorkspaceConfirmationAuthority | undefined;
  readonly cancellation: SessionSnapshotCancellation;
}): SessionSnapshotWorkspaceConfirmationResolver {
  const resolutions = new Map<
    string,
    Promise<
      | { readonly kind: 'include' }
      | { readonly kind: 'exclude'; readonly category: 'confirmed_secret_path' }
    >
  >();

  return Object.freeze({
    resolve(entry: SessionSnapshotWorkspaceEntry) {
      const decision = SESSION_SNAPSHOT_WORKSPACE_POLICY_V1.classify(entry);
      if (decision.kind !== 'confirm') {
        throw new TypeError('Workspace entry does not require control-plane confirmation');
      }
      const key = `${decision.category}\0${decision.confirmationPath}`;
      const existing = resolutions.get(key);
      if (existing !== undefined) return existing;
      const resolution = resolveWorkspaceConfirmation({
        ...input,
        category: decision.category,
        confirmationPath: decision.confirmationPath,
      });
      resolutions.set(key, resolution);
      return resolution;
    },
  });
}

async function resolveWorkspaceConfirmation(input: {
  readonly makaSessionId: string;
  readonly confirmationGrantId: string | undefined;
  readonly authority: SessionSnapshotWorkspaceConfirmationAuthority | undefined;
  readonly category: SessionSnapshotWorkspaceConfirmationCategory;
  readonly confirmationPath: string;
  readonly cancellation: SessionSnapshotCancellation;
}): Promise<
  | { readonly kind: 'include' }
  | { readonly kind: 'exclude'; readonly category: 'confirmed_secret_path' }
> {
  input.cancellation.signal.throwIfAborted();
  if (input.confirmationGrantId === undefined) throw confirmationRequired(input.category);
  if (input.authority === undefined) throw confirmationRequired(input.category);
  const resolution = await input.authority.resolveConfirmation({
    makaSessionId: input.makaSessionId,
    confirmationGrantId: input.confirmationGrantId,
    policyVersion: SESSION_SNAPSHOT_POLICY_VERSION,
    category: input.category,
    confirmationPath: input.confirmationPath,
    cancellation: input.cancellation,
  });
  input.cancellation.signal.throwIfAborted();
  if (resolution === undefined) throw confirmationRequired(input.category);
  if (resolution.action === 'include') return INCLUDE;
  if (resolution.action === 'exclude') {
    return { kind: 'exclude', category: 'confirmed_secret_path' };
  }
  throw new SessionSnapshotError(
    'io_failure',
    'Session snapshot control-plane confirmation is invalid',
    { details: { phase: 'workspace' } },
  );
}

function confirmationRequired(
  category: SessionSnapshotWorkspaceConfirmationCategory,
): SessionSnapshotError {
  return new SessionSnapshotError(
    'policy_rejected',
    'Session snapshot requires an explicit control-plane confirmation',
    { details: { phase: 'workspace', policyCategory: category } },
  );
}

function requireMakaSessionId(value: unknown): string {
  if (typeof value !== 'string' || !isSafeSessionId(value)) {
    throw new SessionSnapshotError('invalid_input', 'Maka Session identity is invalid', {
      details: { phase: 'admission' },
    });
  }
  return value;
}

function requireOptionalConfirmationGrantId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !CONFIRMATION_GRANT_ID_PATTERN.test(value)) {
    throw new SessionSnapshotError(
      'invalid_input',
      'Session snapshot confirmation grant identity is invalid',
      { details: { phase: 'admission' } },
    );
  }
  return value;
}

function requireSnapshotId(value: unknown): string {
  if (typeof value !== 'string' || !SNAPSHOT_ID_PATTERN.test(value)) {
    throw new SessionSnapshotError('io_failure', 'Session snapshot identity allocation failed', {
      details: { phase: 'staging' },
    });
  }
  return value;
}

function normalizeSnapshotStagingLease(
  value: SessionSnapshotStagingLease,
): SessionSnapshotStagingLease {
  return Object.freeze({
    snapshotId: requireSnapshotId(value.snapshotId),
    ownerToken: requireSnapshotOwnerToken(value.ownerToken),
    makaSessionId: requireMakaSessionId(value.makaSessionId),
  });
}

function requireSnapshotOwnerToken(value: unknown): string {
  if (typeof value !== 'string' || !SNAPSHOT_ID_PATTERN.test(value)) {
    throw new SessionSnapshotError('io_failure', 'Session snapshot owner identity is invalid', {
      details: { phase: 'staging' },
    });
  }
  return value;
}

function encodeSnapshotCleanupId(lease: SessionSnapshotStagingLease): string {
  return `snapshot-${lease.snapshotId}-${lease.ownerToken}`;
}

function decodeSnapshotCleanupId(cleanupId: string): {
  readonly snapshotId: string;
  readonly ownerToken: string;
} {
  const match = SNAPSHOT_CLEANUP_ID_PATTERN.exec(cleanupId);
  if (!match) throw new Error('Invalid Session snapshot cleanup identity');
  return { snapshotId: match[1]!, ownerToken: match[2]! };
}

function normalizeWorkspacePreparation(
  value: SessionSnapshotWorkspacePreparation,
): SessionSnapshotWorkspacePreparation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SessionSnapshotError('io_failure', 'Workspace snapshot result is invalid', {
      details: { phase: 'workspace' },
    });
  }
  for (const count of [value.includedEntries, value.excludedEntries, value.payloadBytes]) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new SessionSnapshotError('io_failure', 'Workspace snapshot result is invalid', {
        details: { phase: 'workspace' },
      });
    }
  }
  const excludedEntriesByCategory = normalizeExclusionCounts(value.excludedEntriesByCategory);
  const categorizedExclusions = Object.values(excludedEntriesByCategory).reduce(
    (total, count) => total + count,
    0,
  );
  if (categorizedExclusions !== value.excludedEntries) {
    throw new SessionSnapshotError('io_failure', 'Workspace snapshot result is invalid', {
      details: { phase: 'workspace' },
    });
  }
  return {
    includedEntries: value.includedEntries,
    excludedEntries: value.excludedEntries,
    excludedEntriesByCategory,
    payloadBytes: value.payloadBytes,
  };
}

const WORKSPACE_EXCLUSION_CATEGORIES = [
  'dependency_tree',
  'source_control',
  'cache',
  'log',
  'runtime_scratch',
  'confirmed_secret_path',
] as const satisfies readonly SessionSnapshotWorkspaceExclusionCategory[];

function normalizeExclusionCounts(
  value: Readonly<Record<SessionSnapshotWorkspaceExclusionCategory, number>>,
): Readonly<Record<SessionSnapshotWorkspaceExclusionCategory, number>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SessionSnapshotError('io_failure', 'Workspace snapshot result is invalid', {
      details: { phase: 'workspace' },
    });
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== WORKSPACE_EXCLUSION_CATEGORIES.length ||
    keys.some(
      (key) =>
        !WORKSPACE_EXCLUSION_CATEGORIES.includes(key as SessionSnapshotWorkspaceExclusionCategory),
    )
  ) {
    throw new SessionSnapshotError('io_failure', 'Workspace snapshot result is invalid', {
      details: { phase: 'workspace' },
    });
  }
  const normalized = Object.fromEntries(
    WORKSPACE_EXCLUSION_CATEGORIES.map((category) => {
      const count = record[category];
      if (!Number.isSafeInteger(count) || (count as number) < 0) {
        throw new SessionSnapshotError('io_failure', 'Workspace snapshot result is invalid', {
          details: { phase: 'workspace' },
        });
      }
      return [category, count];
    }),
  ) as Record<SessionSnapshotWorkspaceExclusionCategory, number>;
  return Object.freeze(normalized);
}

function createCancellation(
  input: PrepareQuiescentSessionSnapshotInput,
  now: () => number,
): {
  readonly value: SessionSnapshotCancellation;
  assertActive(): void;
  close(): void;
} {
  if (
    input.deadlineAt !== undefined &&
    (!Number.isSafeInteger(input.deadlineAt) || input.deadlineAt < 0)
  ) {
    throw new SessionSnapshotError('invalid_input', 'Session snapshot deadline is invalid', {
      details: { phase: 'admission' },
    });
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  let timeout: NodeJS.Timeout | undefined;
  const scheduleDeadline = () => {
    if (input.deadlineAt === undefined) return;
    const remaining = input.deadlineAt - now();
    if (remaining <= 0) {
      abort();
      return;
    }
    timeout = setTimeout(scheduleDeadline, Math.min(remaining, MAX_TIMER_DELAY_MS));
    timeout.unref();
  };
  const remaining = input.deadlineAt === undefined ? undefined : input.deadlineAt - now();
  if (remaining !== undefined && remaining > 0) scheduleDeadline();
  if (input.signal?.aborted || (remaining !== undefined && remaining <= 0)) abort();
  const value = Object.freeze({
    signal: controller.signal,
    ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
  });
  return {
    value,
    assertActive: () => {
      if (controller.signal.aborted) {
        throw new SessionSnapshotError(
          'snapshot_cancelled',
          'Session snapshot preparation was cancelled',
          { details: { phase: 'admission' } },
        );
      }
    },
    close: () => {
      if (timeout) clearTimeout(timeout);
      input.signal?.removeEventListener('abort', abort);
    },
  };
}

async function preparePrivateStagingParent(
  path: string,
  authority: SessionSnapshotPrivateStagingRootAuthority | undefined,
): Promise<string> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const canonical = await realpath(path);
    await verifyPrivateStagingDirectory(canonical, authority);
    return canonical;
  } catch (error) {
    throw new SessionSnapshotError('unsafe_source', 'Session snapshot staging root is unsafe', {
      cause: error,
      details: { phase: 'staging' },
    });
  }
}

async function verifyPrivateStagingDirectory(
  path: string,
  authority: SessionSnapshotPrivateStagingRootAuthority | undefined,
): Promise<void> {
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error('Staging directory is not canonical');
  const info = await lstat(canonical, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Staging parent is invalid');
  if (process.platform === 'win32' && !authority) {
    throw new Error('A Windows ACL verifier is required for the staging parent');
  }
  if (process.platform !== 'win32') {
    const permissions = Number(info.mode & 0o777n);
    if ((permissions & 0o077) !== 0) {
      throw new Error('Staging parent is accessible outside its owner');
    }
    const currentUserId = process.getuid?.();
    if (currentUserId !== undefined && info.uid !== BigInt(currentUserId)) {
      throw new Error('Staging parent has a different filesystem owner');
    }
  }
  if (authority) {
    const verification = await authority.verifyPrivateStagingRoot({ canonicalPath: canonical });
    if (
      !verification ||
      typeof verification.canonicalPath !== 'string' ||
      verification.canonicalPath !== canonical
    ) {
      throw new Error('Staging parent privacy verification was bound to a different path');
    }
  }
}

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  throw new Error('Snapshot staging identity already exists');
}

async function writeOwnerRecord(
  path: string,
  cleanupPath: string,
  record: SnapshotOwnerRecord,
): Promise<SnapshotOwnerBinding> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let identity: FilesystemIdentity | undefined;
  let failure: unknown;
  try {
    handle = await open(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW_OPEN_FLAG,
      0o600,
    );
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) {
      throw new Error('Snapshot ownership record is not a private file');
    }
    identity = { dev: info.dev, ino: info.ino };
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    if (process.platform !== 'win32') await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    failure = error;
  }
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error]);
    }
  }
  if (!identity) {
    if (failure !== undefined) throw failure;
    throw new Error('Snapshot ownership record identity is unavailable');
  }
  const binding = { path, cleanupPath, record, identity };
  if (failure === undefined) {
    try {
      await assertOwnerRecord(binding);
      return binding;
    } catch (error) {
      failure = error;
    }
  }
  try {
    await removeFileBoundToIdentity({
      parent: dirname(path),
      root: path,
      cleanupRoot: cleanupPath,
      identity,
    });
  } catch (cleanupError) {
    const primaryError = new SessionSnapshotError(
      'io_failure',
      'Unable to write Session snapshot ownership record',
      { cause: failure, details: { phase: 'staging' } },
    );
    throw primaryErrorWithCleanupFailure(primaryError, cleanupError);
  }
  throw failure;
}

async function assertPreparedRoot(path: string, label: 'state' | 'workspace'): Promise<void> {
  let info;
  try {
    info = await lstat(path, { bigint: true });
  } catch (error) {
    throw new SessionSnapshotError('io_failure', `Prepared ${label} snapshot is unavailable`, {
      cause: error,
      details: { phase: label },
    });
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new SessionSnapshotError('unsafe_source', `Prepared ${label} snapshot is unsafe`, {
      details: { phase: label },
    });
  }
}

async function assertOwnerRecord(
  binding: SnapshotOwnerBinding,
  path = binding.path,
): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW_OPEN_FLAG);
  try {
    const info = await handle.stat({ bigint: true });
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1n ||
      info.size > BigInt(MAX_OWNER_RECORD_BYTES) ||
      !sameFilesystemIdentity({ dev: info.dev, ino: info.ino }, binding.identity)
    ) {
      throw new Error('Snapshot ownership record is invalid');
    }
    const value = JSON.parse(await handle.readFile('utf8')) as unknown;
    if (!sameOwnerRecord(value, binding.record)) {
      throw new Error('Snapshot ownership record changed');
    }
  } finally {
    await handle.close();
  }
  const pathIdentity = await readFileIdentity(path);
  if (!sameFilesystemIdentity(pathIdentity, binding.identity)) {
    throw new Error('Snapshot ownership record path changed');
  }
}

async function assertOwnedRoot(
  root: string,
  owner: SnapshotOwnerBinding,
  identity: FilesystemIdentity,
): Promise<void> {
  const actual = await readDirectoryIdentity(root);
  if (!sameFilesystemIdentity(actual, identity)) {
    throw new Error('Published Session snapshot root identity changed');
  }
  if (
    owner.record.rootDev !== identity.dev.toString() ||
    owner.record.rootIno !== identity.ino.toString()
  ) {
    throw new Error('Snapshot ownership record is bound to another root');
  }
  await assertOwnerRecord(owner);
}

async function removeOwnedSnapshotDirectory(input: {
  parent: string;
  root: string;
  cleanupRoot: string;
  owner: SnapshotOwnerBinding;
  identity: FilesystemIdentity;
}): Promise<void> {
  if (
    dirname(input.root) !== input.parent ||
    dirname(input.cleanupRoot) !== input.parent ||
    dirname(input.owner.path) !== input.parent ||
    dirname(input.owner.cleanupPath) !== input.parent ||
    input.root === input.cleanupRoot
  ) {
    throw new Error('Session snapshot cleanup path escaped its owner');
  }
  const cleanupIdentity = await readOptionalDirectoryIdentity(input.cleanupRoot);
  const rootIdentity = await readOptionalDirectoryIdentity(input.root);
  if (!cleanupIdentity && !rootIdentity) {
    await removeOwnerRecord(input.owner);
    return;
  }
  await assertOwnerRecord(input.owner);
  if (cleanupIdentity) {
    if (rootIdentity) {
      throw new Error('Session snapshot cleanup paths conflict');
    }
    if (!sameFilesystemIdentity(cleanupIdentity, input.identity)) {
      throw new Error('Session snapshot cleanup root identity changed');
    }
    await assertOwnedRoot(input.cleanupRoot, input.owner, input.identity);
    await rm(input.cleanupRoot, { recursive: true, force: false });
    await removeOwnerRecord(input.owner);
    return;
  }
  await assertOwnedRoot(input.root, input.owner, input.identity);
  await rename(input.root, input.cleanupRoot);
  await assertOwnedRoot(input.cleanupRoot, input.owner, input.identity);
  await rm(input.cleanupRoot, { recursive: true, force: false });
  await removeOwnerRecord(input.owner);
}

async function removePersistedSnapshotStaging(input: {
  parent: string;
  snapshotId: string;
  ownerToken: string;
  privateRootAuthority: SessionSnapshotPrivateStagingRootAuthority | undefined;
}): Promise<void> {
  const parent = await preparePrivateStagingParent(input.parent, input.privateRootAuthority);
  const preparingRoot = join(parent, `.snapshot-${input.snapshotId}.preparing`);
  const publishedRoot = join(parent, `snapshot-${input.snapshotId}`);
  const cleanupRoot = join(parent, `.snapshot-${input.snapshotId}.${input.ownerToken}.cleanup`);
  const owner = await readPersistedSnapshotOwnerBinding({
    parent,
    snapshotId: input.snapshotId,
    ownerToken: input.ownerToken,
  });
  const [preparingIdentity, publishedIdentity, cleanupIdentity] = await Promise.all([
    readOptionalDirectoryIdentity(preparingRoot),
    readOptionalDirectoryIdentity(publishedRoot),
    readOptionalDirectoryIdentity(cleanupRoot),
  ]);

  if (preparingIdentity && publishedIdentity) {
    throw new Error('Session snapshot staging has conflicting preparation and publication roots');
  }
  if (!owner) {
    if (publishedIdentity) {
      throw new Error('Published Session snapshot has no ownership record');
    }
    if (preparingIdentity && cleanupIdentity) {
      throw new Error('Unbound Session snapshot cleanup paths conflict');
    }
    const identity = preparingIdentity ?? cleanupIdentity;
    if (!identity) return;
    // The persisted ProcessLifetimeOwner lease authenticates this exact UUID
    // during the small create-to-owner-record crash window.
    await removeDirectoryBoundToIdentity({
      parent,
      root: preparingRoot,
      cleanupRoot,
      identity,
    });
    return;
  }

  const identity = snapshotRootIdentity(owner.record);
  await removeOwnedSnapshotDirectory({
    parent,
    root: preparingIdentity ? preparingRoot : publishedIdentity ? publishedRoot : preparingRoot,
    cleanupRoot,
    owner,
    identity,
  });
}

async function readPersistedSnapshotOwnerBinding(input: {
  parent: string;
  snapshotId: string;
  ownerToken: string;
}): Promise<SnapshotOwnerBinding | undefined> {
  const path = join(input.parent, `.snapshot-${input.snapshotId}.owner.json`);
  const cleanupPath = join(
    input.parent,
    `.snapshot-${input.snapshotId}.${input.ownerToken}.owner-cleanup`,
  );
  const [pathIdentity, cleanupIdentity] = await Promise.all([
    readOptionalFileIdentity(path),
    readOptionalFileIdentity(cleanupPath),
  ]);
  if (pathIdentity && cleanupIdentity) {
    throw new Error('Snapshot ownership cleanup paths conflict');
  }
  const identity = pathIdentity ?? cleanupIdentity;
  if (!identity) return undefined;
  const actualPath = pathIdentity ? path : cleanupPath;
  const handle = await open(actualPath, fsConstants.O_RDONLY | NO_FOLLOW_OPEN_FLAG);
  let record: SnapshotOwnerRecord;
  try {
    const info = await handle.stat({ bigint: true });
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1n ||
      info.size > BigInt(MAX_OWNER_RECORD_BYTES) ||
      !sameFilesystemIdentity({ dev: info.dev, ino: info.ino }, identity)
    ) {
      throw new Error('Snapshot ownership record is invalid');
    }
    const value = JSON.parse(await handle.readFile('utf8')) as unknown;
    if (!isSnapshotOwnerRecord(value, input.snapshotId, input.ownerToken)) {
      throw new Error('Snapshot ownership record changed');
    }
    record = value;
  } finally {
    await handle.close();
  }
  const currentIdentity = await readFileIdentity(actualPath);
  if (!sameFilesystemIdentity(currentIdentity, identity)) {
    throw new Error('Snapshot ownership record path changed');
  }
  return { path, cleanupPath, record, identity };
}

function isSnapshotOwnerRecord(
  value: unknown,
  snapshotId: string,
  ownerToken: string,
): value is SnapshotOwnerRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 5 &&
    record.schemaVersion === SESSION_SNAPSHOT_STAGING_SCHEMA_VERSION &&
    record.snapshotId === snapshotId &&
    record.ownerToken === ownerToken &&
    typeof record.rootDev === 'string' &&
    /^(?:0|[1-9][0-9]*)$/u.test(record.rootDev) &&
    typeof record.rootIno === 'string' &&
    /^(?:0|[1-9][0-9]*)$/u.test(record.rootIno)
  );
}

function snapshotRootIdentity(record: SnapshotOwnerRecord): FilesystemIdentity {
  return { dev: BigInt(record.rootDev), ino: BigInt(record.rootIno) };
}

async function removeOwnerRecord(owner: SnapshotOwnerBinding): Promise<void> {
  const cleanupIdentity = await readOptionalFileIdentity(owner.cleanupPath);
  const ownerIdentity = await readOptionalFileIdentity(owner.path);
  if (cleanupIdentity) {
    if (ownerIdentity) throw new Error('Snapshot ownership cleanup paths conflict');
    if (!sameFilesystemIdentity(cleanupIdentity, owner.identity)) {
      throw new Error('Snapshot ownership cleanup file changed');
    }
    await assertOwnerRecord(owner, owner.cleanupPath);
    await rm(owner.cleanupPath, { force: false });
    return;
  }
  if (!ownerIdentity) return;
  if (!sameFilesystemIdentity(ownerIdentity, owner.identity)) {
    throw new Error('Snapshot ownership record path changed');
  }
  await assertOwnerRecord(owner);
  await rename(owner.path, owner.cleanupPath);
  await assertOwnerRecord(owner, owner.cleanupPath);
  await rm(owner.cleanupPath, { force: false });
}

async function removeDirectoryBoundToIdentity(input: {
  parent: string;
  root: string;
  cleanupRoot: string;
  identity: FilesystemIdentity;
}): Promise<void> {
  if (
    dirname(input.root) !== input.parent ||
    dirname(input.cleanupRoot) !== input.parent ||
    input.root === input.cleanupRoot
  ) {
    throw new Error('Session snapshot cleanup path escaped its owner');
  }
  const cleanupIdentity = await readOptionalDirectoryIdentity(input.cleanupRoot);
  const rootIdentity = await readOptionalDirectoryIdentity(input.root);
  if (cleanupIdentity) {
    if (rootIdentity) throw new Error('Session snapshot cleanup paths conflict');
    if (!sameFilesystemIdentity(cleanupIdentity, input.identity)) {
      throw new Error('Session snapshot cleanup root identity changed');
    }
    await rm(input.cleanupRoot, { recursive: true, force: false });
    return;
  }
  if (!rootIdentity) return;
  if (!sameFilesystemIdentity(rootIdentity, input.identity)) {
    throw new Error('Session snapshot root identity changed');
  }
  await rename(input.root, input.cleanupRoot);
  const renamedIdentity = await readDirectoryIdentity(input.cleanupRoot);
  if (!sameFilesystemIdentity(renamedIdentity, input.identity)) {
    throw new Error('Session snapshot cleanup root identity changed');
  }
  await rm(input.cleanupRoot, { recursive: true, force: false });
}

async function removeFileBoundToIdentity(input: {
  parent: string;
  root: string;
  cleanupRoot: string;
  identity: FilesystemIdentity;
}): Promise<void> {
  if (
    dirname(input.root) !== input.parent ||
    dirname(input.cleanupRoot) !== input.parent ||
    input.root === input.cleanupRoot
  ) {
    throw new Error('Session snapshot file cleanup path escaped its owner');
  }
  const cleanupIdentity = await readOptionalFileIdentity(input.cleanupRoot);
  const rootIdentity = await readOptionalFileIdentity(input.root);
  if (cleanupIdentity) {
    if (rootIdentity) throw new Error('Session snapshot file cleanup paths conflict');
    if (!sameFilesystemIdentity(cleanupIdentity, input.identity)) {
      throw new Error('Session snapshot file cleanup identity changed');
    }
    await rm(input.cleanupRoot, { force: false });
    return;
  }
  if (!rootIdentity) return;
  if (!sameFilesystemIdentity(rootIdentity, input.identity)) {
    throw new Error('Session snapshot file identity changed');
  }
  await rename(input.root, input.cleanupRoot);
  const renamedIdentity = await readFileIdentity(input.cleanupRoot);
  if (!sameFilesystemIdentity(renamedIdentity, input.identity)) {
    throw new Error('Session snapshot file cleanup identity changed');
  }
  await rm(input.cleanupRoot, { force: false });
}

async function readOptionalDirectoryIdentity(
  path: string,
): Promise<FilesystemIdentity | undefined> {
  try {
    return await readDirectoryIdentity(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function readOptionalFileIdentity(path: string): Promise<FilesystemIdentity | undefined> {
  try {
    return await readFileIdentity(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function readDirectoryIdentity(path: string): Promise<FilesystemIdentity> {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Session snapshot root is not a directory');
  }
  return { dev: info.dev, ino: info.ino };
}

async function readFileIdentity(path: string): Promise<FilesystemIdentity> {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) {
    throw new Error('Session snapshot ownership record is not a private file');
  }
  return { dev: info.dev, ino: info.ino };
}

function sameFilesystemIdentity(left: FilesystemIdentity, right: FilesystemIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameOwnerRecord(value: unknown, expected: SnapshotOwnerRecord): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 5 &&
    record.schemaVersion === expected.schemaVersion &&
    record.snapshotId === expected.snapshotId &&
    record.ownerToken === expected.ownerToken &&
    record.rootDev === expected.rootDev &&
    record.rootIno === expected.rootIno
  );
}

function normalizePreparationError(error: unknown): SessionSnapshotError {
  if (error instanceof SessionSnapshotError) return error;
  if (isAbortError(error)) {
    return new SessionSnapshotError(
      'snapshot_cancelled',
      'Session snapshot preparation was cancelled',
      { details: { phase: 'admission' } },
    );
  }
  return new SessionSnapshotError('io_failure', 'Session snapshot preparation failed', {
    cause: error,
  });
}

function normalizeStagingCreationError(error: unknown): SessionSnapshotError {
  if (error instanceof SessionSnapshotError) return error;
  return new SessionSnapshotError('io_failure', 'Unable to create Session snapshot staging', {
    cause: error,
    details: { phase: 'staging' },
  });
}

function primaryErrorWithCleanupFailure(
  primaryError: SessionSnapshotError,
  cleanupError: unknown,
): SessionSnapshotError {
  return new SessionSnapshotError(primaryError.code, primaryError.message, {
    cause: new AggregateError([primaryError, cleanupError]),
    details: { ...primaryError.details, cleanupFailed: true },
  });
}

function cleanupFailure(cause: unknown): SessionSnapshotError {
  return new SessionSnapshotError('cleanup_failed', 'Session snapshot cleanup failed', {
    cause,
    details: { phase: 'cleanup' },
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}
