import { createHash, randomUUID } from 'node:crypto';
import {
  appendApprovedLocalMemoryEntryDraft,
  appendLocalMemoryProposalDraft,
  approveLocalMemoryProposalDraft,
  buildLocalMemoryPromptBody,
  defaultLocalMemoryMarkdown,
  findLocalMemoryEntryDraft,
  parseLocalMemoryMarkdown,
  rejectLocalMemoryProposalDraft,
  setLocalMemoryEntryStatusDraft,
  stableLocalMemoryEntryId,
  stableLocalMemoryProposalId,
  type Sha256Digest,
} from '@maka/core/local-memory';
import { redactSecrets } from '@maka/core/redaction';
import type { RuntimePolicySnapshot } from '@maka/core/runtime-policy';
import {
  authenticateInteractiveMemoryBundleStoreWriter,
  MemoryBundleBackupRevisionConflictError,
  MemoryBundleBackupNotFoundError,
  MemoryBundleRevisionConflictError,
  MemoryBundleStoreError,
  type InteractiveMemoryBundleStoreWriter,
  type MemoryBundleMutationResult,
  type MemoryBundleSnapshot,
  type MemoryDocumentSnapshot,
  type MemoryRevision,
} from '@maka/storage/memory-bundle-store';
import {
  authenticateRuntimePolicyStoresWriter,
  RuntimePolicyStoreError,
  type RuntimePolicyStoresWriter,
} from '@maka/storage/runtime-policy-stores';
import {
  type MemoryMutateInput,
  type MemoryMutateResult,
  type MemoryQueryInput,
  type MemoryQueryResult,
  type MemoryScopeInput,
  type OperationOutcome,
} from '../protocol/index.js';
import { MemoryProjectionError, projectMemoryQuery } from './memory-projection.js';
import type { ConnectionContext, MemoryOperationHandlerMap } from './operation-dispatcher.js';
import { RuntimePolicyActivationGate } from './runtime-policy-activation-gate.js';
import { ConnectionBoundChunkUploads } from './connection-bound-chunk-uploads.js';

const PENDING_DOCUMENT_DEFAULT = '# Maka Pending Memory\n';
const nodeSha256: Sha256Digest = {
  digest(input: string): Uint8Array {
    return new Uint8Array(createHash('sha256').update(input, 'utf8').digest());
  },
};
const MAX_ACTIVE_UPLOADS = 8;
const MAX_STAGED_UPLOAD_BYTES = 1024 * 1024;
const UPLOAD_TTL_MS = 5 * 60 * 1000;

export interface HostMemoryPromptProjection {
  readonly bundleRevision: MemoryRevision | null;
  readonly memoryRevision: MemoryRevision | null;
  readonly body?: string;
}

export interface HostMemoryCoordinatorDeps {
  readonly store: InteractiveMemoryBundleStoreWriter;
  readonly runtimePolicyStores: RuntimePolicyStoresWriter;
  readonly activation: RuntimePolicyActivationGate;
  readonly requestDrain?: () => void;
  readonly now?: () => number;
  readonly newId?: () => string;
}

interface MemoryUploadMetadata {
  readonly expectedRevision: MemoryRevision;
  readonly contentSha256: MemoryRevision;
}

/** Canonical Runtime Host authority for the transparent Memory bundle. */
export class HostMemoryCoordinator {
  readonly handlers: MemoryOperationHandlerMap = {
    'memory.query': (input) => this.#query(input),
    'memory.mutate': (input, context) => this.#mutate(input, context),
  };

  readonly #store: InteractiveMemoryBundleStoreWriter;
  readonly #runtimePolicyStores: RuntimePolicyStoresWriter;
  readonly #activation: RuntimePolicyActivationGate;
  readonly #requestDrain: () => void;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #uploads: ConnectionBoundChunkUploads<MemoryUploadMetadata>;
  readonly #acceptedMutations = new Set<Promise<void>>();
  #policyAccess: 'enabled' | 'disabled' | 'incognito_active' | undefined;
  #draining = false;
  #uploadCleanupTask: Promise<void> | undefined;

