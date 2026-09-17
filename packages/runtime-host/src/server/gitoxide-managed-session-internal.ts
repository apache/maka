/* Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file distributed with this
 * work for additional information regarding copyright ownership. The ASF
 * licenses this file to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { isThinkingLevel, type ThinkingLevel } from '@maka/core/model-thinking';
import { isSessionStartModeLabel } from '@maka/core/session-start-mode';
import {
  decodeSessionCreateInput,
  SESSION_CATALOG_LABEL_MAX_ITEMS,
  SESSION_CATALOG_LABEL_MAX_BYTES,
} from '../protocol/session-catalog.js';
import { requireEntityId } from '../protocol/codec.js';
import type { MakaTool, ToolRuntimeInput } from '@maka/runtime/tool-runtime';
import type { RuntimeCommitSink } from '@maka/runtime/runtime-commit-sink';
import type { RuntimeContinuationSafetySource } from '@maka/runtime/runtime-resume';
import { readPage, readParameters, resolveReadInput } from '@maka/runtime/read-page';
import {
  openInteractiveExecutionStoresForWrite,
  type InteractiveExecutionStoresWriter,
} from '@maka/storage/execution-stores';
import { createGitoxideWorkspaceBaselineOwnerInternal } from './gitoxide-workspace-baseline-owner-internal.js';
import { prepareGitoxideRuntimeMutationInternal } from './gitoxide-runtime-mutation-internal.js';
import {
  readGitoxideTreeFileInternal,
  admitGitoxideRepositoryInternal,
  importAdmittedGitoxideRepositoryInternal,
  verifyAdmittedGitoxideImportInternal,
} from './gitoxide-repository-admission-authority-internal.js';
import { runWithStorageRootLease, type StorageRootLease } from '@maka/storage/root-authority';

export interface GitoxideManagedSessionCapability {
  readonly kind: 'gitoxide_managed_files_session';
}

type ReopenInput = Parameters<
  ReturnType<typeof createGitoxideWorkspaceBaselineOwnerInternal>['reopen']
>[0];
type Prepare = NonNullable<ToolRuntimeInput['prepareManagedMutation']>;
interface SessionExecution {
  readonly inspectContinuation: (
    source: RuntimeContinuationSafetySource,
    abortSignal?: AbortSignal,
  ) => Promise<{ ref: string; restored: true; runtimeEventHighWater: number }>;
  readonly projectTools: (tools: readonly MakaTool[]) => readonly MakaTool[];
  readonly sessionId: string;
  readonly runtimeCommitSink: RuntimeCommitSink;
  readonly prepareManagedMutation: Prepare;
  readonly readAcceptedFile: (
    path: string,
    abortSignal?: AbortSignal,
  ) => ReturnType<typeof readGitoxideTreeFileInternal>;
}
const sessions = new WeakMap<GitoxideManagedSessionCapability, SessionExecution>();
const creations = new WeakMap<object, Promise<unknown>>();

export async function reopenGitoxideManagedTaskInternal(
  lease: StorageRootLease<'interactive', 'write'>,
  input: Pick<
    ManagedSessionCreateInput,
    'sessionId' | 'invocationOwnerToken' | 'helperCapability' | 'abortSignal'
  >,
): Promise<GitoxideManagedSessionCapability> {
  input = { ...input };
  return runWithStorageRootLease(lease, 'interactive', 'write', async (root) => {
    input.abortSignal?.throwIfAborted();
    const repositoryPath = managedTaskRepositoryPath(root, input.sessionId);
    const stores = await openInteractiveExecutionStoresForWrite(lease);
    const header = await stores.sessionStore.readHeader(input.sessionId);
    if (
      header.id !== input.sessionId ||
      header.toolProfile !== 'managed-files-v1' ||
      header.executorId
    )
      throw new Error('Session is not a managed files task');
    const capability = await openGitoxideManagedSessionInternal(stores, {
      ...input,
      repositoryPath,
      workspaceKey: input.sessionId,
    });
    const current = await stores.sessionStore.readHeader(input.sessionId);
    if (current.toolProfile !== header.toolProfile || current.executorId !== header.executorId)
      throw new Error('Managed task mode changed during reopening');
    input.abortSignal?.throwIfAborted();
    return capability;
  });
}

function managedTaskRepositoryPath(root: string, sessionId: string): string {
  if (
    typeof sessionId !== 'string' ||
    !sessionId.trim() ||
    sessionId.includes('\0') ||
    Buffer.byteLength(sessionId) > 1024
  )
    throw new Error('Invalid managed session identity');
  return join(root, `managed-files-${createHash('sha256').update(sessionId).digest('hex')}.git`);
}

/** Only the Host startup phase, before task admission, may consume this entry. */
export async function recoverGitoxideManagedTaskCandidatesInternal(
  lease: StorageRootLease<'interactive', 'write'>,
  original: Pick<
    ManagedSessionCreateInput,
    'sessionId' | 'invocationOwnerToken' | 'helperCapability'
  >,
): Promise<readonly { operationId: string; state: 'settled' | 'parked' }[]> {
  const input = { ...original };
  return runWithStorageRootLease(lease, 'interactive', 'write', async (root) => {
    const stores = await openInteractiveExecutionStoresForWrite(lease);
    const header = await stores.sessionStore.readHeader(input.sessionId);
    if (
      header.id !== input.sessionId ||
      header.toolProfile !== 'managed-files-v1' ||
      header.executorId
    )
      throw new Error('Startup candidate recovery requires a managed files task');
    const pending = await stores.runtimeEventStore.listUnsettledToolOperations(input.sessionId);
    const owner = createGitoxideWorkspaceBaselineOwnerInternal(stores);
    const results: { operationId: string; state: 'settled' | 'parked' }[] = [];
    for (const operation of pending) {
      if (operation.recoveryMode !== 'reconcile' || !['Write', 'Edit'].includes(operation.toolName))
        continue;
      try {
        const acceptedRepositoryOwnerToken = {};
        const acceptedRepositoryCapability = await owner.reopen({
          workspaceKey: input.sessionId,
          repositoryPath: managedTaskRepositoryPath(root, input.sessionId),
          invocationOwnerToken: input.invocationOwnerToken,
          helperCapability: input.helperCapability,
          acceptedRepositoryOwnerToken,
        });
        const current = await stores.sessionStore.readHeader(input.sessionId);
        if (current.toolProfile !== header.toolProfile || current.executorId !== header.executorId)
          throw new Error('Managed task mode changed during recovery');
        await owner.recoverCandidate({
          workspaceKey: input.sessionId,
          sessionId: input.sessionId,
          runId: operation.runId,
          operationId: operation.operationId,
          acceptedRepositoryOwnerToken,
          acceptedRepositoryCapability,
        });
        results.push({ operationId: operation.operationId, state: 'settled' });
      } catch {
        // No fallback, reservation release, candidate creation or tool retry.
        // The ledger remains the authority even if a commit response was lost.
        results.push({ operationId: operation.operationId, state: 'parked' });
      }
    }
    return results;
  });
}