  constructor(deps: HostMemoryCoordinatorDeps) {
    this.#store = authenticateInteractiveMemoryBundleStoreWriter(deps.store);
    this.#runtimePolicyStores = authenticateRuntimePolicyStoresWriter(deps.runtimePolicyStores);
    this.#activation = deps.activation;
    this.#requestDrain = deps.requestDrain ?? (() => {});
    this.#now = deps.now ?? Date.now;
    this.#newId = deps.newId ?? randomUUID;
    this.#uploads = new ConnectionBoundChunkUploads(
      {
        maxActive: MAX_ACTIVE_UPLOADS,
        maxStagedBytes: MAX_STAGED_UPLOAD_BYTES,
        ttlMs: UPLOAD_TTL_MS,
      },
      this.#now,
    );
  }

  async recover(): Promise<void> {
    await this.#activation.runMutation(() => this.#refreshForCurrentPolicy());
  }

  /**
   * Refreshes Memory while the caller already owns the shared policy mutation
   * boundary. Calling this from another activation would invert the gate.
   */
  async refreshAfterPolicyMutation(): Promise<void> {
    await this.#refreshForCurrentPolicy();
  }

  beginDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    this.#uploadCleanupTask = Promise.all([...this.#acceptedMutations]).then(() => {
      this.#uploads.clear();
    });
  }

  async close(): Promise<void> {
    this.beginDrain();
    await this.#uploadCleanupTask;
  }

  releaseConnection(connectionId: string): void {
    this.#uploads.releaseConnection(connectionId);
  }

  readPromptProjection(
    sessionId: string,
    policy: RuntimePolicySnapshot,
  ): Promise<HostMemoryPromptProjection> {
    return this.#activation.runReadActivation(async () => {
      if (
        policy.policy.privacy.incognitoActive ||
        !policy.policy.memory.enabled ||
        !policy.policy.memory.agentReadEnabled
      ) {
        return {
          bundleRevision: null,
          memoryRevision: null,
        };
      }
      const snapshot = await this.#store.read();
      if (snapshot.memory.kind !== 'document') {
        return {
          bundleRevision: snapshot.revision,
          memoryRevision: snapshot.memory.revision,
        };
      }
      const content = decodeDocument(snapshot.memory);
      const body = buildLocalMemoryPromptBody(content, { sessionId });
      return {
        bundleRevision: snapshot.revision,
        memoryRevision: snapshot.memory.revision,
        ...(body ? { body } : {}),
      };
    });
  }

  async #query(input: MemoryQueryInput): Promise<OperationOutcome<'memory.query'>> {
    if (this.#draining) return hostDraining();
    try {
      return await this.#activation.runReadActivation(async () => {
        const policy = await this.#runtimePolicyStores.runtimePolicy.getSnapshot();
        const blocked = blockedByPolicy(policy.policy);
        if (blocked) return { ok: true, result: blocked };
        const snapshot = await this.#store.read();
        const backups = input.kind === 'state' ? await this.#store.listBackups() : [];
        return {
          ok: true,
          result: projectMemoryQuery(
            input,
            snapshot,
            policy.policy.memory.agentReadEnabled,
            backups,
          ),
        };
      });
    } catch (error) {
      return memoryQueryFailure(error);
    }
  }

  async #mutate(
    input: MemoryMutateInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'memory.mutate'>> {
    if (this.#draining) return hostDraining();
    const accepted = this.#activation.runMutation(async () => {
      try {
        this.#uploads.sweepExpired();
        const policy = await this.#runtimePolicyStores.runtimePolicy.getSnapshot();
        const blocked = blockedByPolicy(policy.policy);
        if (blocked) {
          this.releaseConnection(context.connectionId);
          return { ok: true, result: { kind: 'rejected', reason: blocked.reason } } as const;
        }
        return await this.#mutateAllowed(input, context);
      } catch (error) {
        return await this.#mutationFailure(error);
      }
    });
    this.#trackAcceptedMutation(accepted);
    try {
      return await accepted;
    } catch (error) {
      if (error instanceof RuntimePolicyStoreError) return persistenceMutationFailure();
      throw error;
    }
  }

  async #mutateAllowed(
    input: MemoryMutateInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'memory.mutate'>> {
    switch (input.kind) {
      case 'replace_begin':
        return this.#beginReplace(input, context);
      case 'replace_chunk':
        return this.#acceptChunk(input, context);
      case 'replace_abort':
        return this.#abortReplace(input.uploadId, context);
      case 'replace_commit':
        return this.#commitReplace(input.uploadId, context);
      default:
        return this.#commitSemantic(input);
    }
  }

  async #beginReplace(
    input: Extract<MemoryMutateInput, { kind: 'replace_begin' }>,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'memory.mutate'>> {
    const snapshot = await this.#store.read();
    if (snapshot.revision !== input.expectedRevision) {
      return revisionConflict(input.expectedRevision, snapshot.revision);
    }
    const uploadId = this.#newId();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uploadId)) {
      throw new Error('Memory upload id generator returned an invalid or duplicate id');
    }
    const opened = this.#uploads.open(uploadId, context, input.totalBytes, {
      expectedRevision: input.expectedRevision,
      contentSha256: input.contentSha256,
    });
    if (opened.kind === 'capacity_exhausted') return rejected('upload_conflict');
    if (opened.kind === 'owned_existing' || opened.kind === 'identity_conflict') {
      throw new Error('Memory upload id generator returned an invalid or duplicate id');
    }
    return { ok: true, result: { kind: 'upload_opened', uploadId, nextOffset: 0 } };
  }

  #acceptChunk(
    input: Extract<MemoryMutateInput, { kind: 'replace_chunk' }>,
    context: ConnectionContext,
  ): OperationOutcome<'memory.mutate'> {
    const chunk = Buffer.from(input.chunkBase64, 'base64');
    const accepted = this.#uploads.accept(input.uploadId, context, input.offset, chunk);
    if (accepted.kind === 'not_found') return rejected('upload_not_found');
    if (accepted.kind === 'conflict') return rejected('upload_conflict');
    return {
      ok: true,
      result: {
        kind: 'chunk_accepted',
        uploadId: input.uploadId,
        nextOffset: accepted.nextOffset,
      },
    };
  }

  #abortReplace(uploadId: string, context: ConnectionContext): OperationOutcome<'memory.mutate'> {
    this.#uploads.abort(uploadId, context);
    return { ok: true, result: { kind: 'upload_aborted', uploadId } };
  }

  async #commitReplace(
    uploadId: string,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'memory.mutate'>> {
    const consumed = this.#uploads.consumeComplete(uploadId, context);
    if (consumed.kind === 'not_found') return rejected('upload_not_found');
    if (consumed.kind === 'incomplete') return rejected('upload_incomplete');
    const upload = consumed.upload;
    if (revision(upload.bytes) !== upload.metadata.contentSha256)
      return rejected('invalid_content');

    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(upload.bytes);
    } catch {
      return rejected('invalid_content');
    }
    const redacted = redactSecrets(content);
    const parsed = parseLocalMemoryMarkdown(redacted);
    if (parsed.safeMode)
      return rejected(parsed.reason === 'oversize' ? 'oversize' : 'invalid_content');

    const snapshot = await this.#store.read();
    if (snapshot.revision !== upload.metadata.expectedRevision) {
      return revisionConflict(upload.metadata.expectedRevision, snapshot.revision);
    }
    if (snapshot.pending.kind === 'safe_mode') return rejected('safe_mode');
    return this.#commitBundle({
      expectedRevision: upload.metadata.expectedRevision,
      memory: encodeText(redacted),
      pending: documentBytesOrNull(snapshot.pending),
      backup: 'save',
    });
  }

  async #commitSemantic(
    input: Exclude<
      MemoryMutateInput,
      { kind: 'replace_begin' | 'replace_chunk' | 'replace_commit' | 'replace_abort' }
    >,
  ): Promise<OperationOutcome<'memory.mutate'>> {
    const snapshot = await this.#store.read();
    if (snapshot.revision !== input.expectedRevision) {
      return revisionConflict(input.expectedRevision, snapshot.revision);
    }
    if (input.kind === 'restore_backup') {
      if (snapshot.pending.kind === 'safe_mode') return rejected('safe_mode');
      const result = await this.#store.restoreBackup({
        expectedRevision: input.expectedRevision,
        expectedBackupRevision: input.expectedBackupRevision,
        kind: input.backupKind,
      });
      return { ok: true, result: projectMutationResult(result) };
    }
    if (
      snapshot.pending.kind === 'safe_mode' ||
      (snapshot.memory.kind === 'safe_mode' && input.kind !== 'reset')
    ) {
      return rejected('safe_mode');
    }

    const now = this.#now();
    const memory =
      snapshot.memory.kind === 'missing'
        ? defaultLocalMemoryMarkdown(nodeSha256, now)
        : memoryText(snapshot);
    const pending = pendingText(snapshot);
    switch (input.kind) {
      case 'propose': {
        const content = redactSecrets(input.content);
        const result = appendLocalMemoryProposalDraft(pending, {
          proposalId: stableLocalMemoryProposalId(content, now, nodeSha256),
          title: input.title,
          content,
          ...projectScope(input.scope),
          ...(input.sourceTurnId ? { sourceTurnId: input.sourceTurnId } : {}),
          proposedAt: now,
        });
        if (!result.ok) return rejected(projectDraftRejection(result.reason));
        return this.#commitBundle({
          expectedRevision: input.expectedRevision,
          memory: encodeText(memory),
          pending: encodeText(redactSecrets(result.draft)),
        });
      }
      case 'remember': {
        const content = redactSecrets(input.content);
        const result = appendApprovedLocalMemoryEntryDraft(memory, {
          id: stableLocalMemoryEntryId(content, now, nodeSha256),
          title: input.title,
          content,
          source: 'user_authored',
          ...projectScope(input.scope),
          confirmedAt: now,
          approvalSurface: 'manual_editor_save',
        });
        if (!result.ok) return rejected(projectDraftRejection(result.reason));
        return this.#commitBundle({
          expectedRevision: input.expectedRevision,
          memory: encodeText(redactSecrets(result.draft)),
          pending: documentBytesOrNull(snapshot.pending),
          backup: 'save',
        });
      }
      case 'approve': {
        const proposal = findLocalMemoryEntryDraft(pending, input.proposalId);
        if (!proposal) return rejected('not_found');
        const content = redactSecrets(proposal.content);
        const result = approveLocalMemoryProposalDraft(memory, pending, {
          proposalId: input.proposalId,
          entryId: stableLocalMemoryEntryId(content, now, nodeSha256),
          confirmedAt: now,
          approvalSurface: 'settings_review_queue',
        });
        if (!result.ok) return rejected(projectDraftRejection(result.reason));
        return this.#commitBundle({
          expectedRevision: input.expectedRevision,
          memory: encodeText(redactSecrets(result.memoryDraft)),
          pending: encodeText(redactSecrets(result.pendingDraft)),
          backup: 'save',
        });
      }
      case 'reject': {
        const result = rejectLocalMemoryProposalDraft(pending, {
          proposalId: input.proposalId,
          rejectedAt: now,
        });
        if (!result.ok) return rejected(projectDraftRejection(result.reason));
        return this.#commitBundle({
          expectedRevision: input.expectedRevision,
          memory: encodeText(memory),
          pending: encodeText(redactSecrets(result.draft)),
        });
      }
      case 'set_status': {
        const result = setLocalMemoryEntryStatusDraft(memory, {
          id: input.entryId,
          status: input.status,
          now,
          ...(input.archiveReason ? { archiveReason: input.archiveReason } : {}),
          recordLifecycleMetadata: true,
        });
        if (!result.ok) return rejected(projectDraftRejection(result.reason));
        return this.#commitBundle({
          expectedRevision: input.expectedRevision,
          memory: encodeText(redactSecrets(result.draft)),
          pending: documentBytesOrNull(snapshot.pending),
          backup: 'save',
        });
      }
      case 'reset':
        return this.#commitBundle({
          expectedRevision: input.expectedRevision,
          memory: encodeText(defaultLocalMemoryMarkdown(nodeSha256, now)),
          pending: documentBytesOrNull(snapshot.pending),
          backup: 'reset',
        });
    }
  }

  async #commitBundle(input: {
    readonly expectedRevision: MemoryRevision;
    readonly memory: Uint8Array;
    readonly pending: Uint8Array | null;
    readonly backup?: 'save' | 'reset';
  }): Promise<OperationOutcome<'memory.mutate'>> {
    const result = await this.#store.commit(input);
    return { ok: true, result: projectMutationResult(result) };
  }

  async #mutationFailure(error: unknown): Promise<OperationOutcome<'memory.mutate'>> {
    if (error instanceof MemoryBundleBackupNotFoundError) {
      return rejected('backup_not_found');
    }
    if (error instanceof MemoryBundleBackupRevisionConflictError) {
      return {
        ok: true,
        result: {
          kind: 'backup_revision_conflict',
          backupKind: error.kind,
          expectedRevision: error.expectedRevision,
          actualRevision: error.actualRevision,
        },
      };
    }
    if (error instanceof MemoryBundleRevisionConflictError) {
      return revisionConflict(error.expectedRevision, error.actual.revision);
    }
    if (!(error instanceof MemoryBundleStoreError)) throw error;
    if (error.code === 'commit_outcome_unknown') {
      this.#requestDrain();
      this.#activation.poison();
      return {
        ok: false,
        error: {
          code: 'commit_outcome_unknown',
          message: 'Memory bundle commit outcome is unknown',
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'persistence_failed',
        message: 'Memory bundle persistence failed',
      },
    };
  }

  #trackAcceptedMutation(operation: Promise<unknown>): void {
    const completion = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#acceptedMutations.add(completion);
    void completion.then(() => {
      this.#acceptedMutations.delete(completion);
    });
  }

  async #refreshForCurrentPolicy(): Promise<void> {
    const policy = await this.#runtimePolicyStores.runtimePolicy.getSnapshot();
    const access = policy.policy.privacy.incognitoActive
      ? 'incognito_active'
      : policy.policy.memory.enabled
        ? 'enabled'
        : 'disabled';
    if (access === this.#policyAccess) return;
    this.#uploads.clear();
    if (access === 'enabled') {
      const snapshot = await this.#store.read();
      if (snapshot.memory.kind === 'missing' && snapshot.pending.kind !== 'safe_mode') {
        await this.#store.commit({
          expectedRevision: snapshot.revision,
          memory: encodeText(defaultLocalMemoryMarkdown(nodeSha256, this.#now())),
          pending: documentBytesOrNull(snapshot.pending),
        });
      }
    }
    this.#policyAccess = access;
  }
}

function blockedByPolicy(policy: {
  readonly memory: { readonly enabled: boolean };
  readonly privacy: { readonly incognitoActive: boolean };
}): Extract<MemoryQueryResult, { kind: 'blocked' }> | undefined {
  if (policy.privacy.incognitoActive) return { kind: 'blocked', reason: 'incognito_active' };
  if (!policy.memory.enabled) return { kind: 'blocked', reason: 'disabled' };
  return undefined;
}

function projectMutationResult(result: MemoryBundleMutationResult): MemoryMutateResult {
  return {
    kind: result.changed ? 'committed' : 'unchanged',
    revision: result.snapshot.revision,
    memoryRevision: result.snapshot.memory.revision,
    pendingRevision: result.snapshot.pending.revision,
  };
}

function projectScope(scope: MemoryScopeInput): {
  readonly scope: 'workspace' | 'session';
  readonly sessionId?: string;
} {
  return scope.kind === 'workspace'
    ? { scope: 'workspace' }
    : { scope: 'session', sessionId: scope.sessionId };
}

function projectDraftRejection(
  reason: string,
): 'invalid_content' | 'invalid_scope' | 'not_found' | 'not_pending' | 'oversize' {
  switch (reason) {
    case 'invalid_session_id':
      return 'invalid_scope';
    case 'not_found':
      return 'not_found';
    case 'not_pending':
      return 'not_pending';
    case 'oversize':
      return 'oversize';
    default:
      return 'invalid_content';
  }
}