export function createGitoxideManagedTaskInternal(
  lease: StorageRootLease<'interactive', 'write'>,
  input: Omit<ManagedSessionCreateInput, 'repositoryPath'>,
): Promise<{ readonly created: boolean; readonly capability: GitoxideManagedSessionCapability }> {
  return createBoundManagedTask(lease, input);
}

/** Consume a durable catalog preparation; callers cannot replace its resolved inputs. */
export async function publishPreparedGitoxideManagedTaskInternal(
  lease: StorageRootLease<'interactive', 'write'>,
  input: Pick<
    ManagedSessionCreateInput,
    'sessionId' | 'invocationOwnerToken' | 'helperCapability' | 'abortSignal'
  > & { readonly requestFingerprint: string },
): Promise<void> {
  input = { ...input };
  if (!/^sha256:[0-9a-f]{64}$/.test(input.requestFingerprint))
    throw new Error('Invalid managed creation request fingerprint');
  const fingerprint = input.requestFingerprint as `sha256:${string}`;
  await runWithStorageRootLease(lease, 'interactive', 'write', async () => {
    const stores = await openInteractiveExecutionStoresForWrite(lease);
    const prepared = await stores.sessionStore.readPreparedStableSessionCreate(
      input.sessionId,
      input.requestFingerprint,
    );
    if (prepared.kind !== 'prepared')
      throw new Error('Managed publication requires a prepared creation');
    const header = prepared.header;
    if (
      !header.cwd ||
      !header.llmConnectionId ||
      header.toolProfile !== 'managed-files-v1' ||
      header.executorId ||
      header.permissionMode !== 'ask' ||
      header.toolMode !== 'direct' ||
      header.collaborationMode !== 'agent' ||
      header.orchestrationMode !== 'default'
    )
      throw new Error('Invalid prepared managed task binding');
    await createBoundManagedTask(
      lease,
      {
        ...input,
        sourcePath: header.cwd,
        connectionId: header.llmConnectionId,
        connectionSlug: header.llmConnectionSlug,
        model: header.model,
        name: header.name,
        ...(header.projectId == null ? {} : { projectId: header.projectId }),
        ...(header.labels === undefined ? {} : { labels: header.labels }),
        ...(header.thinkingLevel === undefined ? {} : { thinkingLevel: header.thinkingLevel }),
      },
      fingerprint,
    );
  });
}

function createBoundManagedTask(
  lease: StorageRootLease<'interactive', 'write'>,
  input: Omit<ManagedSessionCreateInput, 'repositoryPath'>,
  catalogFingerprint?: `sha256:${string}`,
): Promise<{ readonly created: boolean; readonly capability: GitoxideManagedSessionCapability }> {
  input = snapshotManagedCreateMetadata(input);
  const previous = creations.get(lease) ?? Promise.resolve();
  const pending = previous
    .catch(() => undefined)
    .then(() =>
      runWithStorageRootLease(lease, 'interactive', 'write', async (root) => {
        input.abortSignal?.throwIfAborted();
        const repositoryPath = managedTaskRepositoryPath(root, input.sessionId);
        const request = { ...input, repositoryPath };
        const { requestFingerprint: descriptorFingerprint, createInput } =
          describeGitoxideManagedSessionCreateInternal(request);
        const requestFingerprint = catalogFingerprint ?? descriptorFingerprint;
        const stores = await openInteractiveExecutionStoresForWrite(lease);
        const probe = await stores.sessionStore.probeStableSessionCreate(
          input.sessionId,
          requestFingerprint,
        );
        if (probe.kind === 'conflict') throw new Error('Managed session creation conflict');
        if (probe.kind === 'existing')
          return publishManagedSession(stores, request, catalogFingerprint);
        const admissionOwnerToken = {};
        const admitted = await admitGitoxideRepositoryInternal({
          invocationOwnerToken: input.invocationOwnerToken,
          helperCapability: input.helperCapability,
          admissionOwnerToken,
          repositoryPath: input.sourcePath,
          abortSignal: input.abortSignal,
        });
        if (admitted.kind !== 'accepted')
          throw new Error(`Managed source rejected: ${admitted.reason}`);
        const exists = await lstat(repositoryPath).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          },
        );
        const acceptedRepositoryOwnerToken = {};
        const importRequest = {
          admissionOwnerToken,
          repositoryCapability: admitted.capability,
          acceptedRepositoryOwnerToken,
          destinationRepositoryPath: repositoryPath,
          requestFingerprint,
          abortSignal: input.abortSignal,
        };
        // Existing import intent is already an owner of this identity. Validate
        // it before adding a claim, so a mismatched retry cannot poison recovery.
        const verified = exists
          ? await verifyAdmittedGitoxideImportInternal(importRequest)
          : undefined;
        const prepared = await stores.sessionStore.prepareStableSessionCreate({
          sessionId: input.sessionId,
          requestFingerprint,
          input: createInput,
        });
        if (prepared.kind !== 'prepared') throw new Error('Managed session creation conflict');
        const imported =
          verified ?? (await importAdmittedGitoxideRepositoryInternal(importRequest));
        input.abortSignal?.throwIfAborted();
        await createGitoxideWorkspaceBaselineOwnerInternal(stores).acceptImport({
          workspaceKey: input.sessionId,
          acceptedRepositoryOwnerToken,
          acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
        });
        return publishManagedSession(stores, request, catalogFingerprint);
      }),
    );
  creations.set(lease, pending);
  void pending
    .finally(() => {
      if (creations.get(lease) === pending) creations.delete(lease);
    })
    .catch(() => undefined);
  return pending;
}