function memoryText(snapshot: MemoryBundleSnapshot): string {
  return snapshot.memory.kind === 'document' ? decodeDocument(snapshot.memory) : '';
}

function pendingText(snapshot: MemoryBundleSnapshot): string {
  return snapshot.pending.kind === 'document'
    ? decodeDocument(snapshot.pending)
    : PENDING_DOCUMENT_DEFAULT;
}

function decodeDocument(document: Extract<MemoryDocumentSnapshot, { kind: 'document' }>): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(document.bytes);
}

function documentBytesOrNull(document: MemoryDocumentSnapshot): Uint8Array | null {
  if (document.kind === 'missing') return null;
  if (document.kind === 'document') return document.bytes;
  throw new MemoryBundleStoreError('invalid_document', 'Safe-mode document bytes are unavailable');
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function revision(bytes: Uint8Array): MemoryRevision {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function revisionConflict(
  expectedRevision: MemoryRevision,
  actualRevision: MemoryRevision,
): OperationOutcome<'memory.mutate'> {
  return {
    ok: true,
    result: { kind: 'revision_conflict', expectedRevision, actualRevision },
  };
}

function rejected(
  reason: Extract<MemoryMutateResult, { kind: 'rejected' }>['reason'],
): OperationOutcome<'memory.mutate'> {
  return { ok: true, result: { kind: 'rejected', reason } };
}

function hostDraining(): {
  readonly ok: false;
  readonly error: { readonly code: 'host_draining'; readonly message: string };
} {
  return {
    ok: false,
    error: { code: 'host_draining', message: 'Runtime Host is draining' },
  };
}

function memoryQueryFailure(error: unknown): OperationOutcome<'memory.query'> {
  if (error instanceof MemoryProjectionError) {
    return {
      ok: false,
      error: { code: 'invalid_request', message: error.message },
    };
  }
  if (error instanceof MemoryBundleStoreError || error instanceof RuntimePolicyStoreError) {
    return {
      ok: false,
      error: { code: 'persistence_failed', message: 'Memory bundle persistence failed' },
    };
  }
  throw error;
}

function persistenceMutationFailure(): OperationOutcome<'memory.mutate'> {
  return {
    ok: false,
    error: { code: 'persistence_failed', message: 'Memory policy persistence failed' },
  };
}