export type ManagedSessionCreateInput = Omit<
  ReopenInput,
  'acceptedRepositoryOwnerToken' | 'workspaceKey'
> & {
  readonly sessionId: string;
  readonly sourcePath: string;
  readonly connectionId: string;
  readonly connectionSlug: string;
  readonly model: string;
  readonly name: string;
  readonly projectId?: string;
  readonly labels?: readonly string[];
  readonly thinkingLevel?: ThinkingLevel;
};

function snapshotManagedCreateMetadata<
  T extends Pick<
    ManagedSessionCreateInput,
    | 'sessionId'
    | 'sourcePath'
    | 'connectionId'
    | 'connectionSlug'
    | 'model'
    | 'name'
    | 'projectId'
    | 'labels'
    | 'thinkingLevel'
  >,
>(input: T): T {
  // Internal publication must remain readable through the public catalog. Reuse
  // its wire vocabulary before queueing/import rather than maintaining wider limits.
  try {
    decodeSessionCreateInput({
      sessionId: input.sessionId,
      workspace: { kind: 'host_path', path: input.sourcePath },
      modelTarget: {
        kind: 'explicit',
        connectionId: input.connectionId,
        connectionSlug: input.connectionSlug,
        model: input.model,
      },
      name: input.name,
      ...(input.labels === undefined ? {} : { labels: input.labels }),
      ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
      toolProfile: 'managed-files-v1',
    });
    if (input.projectId !== undefined) requireEntityId(input.projectId, 'Workspace project id');
  } catch (cause) {
    throw new Error('Invalid managed session catalog input', { cause });
  }
  if (
    input.projectId !== undefined &&
    (typeof input.projectId !== 'string' ||
      !input.projectId.trim() ||
      input.projectId.includes('\0') ||
      Buffer.byteLength(input.projectId) > 4096)
  )
    throw new Error('Invalid managed session project identity');
  if (input.thinkingLevel !== undefined && !isThinkingLevel(input.thinkingLevel))
    throw new Error('Invalid managed session thinking level');
  if (
    input.labels !== undefined &&
    (!Array.isArray(input.labels) ||
      input.labels.length > SESSION_CATALOG_LABEL_MAX_ITEMS ||
      input.labels.some(
        (label) =>
          typeof label !== 'string' ||
          !label.trim() ||
          label.includes('\0') ||
          Buffer.byteLength(label) > SESSION_CATALOG_LABEL_MAX_BYTES ||
          isSessionStartModeLabel(label),
      ) ||
      new Set(input.labels).size !== input.labels.length)
  )
    throw new Error('Invalid managed session labels');
  return {
    ...input,
    ...(input.labels === undefined ? {} : { labels: Object.freeze([...input.labels]) }),
  };
}

export function describeGitoxideManagedSessionCreateInternal(input: ManagedSessionCreateInput) {
  input = snapshotManagedCreateMetadata(input);
  for (const value of [
    input.sessionId,
    input.sourcePath,
    input.repositoryPath,
    input.connectionId,
    input.connectionSlug,
    input.model,
    input.name,
  ]) {
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.includes('\0') ||
      Buffer.byteLength(value) > 4096
    )
      throw new Error('Invalid managed session creation input');
  }
  if (!isAbsolute(input.sourcePath) || !isAbsolute(input.repositoryPath))
    throw new Error('Managed session paths must be absolute');
  input.abortSignal?.throwIfAborted();
  const createInput = Object.freeze({
    cwd: input.sourcePath,
    name: input.name,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
    ...(input.labels === undefined ? {} : { labels: [...input.labels] }),
    llmConnectionId: input.connectionId,
    llmConnectionSlug: input.connectionSlug,
    model: input.model,
    toolProfile: 'managed-files-v1' as const,
    toolMode: 'direct' as const,
    permissionMode: 'ask' as const,
    collaborationMode: 'agent' as const,
    orchestrationMode: 'default' as const,
  });
  if (createInput.labels) Object.freeze(createInput.labels);
  const requestFingerprint: `sha256:${string}` = `sha256:${createHash('sha256')
    .update(
      JSON.stringify([
        'maka-managed-session-create-v1',
        input.sessionId,
        input.repositoryPath,
        createInput,
      ]),
    )
    .digest('hex')}`;
  return Object.freeze({ createInput, requestFingerprint });
}

/** Publish a Session only after its session-keyed accepted workspace is verifiable. */
export async function createGitoxideManagedSessionInternal(
  stores: InteractiveExecutionStoresWriter,
  input: ManagedSessionCreateInput,
): Promise<{ readonly created: boolean; readonly capability: GitoxideManagedSessionCapability }> {
  return publishManagedSession(stores, input);
}

async function publishManagedSession(
  stores: InteractiveExecutionStoresWriter,
  input: ManagedSessionCreateInput,
  catalogFingerprint?: `sha256:${string}`,
): Promise<{ readonly created: boolean; readonly capability: GitoxideManagedSessionCapability }> {
  input = snapshotManagedCreateMetadata(input);
  const { createInput, requestFingerprint: descriptorFingerprint } =
    describeGitoxideManagedSessionCreateInternal(input);
  const requestFingerprint = catalogFingerprint ?? descriptorFingerprint;
  const probe = await stores.sessionStore.probeStableSessionCreate(
    input.sessionId,
    requestFingerprint,
  );
  if (probe.kind === 'conflict') throw new Error('Managed session creation conflict');
  // Never create a visible Session before the accepted epoch and object graph exist.
  const capability = await openGitoxideManagedSessionInternal(stores, {
    sessionId: input.sessionId,
    workspaceKey: input.sessionId,
    repositoryPath: input.repositoryPath,
    invocationOwnerToken: input.invocationOwnerToken,
    helperCapability: input.helperCapability,
    abortSignal: input.abortSignal,
  });
  input.abortSignal?.throwIfAborted();
  const result = await stores.sessionStore.createStableSession({
    sessionId: input.sessionId,
    requestFingerprint,
    input: createInput,
  });
  if (result.kind === 'conflict') throw new Error('Managed session creation conflict');
  if (
    result.record.header.toolProfile !== 'managed-files-v1' ||
    result.record.header.cwd !== input.sourcePath
  )
    throw new Error('Managed session persisted identity mismatch');
  return Object.freeze({ created: result.kind === 'created', capability });
}

/** Bind a verified existing epoch, never implicitly import a checkout or change mode. */
export async function openGitoxideManagedSessionInternal(
  stores: InteractiveExecutionStoresWriter,
  input: Omit<ReopenInput, 'acceptedRepositoryOwnerToken'> & { readonly sessionId: string },
): Promise<GitoxideManagedSessionCapability> {
  input = { ...input };
  if (!input.sessionId.trim() || Buffer.byteLength(input.sessionId) > 1024)
    throw new Error('Invalid managed session identity');
  const owner = createGitoxideWorkspaceBaselineOwnerInternal(stores);
  const acceptedRepositoryOwnerToken = {};
  // Do not retain the opening caller's signal for later turns.
  const { abortSignal, sessionId, ...binding } = input;
  const reopen = (signal?: AbortSignal) =>
    owner.reopen({
      ...binding,
      acceptedRepositoryOwnerToken,
      abortSignal: signal,
    });
  await reopen(abortSignal);
  const readAcceptedFile: SessionExecution['readAcceptedFile'] = async (path, signal) => {
    const acceptedRepositoryCapability = await reopen(signal);
    return readGitoxideTreeFileInternal({
      acceptedRepositoryOwnerToken,
      acceptedRepositoryCapability,
      path,
      abortSignal: signal,
    });
  };
  const readTool: MakaTool = Object.freeze({
    name: 'Read',
    activityKind: 'read',
    categoryHint: 'read',
    recoveryMode: 'replay_safe',
    description:
      'Read a bounded text page from the current accepted Git tree. Use a canonical repository-relative path, or the complete next object from the previous page. Does not read the user checkout, images, or runtime resources.',
    parameters: readParameters,
    async impl(input, context) {
      if (context.sessionId !== sessionId)
        throw new Error('Managed read does not belong to this session');
      const args = readParameters.parse(input);
      const { path } = resolveReadInput(args);
      const file = await readAcceptedFile(path, context.abortSignal);
      return readPage(file.content, args);
    },
  } satisfies MakaTool);
  const capability = Object.freeze({ kind: 'gitoxide_managed_files_session' as const });
  sessions.set(
    capability,
    Object.freeze({
      projectTools: (tools: readonly MakaTool[]) =>
        tools
          .filter((tool) => ['Read', 'Write', 'Edit'].includes(tool.name))
          .map((tool) => (tool.name === 'Read' ? readTool : tool)),
      sessionId,
      runtimeCommitSink: stores.runtimeEventStore,
      inspectContinuation(source, signal) {
        return owner.inspectContinuation({
          ...binding,
          acceptedRepositoryOwnerToken,
          sessionId,
          sourceRunId: source.sourceRunId,
          expectedRuntimeEventHighWater: source.expectedRuntimeEventHighWater,
          abortSignal: signal,
        });
      },
      async prepareManagedMutation(request) {
        if (request.sessionId !== sessionId)
          throw new Error('Managed mutation does not belong to this session');
        // Snapshot before reopen, which may repair the accepted-ref projection.
        const { toolName, abortSignal } = request;
        const args = structuredClone(request.args);
        const acceptedRepositoryCapability = await reopen(abortSignal);
        const prepared = await prepareGitoxideRuntimeMutationInternal(stores, {
          workspaceKey: binding.workspaceKey,
          acceptedRepositoryOwnerToken,
          acceptedRepositoryCapability,
          toolName,
          args,
          abortSignal,
        });
        return Object.freeze({
          ...prepared,
          commitOutcome(outcome, result) {
            if (outcome.runtimeEvent.sessionId !== sessionId)
              return Promise.reject(new Error('Managed outcome does not belong to this session'));
            return prepared.commitOutcome(outcome, result);
          },
        } satisfies Awaited<ReturnType<Prepare>>);
      },
      readAcceptedFile,
    } satisfies SessionExecution),
  );
  return capability;
}

/** Host backend composition must bind both the session and the exact ledger group. */
export function requireGitoxideManagedSessionInternal(
  capability: GitoxideManagedSessionCapability,
  sessionId: string,
  runtimeCommitSink: RuntimeCommitSink | undefined,
): SessionExecution {
  const record = sessions.get(capability);
  if (!record || record.sessionId !== sessionId || record.runtimeCommitSink !== runtimeCommitSink)
    throw new Error('Managed session does not match backend identity and execution stores');
  return record;
}
