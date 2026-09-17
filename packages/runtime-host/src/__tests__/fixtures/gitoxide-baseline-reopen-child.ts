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

import { createHash } from 'node:crypto';
import { createExecutionRuntimeHostComposition } from '../../server/execution-composition.js';
import {
  createRuntimeBoundaryCursor,
  runtimePrefixSegment,
  type ContinuationClaimV1,
} from '@maka/core/runtime-boundary';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import { HostSessionCatalogCoordinator } from '../../server/session-catalog-coordinator.js';
import { SessionAdmissionGate } from '../../server/session-admission-gate.js';
import { HostProjectMembershipGate } from '../../server/project-membership-gate.js';
import { HostWorkspaceResolver } from '../../server/workspace-resolver.js';
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { transformManagedMutation } from '@maka/runtime/managed-mutation-transform';
import { ToolRuntime } from '@maka/runtime/tool-runtime';
import { SessionManager, BackendRegistry } from '@maka/runtime/session-manager';
import { AiSdkBackend } from '@maka/runtime/ai-sdk-backend';
import { prepareHostAiSdkBackendFromRoot } from '../../server/execution-model-composition.js';
import {
  openGitoxideManagedSessionInternal,
  createGitoxideManagedSessionInternal,
  createGitoxideManagedTaskInternal,
  reopenGitoxideManagedTaskInternal,
  describeGitoxideManagedSessionCreateInternal,
  publishPreparedGitoxideManagedTaskInternal,
  requireGitoxideManagedSessionInternal,
} from '../../server/gitoxide-managed-session-internal.js';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { z } from 'zod';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { createExternalExecutionBoundary } from '@maka/core/sandbox-boundary';
import type { SessionHeader } from '@maka/core/session';
import { prepareGitoxideRuntimeMutationInternal } from '../../server/gitoxide-runtime-mutation-internal.js';
import type { WorkspaceBaselineCommitResult } from '@maka/core/workspace-version-authority';
import { WORKSPACE_AUTHORITY_SESSION_ID } from '@maka/core/workspace-version-authority';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { createGitoxideWorkspaceBaselineOwnerInternal } from '../../server/gitoxide-workspace-baseline-owner-internal.js';
import {
  admitGitoxideHelperArtifactInternal,
  issueGitoxideHelperReleaseArtifactClaimInternal,
  GITOXIDE_HELPER_OPERATIONS_INTERNAL,
} from '../../server/gitoxide-helper-artifact-authority-internal.js';
import {
  admitGitoxideRepositoryInternal,
  importAdmittedGitoxideRepositoryInternal,
  verifyAdmittedGitoxideImportInternal,
  readGitoxideTreeFileInternal,
  createGitoxideCandidateInternal,
  verifyExistingGitoxideCandidateInternal,
  requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal,
} from '../../server/gitoxide-repository-admission-authority-internal.js';

const [mode, rootPath, sourcePath] = process.argv.slice(2);
if (!rootPath || !sourcePath || !process.env.MAKA_GITOXIDE_HELPER_PATH)
  throw new Error('Missing child input');
const executablePath = await realpath(process.env.MAKA_GITOXIDE_HELPER_PATH);
const bytes = await readFile(executablePath);
const releaseOwnerToken = {};
const invocationOwnerToken = {};
const helperCapability = await admitGitoxideHelperArtifactInternal({
  releaseOwnerToken,
  invocationOwnerToken,
  claim: issueGitoxideHelperReleaseArtifactClaimInternal(releaseOwnerToken, {
    executablePath,
    expectedBytes: bytes.length,
    expectedSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    platform: process.platform,
    arch: process.arch,
    protocolVersion: 1,
    supportedOperations: GITOXIDE_HELPER_OPERATIONS_INTERNAL,
  }),
});
const root = await resolveStorageRoot({ path: rootPath, kind: 'interactive' });
const leaseOwner = await tryAcquireInteractiveRootOwner(root);
if (!leaseOwner) throw new Error('Root still owned by another process');
const stores = await openInteractiveExecutionStoresForWrite(leaseOwner.lease);
const owner = createGitoxideWorkspaceBaselineOwnerInternal(stores);
const acceptedRepositoryOwnerToken = {};
const repositoryPath = join(rootPath, 'repository.git');
if (mode.startsWith('startup-candidate-')) {
  const sessionId = 'startup-candidate-session';
  const runId = 'startup-candidate-run';
  const managedPath = join(
    leaseOwner.lease.canonicalPath,
    `managed-files-${createHash('sha256').update(sessionId).digest('hex')}.git`,
  );
  if (mode === 'startup-candidate-crash' || mode === 'startup-candidate-t1') {
    const created = await createGitoxideManagedTaskInternal(leaseOwner.lease, {
      sessionId,
      sourcePath,
      invocationOwnerToken,
      helperCapability,
      connectionId: 'test-connection',
      connectionSlug: 'test',
      model: 'test-model',
      name: 'Startup recovery',
    });
    const session = requireGitoxideManagedSessionInternal(
      created.capability,
      sessionId,
      stores.runtimeEventStore,
    );
    let id = 0;
    const runtime = new ToolRuntime({
      sessionId,
      runId,
      invocationId: 'startup-invocation',
      turnId: 'startup-turn',
      header: await stores.sessionStore.readHeader(sessionId),
      connection: { slug: 'test', providerType: 'openai', defaultModel: 'test' },
      modelId: 'test',
      newId: () => `startup-event-${++id}`,
      now: Date.now,
      readExecutionBoundary: async () => createExternalExecutionBoundary(),
      readPermissionMode: async () => 'ask',
      getPermissionPauseTarget: () => null,
      runtimeCommitSink: {
        async commitToolPrepared(input) {
          const result = await session.runtimeCommitSink.commitToolPrepared(input);
          if (mode === 'startup-candidate-t1') process.exit(92);
          return result;
        },
        async commitToolOutcome() {
          throw new Error('Generic T2 forbidden');
        },
      },
      prepareManagedMutation: async (request) => {
        const prepared = await session.prepareManagedMutation(request);
        return {
          ...prepared,
          async commitOutcome(outcome, result) {
            assert.ok(result);
            const token = {};
            const cap = await owner.reopen({
              workspaceKey: sessionId,
              repositoryPath: managedPath,
              invocationOwnerToken,
              helperCapability,
              acceptedRepositoryOwnerToken: token,
            });
            await createGitoxideCandidateInternal({
              acceptedRepositoryOwnerToken: token,
              acceptedRepositoryCapability: cap,
              candidateOwnerToken: {},
              operationId: outcome.operationId,
              path: prepared.mutation.expectedPath,
              content: result.content,
            });
            process.exit(91);
          },
        };
      },
    });
    await runtime.settleToolCall({
      tool: {
        name: 'Write',
        description: 'managed write',
        parameters: {},
        impl() {
          throw new Error('Checkout execution forbidden');
        },
      },
      turnId: 'startup-turn',
      toolCallId: 'startup-call',
      input: { path: 'hello.txt', content: 'startup recovered\n' },
      abortSignal: new AbortController().signal,
      eventSink: { push() {}, async pushAndWaitUntilConsumed() {} },
    });
    throw new Error('Crash boundary not reached');
  }
  const before = await stores.runtimeEventStore.readImmutableRuntimeEvents(sessionId, runId);
  const composition = await createExecutionRuntimeHostComposition(
    {
      owner: leaseOwner,
      hostEpoch: 'startup-test',
      acquireResidency: () => ({ release() {} }),
      retainUntilProcessExit() {},
      requestDrain() {},
    },
    {},
    {
      ...(mode !== 'startup-candidate-no-helper'
        ? { managedFilesHelper: { invocationOwnerToken, helperCapability } }
        : {}),
      primaryBackendFactory() {
        throw new Error('Startup recovery must not run a model');
      },
    },
  );
  await composition.recover();
  const after = await stores.runtimeEventStore.readImmutableRuntimeEvents(sessionId, runId);
  const unsettled = await stores.runtimeEventStore.listUnsettledToolOperations(sessionId);
  if (mode === 'startup-candidate-park' || mode === 'startup-candidate-no-helper') {
    assert.deepEqual(after, before);
    assert.equal(unsettled.length, 1);
  } else {
    assert.equal(after.filter((event) => event.content?.kind === 'function_response').length, 1);
    assert.equal(unsettled.length, 0);
    if (mode === 'startup-candidate-retry') assert.deepEqual(after, before);
    const session = requireGitoxideManagedSessionInternal(
      await reopenGitoxideManagedTaskInternal(leaseOwner.lease, {
        sessionId,
        invocationOwnerToken,
        helperCapability,
      }),
      sessionId,
      stores.runtimeEventStore,
    );
    assert.equal((await session.readAcceptedFile('hello.txt')).content, 'startup recovered\n');
  }
  writeSync(1, JSON.stringify(after));
  process.exit(0);
}
if (
  mode === 'recover-head-drift' ||
  mode === 'crash-unsettled' ||
  mode === 'recover-unsettled' ||
  mode === 'publish-pending-candidate' ||
  mode === 'recover-pending-candidate' ||
  mode === 'settle-pending-candidate' ||
  mode === 'retry-pending-settlement'
) {
  const sessionId = 'settlement-session';
  const runId = 'inherited-run';
  const session = requireGitoxideManagedSessionInternal(
    await openGitoxideManagedSessionInternal(stores, {
      sessionId,
      workspaceKey: 'crash-session',
      repositoryPath,
      invocationOwnerToken,
      helperCapability,
    }),
    sessionId,
    stores.runtimeEventStore,
  );
  if (mode === 'crash-unsettled') {
    let id = 0;
    const runtime = new ToolRuntime({
      sessionId,
      runId,
      invocationId: 'inherited-invocation',
      turnId: 'inherited-turn',
      header: await stores.sessionStore.readHeader(sessionId),
      connection: { slug: 'test', providerType: 'openai', defaultModel: 'test' },
      modelId: 'test',
      newId: () => `pending-event-${++id}`,
      now: Date.now,
      readExecutionBoundary: async () => createExternalExecutionBoundary(),
      readPermissionMode: async () => 'ask',
      getPermissionPauseTarget: () => null,
      runtimeCommitSink: {
        async commitToolPrepared(input) {
          await session.runtimeCommitSink.commitToolPrepared(input);
          process.exit(88);
        },
        async commitToolOutcome() {
          throw new Error('Generic T2 forbidden');
        },
      },
      prepareManagedMutation: (request) => session.prepareManagedMutation(request),
    });
    await runtime.settleToolCall({
      tool: {
        name: 'Write',
        description: 'pending mutation',
        parameters: {},
        impl() {
          throw new Error('Checkout execution forbidden');
        },
      },
      turnId: 'inherited-turn',
      toolCallId: 'pending-call',
      input: { path: 'hello.txt', content: 'must not be executed\n' },
      abortSignal: new AbortController().signal,
      eventSink: { push() {}, async pushAndWaitUntilConsumed() {} },
    });
    throw new Error('T1 crash boundary was not reached');
  }
  const before = await stores.runtimeEventStore.readImmutableRuntimeEvents(sessionId, runId);
  if (mode === 'settle-pending-candidate' || mode === 'retry-pending-settlement') {
    const operationId = before.find((event) => event.actions?.toolDispatch?.managedMutation)!
      .actions!.toolDispatch!.operationId;
    const capability = await owner.reopen({
      workspaceKey: 'crash-session',
      repositoryPath,
      invocationOwnerToken,
      helperCapability,
      acceptedRepositoryOwnerToken,
    });
    const result = await owner.recoverCandidate({
      workspaceKey: 'crash-session',
      sessionId,
      runId,
      operationId,
      acceptedRepositoryOwnerToken,
      acceptedRepositoryCapability: capability,
    });
    assert.equal(result.created, mode === 'settle-pending-candidate');
    assert.equal(result.event.id, `${operationId}_recovered_response`);
    assert.equal(result.event.actions?.stateDelta?.durationMs, undefined);
    assert.equal(result.event.content?.kind, 'function_response');
    if (mode === 'retry-pending-settlement')
      assert.equal((await session.readAcceptedFile('hello.txt')).content, 'must not be executed\n');
    const after = await stores.runtimeEventStore.readImmutableRuntimeEvents(sessionId, runId);
    assert.equal(after.filter((event) => event.content?.kind === 'function_response').length, 1);
    assert.equal((await stores.runtimeEventStore.listUnsettledToolOperations(sessionId)).length, 0);
    if (mode === 'retry-pending-settlement') assert.deepEqual(after, before);
    else assert.deepEqual(after.slice(0, before.length), before);
    writeSync(1, JSON.stringify(result.event));
    process.exit(mode === 'settle-pending-candidate' ? 90 : 0);
  }
  assert.equal(
    before.some((event) => event.actions?.endInvocation),
    false,
  );
  const pendingBefore = await stores.runtimeEventStore.listUnsettledToolOperations(sessionId);
  if (mode === 'recover-unsettled') {
    const capability = await owner.reopen({
      workspaceKey: 'crash-session',
      repositoryPath,
      invocationOwnerToken,
      helperCapability,
      acceptedRepositoryOwnerToken,
    });
    await assert.rejects(
      owner.recoverCandidate({
        workspaceKey: 'crash-session',
        sessionId,
        runId,
        operationId: before.find((event) => event.actions?.toolDispatch?.managedMutation)!.actions!
          .toolDispatch!.operationId,
        acceptedRepositoryOwnerToken,
        acceptedRepositoryCapability: capability,
      }),
      /candidate_missing/,
    );
  }
  assert.equal(pendingBefore.length, mode === 'recover-head-drift' ? 0 : 1);
  if (mode !== 'recover-head-drift') {
    assert.equal(before.filter((event) => event.content?.kind === 'function_call').length, 1);
    assert.ok(before.some((event) => event.actions?.toolDispatch?.managedMutation));
    assert.equal(
      before.some((event) => event.content?.kind === 'function_response'),
      false,
    );
  }
  if (mode === 'publish-pending-candidate') {
    const call = before.find((event) => event.content?.kind === 'function_call');
    const dispatch = before.find((event) => event.actions?.toolDispatch?.managedMutation);
    assert.ok(call?.content?.kind === 'function_call');
    const mutation = dispatch!.actions!.toolDispatch!.managedMutation!;
    const operationId = dispatch!.actions!.toolDispatch!.operationId;
    const base = await session.readAcceptedFile(mutation.expectedPath);
    const result = transformManagedMutation({
      toolName: 'Write',
      canonicalPath: mutation.expectedPath,
      baseContent: base.content,
      args: call.content.args,
    });
    const capability = await owner.reopen({
      workspaceKey: 'crash-session',
      repositoryPath,
      invocationOwnerToken,
      helperCapability,
      acceptedRepositoryOwnerToken,
    });
    const candidate = await createGitoxideCandidateInternal({
      acceptedRepositoryOwnerToken,
      acceptedRepositoryCapability: capability,
      candidateOwnerToken: {},
      operationId,
      path: mutation.expectedPath,
      content: result.content,
    });
    assert.equal(candidate.kind, 'candidate_published');
    assert.equal((await session.readAcceptedFile('hello.txt')).content, 'later accepted content\n');
    assert.deepEqual(
      await stores.runtimeEventStore.readImmutableRuntimeEvents(sessionId, runId),
      before,
    );
    writeSync(
      1,
      JSON.stringify({
        candidateRef: candidate.candidateRef,
        candidateCommitOid: candidate.candidateCommitOid,
      }),
    );
    // Persisted Git candidate, but no owner acceptance/T2 and no graceful close.
    process.exit(89);
  }
  const candidatePath =
    mode === 'recover-pending-candidate'
      ? join(
          repositoryPath,
          'refs',
          'maka',
          'candidates',
          createHash('sha256')
            .update(
              before.find((event) => event.actions?.toolDispatch?.managedMutation)!.actions!
                .toolDispatch!.operationId,
            )
            .digest('hex'),
        )
      : undefined;
  const candidateBefore = candidatePath ? await readFile(candidatePath, 'utf8') : undefined;
  if (candidateBefore) assert.match(candidateBefore.trim(), /^[a-f0-9]{40}$/);
  let inspected = 0;
  const manager = new SessionManager({
    store: stores.sessionStore,
    runStore: stores.agentRunStore,
    runtimeEventStore: stores.runtimeEventStore,
    backends: new BackendRegistry(),
    inspectContinuationSafety: async (_sessionId, source) => {
      inspected++;
      assert.ok(source);
      return {
        workspaceIdentity: 'test-workspace',
        availableToolNames: ['Read', 'Write', 'Edit'],
        backgroundOperationsSettled: true,
        workspaceCheckpoint: await session.inspectContinuation(source),
      };
    },
    newId: () => {
      throw new Error('Recovery must not create a new execution');
    },
    now: Date.now,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await manager.recoverInterruptedSessionsAfterHostRestart(stores);
    assert.deepEqual(
      await stores.runtimeEventStore.readImmutableRuntimeEvents(sessionId, runId),
      before,
    );
    assert.deepEqual(
      await stores.runtimeEventStore.listUnsettledToolOperations(sessionId),
      pendingBefore,
    );
    if (candidatePath) assert.equal(await readFile(candidatePath, 'utf8'), candidateBefore);
  }
  assert.equal(inspected, mode === 'recover-head-drift' ? 2 : 0);
  assert.equal((await session.readAcceptedFile('hello.txt')).content, 'later accepted content\n');
  writeSync(1, JSON.stringify({ parked: true, inspected, events: before.length }));
  await leaseOwner.close();
  process.exit(0);
}
if (
  mode === 'inspect-continuation' ||
  mode === 'inspect-head-drift' ||
  mode === 'inspect-inherited' ||
  mode === 'inspect-inherited-reopen'
) {
  try {
    const inspect = owner.inspectContinuation.bind(owner);
    const input = {
      workspaceKey: 'crash-session',
      repositoryPath,
      invocationOwnerToken,
      helperCapability,
      acceptedRepositoryOwnerToken,
      sessionId: 'settlement-session',
      sourceRunId: 'settlement-run',
    };
    const observed = await inspect(input);
    assert.ok(observed.restored);
    assert.ok(observed.ref);
    const sessionCapability = await openGitoxideManagedSessionInternal(stores, input);
    const session = requireGitoxideManagedSessionInternal(
      sessionCapability,
      input.sessionId,
      stores.runtimeEventStore,
    );
    assert.deepEqual(
      await session.inspectContinuation({
        sourceRunId: input.sourceRunId,
        expectedRuntimeEventHighWater: observed.runtimeEventHighWater,
      }),
      observed,
    );
    await assert.rejects(inspect({ ...input, sourceRunId: 'unrelated-run' }));
    await assert.rejects(inspect({ ...input, sessionId: 'unrelated-session' }));
    await assert.rejects(
      inspect({
        ...input,
        expectedRuntimeEventHighWater: observed.runtimeEventHighWater - 1,
      }),
    );
    if (mode === 'inspect-inherited') {
      await stores.sessionStore.createStableSession({
        sessionId: input.sessionId,
        requestFingerprint: `sha256:${'b'.repeat(64)}`,
        input: {
          cwd: sourcePath,
          llmConnectionSlug: 'test',
          permissionMode: 'ask',
          toolProfile: 'managed-files-v1',
          toolMode: 'direct',
        },
      });
      await stores.runtimeEventStore.appendRuntimeEvent(input.sessionId, input.sourceRunId, {
        id: 'source-terminal',
        sessionId: input.sessionId,
        runId: input.sourceRunId,
        invocationId: 'settlement-invocation',
        turnId: 'settlement-turn',
        ts: Date.now(),
        role: 'system',
        author: 'system',
        partial: false,
        status: 'failed',
        content: { kind: 'error', message: 'interrupted after durable tool results' },
        actions: { endInvocation: true },
      });
      const parent = await stores.runtimeEventStore.readImmutableRuntimePrefix({
        sessionId: input.sessionId,
        runId: input.sourceRunId,
      });
      const boundary = createRuntimeBoundaryCursor([runtimePrefixSegment(parent)]);
      const claim: ContinuationClaimV1 = {
        protocol: 'continuation_claim_v1',
        claimId: 'inherited-claim',
        boundaryDigest: boundary.manifestDigest,
        boundary,
        providerProjectionVersion: 2,
        providerReplayDigest: `sha256:${'a'.repeat(64)}`,
        target: {
          sessionId: input.sessionId,
          runId: 'inherited-run',
          invocationId: 'inherited-invocation',
          turnId: 'inherited-turn',
        },
        targetOpening: {
          kind: 'invocation_opened',
          protocol: 'invocation_opened_v1',
          route: {
            provenance: 'unknown',
            backendKind: 'fake',
            llmConnectionSlug: 'test',
            modelId: 'test',
          },
          configuration: {
            cwd: sourcePath,
            permissionMode: 'ask',
            collaborationMode: 'agent',
            orchestrationMode: 'default',
            orchestrationSource: 'session',
            toolMode: 'direct',
            agentSwarmAuthorization: 'none',
          },
          root: { kind: 'user' },
          source: {
            kind: 'continuation',
            sourceInvocationId: parent.identity.invocationId,
            sourceRunId: parent.identity.runId,
            sourceTurnId: parent.identity.turnId,
            sourceRuntimeEventHighWater: parent.position.lastEventSeq,
            claimId: 'inherited-claim',
            boundaryDigest: boundary.manifestDigest,
          },
          lineage: { parentRunId: parent.identity.runId, parentTurnId: parent.identity.turnId },
        },
        claimedAt: Date.now(),
      };
      await stores.runtimeEventStore.claimContinuation({ claim });
      await stores.runtimeEventStore.commitContinuationStart({
        claim,
        event: {
          id: 'inherited-start',
          ...claim.target,
          ts: claim.claimedAt,
          partial: false,
          role: 'system',
          author: 'system',
          modelVisibility: 'hidden',
          content: claim.targetOpening,
          actions: {
            runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' },
            continuationStart: {
              protocol: 'continuation_start_v2',
              provenance: 'runtime_admission',
              claimId: claim.claimId,
              boundaryDigest: claim.boundaryDigest,
              immediateSource: {
                ...parent.identity,
                highWater: parent.position.lastEventSeq,
                prefixDigest: parent.prefixDigest,
              },
              replayManifestDigest: boundary.manifestDigest,
              providerProjectionVersion: claim.providerProjectionVersion,
              providerReplayDigest: claim.providerReplayDigest,
            },
          },
        },
      });
      // Exit without closing the stores/owner: a new process must authenticate
      // the persisted claim/start and ancestor prefix, not any in-memory record.
      process.exit(87);
    }
    if (mode === 'inspect-inherited-reopen') {
      const inherited = await session.inspectContinuation({ sourceRunId: 'inherited-run' });
      assert.equal(inherited.ref, observed.ref);
      assert.equal(inherited.runtimeEventHighWater, 1);
      assert.equal((await session.readAcceptedFile('hello.txt')).content, 'second result\n');
    }
    if (mode === 'inspect-head-drift') {
      const sourceBefore = await stores.runtimeEventStore.readImmutableRuntimeEvents(
        input.sessionId,
        input.sourceRunId,
      );
      let id = 0;
      const runtime = new ToolRuntime({
        sessionId: input.sessionId,
        runId: 'later-run',
        invocationId: 'later-invocation',
        turnId: 'later-turn',
        header: { id: input.sessionId, cwd: sourcePath, permissionMode: 'ask' } as SessionHeader,
        connection: { slug: 'test', providerType: 'openai', defaultModel: 'test' },
        modelId: 'test',
        newId: () => `later-event-${++id}`,
        now: () => ++id,
        readExecutionBoundary: async () => createExternalExecutionBoundary(),
        readPermissionMode: async () => 'ask',
        getPermissionPauseTarget: () => null,
        runtimeCommitSink: session.runtimeCommitSink,
        prepareManagedMutation: (request) => session.prepareManagedMutation(request),
      });
      await runtime.settleToolCall({
        tool: {
          name: 'Write',
          description: 'advance accepted head in another Run',
          parameters: {},
          impl() {
            throw new Error('Checkout execution forbidden');
          },
        },
        turnId: 'later-turn',
        toolCallId: 'later-call',
        input: { path: 'hello.txt', content: 'later accepted content\n' },
        abortSignal: new AbortController().signal,
        eventSink: { push() {}, async pushAndWaitUntilConsumed() {} },
      });
      assert.equal(
        (await session.readAcceptedFile('hello.txt')).content,
        'later accepted content\n',
      );
      // A valid old prefix still exists: rejection must be caused by head provenance,
      // not by a missing Run, an altered prefix, or an invalid high-water.
      assert.deepEqual(
        await stores.runtimeEventStore.readImmutableRuntimeEvents(
          input.sessionId,
          input.sourceRunId,
        ),
        sourceBefore,
      );
      await assert.rejects(
        session.inspectContinuation({
          sourceRunId: input.sourceRunId,
          expectedRuntimeEventHighWater: observed.runtimeEventHighWater,
        }),
        /Managed accepted head does not belong to the source Run/,
      );
      const later = await session.inspectContinuation({ sourceRunId: 'later-run' });
      assert.notEqual(later.ref, observed.ref);
      await assert.rejects(
        session.inspectContinuation({
          sourceRunId: 'inherited-run',
          expectedRuntimeEventHighWater: 1,
        }),
        /Managed accepted head does not belong to the source Run/,
      );
      assert.equal(
        (await session.readAcceptedFile('hello.txt')).content,
        'later accepted content\n',
      );
    }
    writeSync(1, JSON.stringify(observed));
  } finally {
    await leaseOwner.close();
  }
  process.exit(0);
}
if (mode.startsWith('catalog-')) {
  const sessionId = 'catalog-created-session';
  const existed = await stores.sessionStore.readHeader(sessionId).then(
    () => true,
    () => false,
  );
  const connection = {
    connectionId: 'test-connection',
    slug: 'test',
    name: 'Test',
    revision: 1,
    providerType: 'openai' as const,
    enabled: true,
    enabledModelIds: ['first-model', 'changed-default'],
    models: [{ id: 'first-model' }, { id: 'changed-default' }],
    modelSource: 'fetched' as const,
  };
  const policy = createDefaultRuntimePolicy();
  let refreshed = false;
  const catalog = new HostSessionCatalogCoordinator({
    stores: stores.sessionStore,
    managedCreation: {
      stores: stores.sessionStore,
      publish: async (id, requestFingerprint) => {
        if (mode === 'catalog-prepared-exit') process.exit(90);
        await publishPreparedGitoxideManagedTaskInternal(leaseOwner.lease, {
          sessionId: id,
          requestFingerprint,
          invocationOwnerToken,
          helperCapability,
        });
        if (mode === 'catalog-published-exit') process.exit(91);
      },
    },
    runtimePolicy: {
      connectionCatalog: {
        getSnapshot: async () => ({
          revision: 1,
          connections: [connection],
          defaultTarget: {
            connectionId: connection.connectionId,
            modelId: mode === 'catalog-retry' ? 'changed-default' : 'first-model',
          },
        }),
      },
      runtimePolicy: { getSnapshot: async () => ({ revision: 1, policy }) },
      operations: {
        resolveExecutionConnection: async () => ({
          kind: 'ready',
          connection,
          secretMaterial: {},
          networkProxy: policy.networkProxy,
        }),
      },
    },
    turnIndex: {
      readDurableRecords: async () => ({ throughSequence: null, records: [], nextPosition: null }),
      readDurableTurnContributions: async () => ({
        throughSequence: null,
        contributions: [],
        nextPosition: null,
      }),
      readDurableTurnLandmarks: async () => ({ throughSequence: null, landmarks: [] }),
    },
    manager: {
      runningTurnIds: () => [],
      transitionSessionConfiguration: async () => {
        throw new Error('not used');
      },
      relocateSessionWorkspace: async () => {
        throw new Error('not used');
      },
    },
    admission: new SessionAdmissionGate(),
    continuity: {
      refreshCanonical: async () => {
        refreshed = true;
      },
    },
    workspaceResolver: new HostWorkspaceResolver(
      {
        list: async () => [],
        touch: async () => {
          throw new Error('not used');
        },
      },
      new HostProjectMembershipGate(),
      () => {},
    ),
    requestDrain: () => {},
  });
  try {
    const outcome = await catalog.handlers['session.create'](
      {
        sessionId,
        workspace: { kind: 'host_path', path: sourcePath },
        modelTarget: { kind: 'default' },
        toolProfile: 'managed-files-v1',
      },
      {
        hostEpoch: 'test',
        connectionId: 'test',
        principal: 'local_os_user',
        acquireResidency: () => ({ release: () => {} }),
      },
    );
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(refreshed, true);
    const header = await stores.sessionStore.readHeader(sessionId);
    assert.equal(header.model, 'first-model');
    const cap = await reopenGitoxideManagedTaskInternal(leaseOwner.lease, {
      sessionId,
      invocationOwnerToken,
      helperCapability,
    });
    const read = await requireGitoxideManagedSessionInternal(
      cap,
      sessionId,
      stores.runtimeEventStore,
    ).readAcceptedFile('hello.txt');
    writeSync(
      1,
      JSON.stringify({
        created: !existed,
        profile: header.toolProfile,
        content: read.content,
        facts: (
          await stores.runtimeEventStore.readSessionRuntimeEvents(WORKSPACE_AUTHORITY_SESSION_ID)
        ).length,
      }),
    );
  } finally {
    await stores.sessionStore.close?.();
    await leaseOwner.close();
  }
  process.exit(0);
}
if (mode.startsWith('task-')) {
  try {
    const request = {
      sessionId: 'managed-created-session',
      sourcePath,
      invocationOwnerToken,
      helperCapability,
      connectionId: 'test-connection',
      connectionSlug: 'test',
      model: 'test-model',
      name: 'Managed test',
      projectId: 'managed-project',
      labels: ['recovery-test'],
      thinkingLevel: 'high' as const,
    };
    if (mode === 'task-import-exit' || mode === 'task-prepared-exit') {
      const destinationRepositoryPath = join(
        leaseOwner.lease.canonicalPath,
        `managed-files-${createHash('sha256').update(request.sessionId).digest('hex')}.git`,
      );
      const { requestFingerprint, createInput } = describeGitoxideManagedSessionCreateInternal({
        ...request,
        repositoryPath: destinationRepositoryPath,
      });
      if (mode === 'task-prepared-exit') {
        const prepared = await stores.sessionStore.prepareStableSessionCreate({
          sessionId: request.sessionId,
          requestFingerprint,
          input: createInput,
        });
        assert.equal(prepared.kind, 'prepared');
        await assert.rejects(stores.sessionStore.readHeader(request.sessionId));
        process.exit(89);
      }
      const admissionOwnerToken = {};
      const admitted = await admitGitoxideRepositoryInternal({
        invocationOwnerToken,
        helperCapability,
        admissionOwnerToken,
        repositoryPath: sourcePath,
      });
      if (admitted.kind !== 'accepted') throw new Error(admitted.reason);
      await importAdmittedGitoxideRepositoryInternal({
        admissionOwnerToken,
        repositoryCapability: admitted.capability,
        acceptedRepositoryOwnerToken,
        destinationRepositoryPath,
        requestFingerprint,
      });
      process.exit(88);
    }
    if (mode === 'task-changed-before-session') {
      await assert.rejects(
        createGitoxideManagedTaskInternal(leaseOwner.lease, {
          ...request,
          name: 'Changed before publication',
        }),
        /import_intent_mismatch/,
      );
      await assert.rejects(stores.sessionStore.readHeader(request.sessionId));
      await assert.rejects(
        createGitoxideManagedTaskInternal(leaseOwner.lease, {
          ...request,
          labels: ['changed-before-publication'],
        }),
        /import_intent_mismatch/,
      );
      writeSync(1, 'rejected');
      await stores.sessionStore.close?.();
      await leaseOwner.close();
      process.exit(0);
    }
    await assert.rejects(createGitoxideManagedTaskInternal({ ...leaseOwner.lease }, request));
    for (const change of [
      { projectId: '' },
      { name: '界'.repeat(107) },
      { model: 'm'.repeat(513) },
      { connectionSlug: 's'.repeat(257) },
      { connectionId: 'connection/invalid' },
      { projectId: 'project/invalid' },
      { sessionId: 'session/invalid' },
      { labels: ['duplicate', 'duplicate'] },
      { labels: Array.from({ length: 33 }, (_, index) => `label-${index}`) },
    ]) {
      assert.throws(
        () => createGitoxideManagedTaskInternal(leaseOwner.lease, { ...request, ...change }),
        /Invalid managed session/,
      );
    }
    const boundary = describeGitoxideManagedSessionCreateInternal({
      ...request,
      repositoryPath,
      name: `${'界'.repeat(106)}ab`,
      model: 'm'.repeat(512),
      connectionSlug: 's'.repeat(256),
      connectionId: 'c'.repeat(128),
      projectId: 'p'.repeat(128),
      sessionId: 'i'.repeat(128),
    });
    assert.equal(Buffer.byteLength(boundary.createInput.name), 320);
    assert.equal(boundary.createInput.model.length, 512);
    assert.equal(boundary.createInput.llmConnectionSlug.length, 256);
    if (mode === 'task-create-exit')
      await assert.rejects(stores.sessionStore.readHeader(request.sessionId));
    const cancelled = new AbortController();
    cancelled.abort(new Error('cancel task creation'));
    await assert.rejects(
      createGitoxideManagedTaskInternal(leaseOwner.lease, {
        ...request,
        abortSignal: cancelled.signal,
      }),
      /cancel task creation/,
    );
    const pending = [
      createGitoxideManagedTaskInternal(leaseOwner.lease, request),
      createGitoxideManagedTaskInternal(leaseOwner.lease, request),
    ];
    request.labels[0] = 'mutated-after-admission';
    const results = await Promise.all(pending);
    request.labels[0] = 'recovery-test';
    const result = results[0];
    const createdHeader = await stores.sessionStore.readHeader(request.sessionId);
    assert.equal(createdHeader.projectId, 'managed-project');
    assert.deepEqual(createdHeader.labels, ['recovery-test']);
    assert.equal(createdHeader.thinkingLevel, 'high');
    assert.equal(results[1].created, false);
    if (mode === 'task-create-exit') process.exit(87);
    const reopened = await reopenGitoxideManagedTaskInternal(leaseOwner.lease, {
      sessionId: request.sessionId,
      invocationOwnerToken,
      helperCapability,
    });
    const execution = requireGitoxideManagedSessionInternal(
      reopened,
      request.sessionId,
      stores.runtimeEventStore,
    );
    const read = await execution.readAcceptedFile('hello.txt');
    const ordinary = await stores.sessionStore.create({
      cwd: sourcePath,
      name: 'Ordinary task',
      llmConnectionSlug: 'test',
      permissionMode: 'ask',
    });
    await assert.rejects(
      reopenGitoxideManagedTaskInternal(leaseOwner.lease, {
        sessionId: ordinary.id,
        invocationOwnerToken,
        helperCapability,
      }),
      /not a managed files task/,
    );
    let providerReads = 0;
    const backendInput = {
      context: {
        sessionId: request.sessionId,
        header: await stores.sessionStore.readHeader(request.sessionId),
        abortSignal: new AbortController().signal,
      },
      runtimeCommitSink: stores.runtimeEventStore,
      runtimePolicy: {
        operations: {
          resolveExecutionConnection: async () => {
            providerReads++;
            throw new Error('verified managed provider boundary');
          },
        },
      },
    } as unknown as Parameters<typeof prepareHostAiSdkBackendFromRoot>[2];
    await assert.rejects(
      prepareHostAiSdkBackendFromRoot(
        leaseOwner.lease,
        { invocationOwnerToken, helperCapability },
        backendInput,
      ),
      /verified managed provider boundary/,
    );
    assert.equal(providerReads, 1);
    await assert.rejects(
      prepareHostAiSdkBackendFromRoot(
        leaseOwner.lease,
        { invocationOwnerToken, helperCapability },
        { ...backendInput, runtimeCommitSink: undefined },
      ),
      /Managed session does not match/,
    );
    assert.equal(providerReads, 1);
    await assert.rejects(
      createGitoxideManagedTaskInternal(leaseOwner.lease, { ...request, name: 'Changed request' }),
      /conflict/i,
    );
    for (const change of [
      { projectId: 'another-project' },
      { labels: ['another-label'] },
      { thinkingLevel: 'low' as const },
    ]) {
      await assert.rejects(
        createGitoxideManagedTaskInternal(leaseOwner.lease, { ...request, ...change }),
        /conflict/i,
      );
    }
    const repeated = await Promise.all([
      createGitoxideManagedTaskInternal(leaseOwner.lease, request),
      createGitoxideManagedTaskInternal(leaseOwner.lease, request),
    ]);
    assert.ok(repeated.every((entry) => !entry.created));
    writeSync(
      1,
      JSON.stringify({
        created: result.created,
        profile: (await stores.sessionStore.readHeader(request.sessionId)).toolProfile,
        content: read.content,
        facts: (
          await stores.runtimeEventStore.readSessionRuntimeEvents(WORKSPACE_AUTHORITY_SESSION_ID)
        ).length,
      }),
    );
  } finally {
    await stores.sessionStore.close?.();
    await leaseOwner.close();
  }
  process.exit(0);
}
if (mode === 'read-settlement') {
  try {
    const events = await stores.runtimeEventStore.readImmutableRuntimeEvents(
      'settlement-session',
      'settlement-run',
    );
    const workspace = await stores.runtimeEventStore.readSessionRuntimeEvents(
      WORKSPACE_AUTHORITY_SESSION_ID,
    );
    writeSync(
      1,
      JSON.stringify({
        outcomes: events.filter((event) => event.content?.kind === 'function_response'),
        successors: workspace.filter(
          (event) => event.actions?.workspaceFact?.kind === 'maka.workspace.version_accepted',
        ),
        unsettled: await stores.runtimeEventStore.listUnsettledToolOperations('settlement-session'),
      }),
    );
  } finally {
    await stores.sessionStore.close?.();
    await leaseOwner.close();
  }
  process.exit(0);
}
const settling =
  mode?.startsWith('backend-') ||
  mode?.startsWith('runtime-') ||
  mode === 'settle-false-rejection' ||
  mode === 'crash-after-edit-rejection' ||
  mode === 'settle-false-no-change' ||
  mode === 'settle-no-change' ||
  mode === 'recover-no-change' ||
  mode === 'crash-after-no-change' ||
  mode === 'crash-after-new-file' ||
  mode === 'settle-new-file' ||
  mode === 'settle-candidate' ||
  mode === 'settle-wrong-content' ||
  mode === 'crash-after-settlement';
let baseline: WorkspaceBaselineCommitResult | undefined;
if (
  mode === 'crash-after-baseline' ||
  settling ||
  mode === 'session-baseline-exit' ||
  mode === 'session-publish-exit' ||
  mode === 'session-import-exit'
) {
  const admissionOwnerToken = {};
  const admitted = await admitGitoxideRepositoryInternal({
    invocationOwnerToken,
    helperCapability,
    admissionOwnerToken,
    repositoryPath: sourcePath,
  });
  if (admitted.kind !== 'accepted') throw new Error(admitted.reason);
  const imported = await importAdmittedGitoxideRepositoryInternal({
    admissionOwnerToken,
    repositoryCapability: admitted.capability,
    acceptedRepositoryOwnerToken,
    destinationRepositoryPath: repositoryPath,
  });
  if (mode === 'session-import-exit') process.exit(86);
  baseline = await owner.acceptImport({
    workspaceKey: mode.startsWith('session-') ? 'managed-created-session' : 'crash-session',
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: imported.acceptedRepositoryCapability,
  });
  // Deliberately bypass store/lease cleanup. Next process must reacquire and revalidate.
  if (mode === 'crash-after-baseline') process.exit(77);
  if (mode === 'session-baseline-exit') process.exit(85);
}
if (mode.startsWith('session-')) {
  try {
    if (mode === 'session-import-recover') {
      const admissionOwnerToken = {};
      const admitted = await admitGitoxideRepositoryInternal({
        invocationOwnerToken,
        helperCapability,
        admissionOwnerToken,
        repositoryPath: sourcePath,
      });
      if (admitted.kind !== 'accepted') throw new Error(admitted.reason);
      const recovered = await verifyAdmittedGitoxideImportInternal({
        admissionOwnerToken,
        repositoryCapability: admitted.capability,
        acceptedRepositoryOwnerToken,
        destinationRepositoryPath: repositoryPath,
      });
      await owner.acceptImport({
        workspaceKey: 'managed-created-session',
        acceptedRepositoryOwnerToken,
        acceptedRepositoryCapability: recovered.acceptedRepositoryCapability,
      });
    }
    const request = {
      sessionId: 'managed-created-session',
      sourcePath,
      repositoryPath,
      invocationOwnerToken,
      helperCapability,
      connectionId: 'test-connection',
      connectionSlug: 'test',
      model: 'test-model',
      name: 'Managed test',
    };
    if (mode === 'session-missing-baseline' || mode === 'session-preabort') {
      const controller = new AbortController();
      if (mode === 'session-preabort') controller.abort(new Error('cancel before publication'));
      await assert.rejects(
        createGitoxideManagedSessionInternal(stores, {
          ...request,
          abortSignal: controller.signal,
        }),
        mode === 'session-preabort' ? /cancel before publication/ : /durable workspace identity/,
      );
      await assert.rejects(stores.sessionStore.readHeader(request.sessionId));
      await stores.sessionStore.close?.();
      await leaseOwner.close();
      process.exit(0);
    }
    const result = await createGitoxideManagedSessionInternal(stores, request);
    if (mode === 'session-publish-exit') process.exit(84);
    const header = await stores.sessionStore.readHeader(request.sessionId);
    const execution = requireGitoxideManagedSessionInternal(
      result.capability,
      request.sessionId,
      stores.runtimeEventStore,
    );
    const read = await execution.readAcceptedFile('hello.txt');
    const repeated = await createGitoxideManagedSessionInternal(stores, request);
    assert.equal(repeated.created, false);
    await assert.rejects(
      createGitoxideManagedSessionInternal(stores, { ...request, name: 'Different intent' }),
      /conflict/i,
    );
    writeSync(
      1,
      JSON.stringify({
        created: result.created,
        profile: header.toolProfile,
        content: read.content,
        facts: (
          await stores.runtimeEventStore.readSessionRuntimeEvents(WORKSPACE_AUTHORITY_SESSION_ID)
        ).length,
      }),
    );
  } finally {
    await stores.sessionStore.close?.();
    await leaseOwner.close();
  }
  process.exit(0);
}
if (
  !settling &&
  ![
    'reopen',
    'crash-after-reopen',
    'crash-after-candidate',
    'retry-candidate',
    'conflicting-candidate',
  ].includes(mode)
)
  throw new Error('Unknown child mode');
try {
  const capability = await owner.reopen({
    workspaceKey: 'crash-session',
    repositoryPath,
    invocationOwnerToken,
    helperCapability,
    acceptedRepositoryOwnerToken,
  });
  const file = await readGitoxideTreeFileInternal({
    acceptedRepositoryOwnerToken,
    acceptedRepositoryCapability: capability,
    path: 'hello.txt',
  });
  if (mode === 'crash-after-reopen') process.exit(80);
  if (mode === 'backend-live-sequence' || mode === 'backend-crash-first') {
    let step = 0;
    const sessionCapability = await openGitoxideManagedSessionInternal(stores, {
      sessionId: 'settlement-session',
      workspaceKey: 'crash-session',
      repositoryPath,
      invocationOwnerToken,
      helperCapability,
    });
    const session = requireGitoxideManagedSessionInternal(
      sessionCapability,
      'settlement-session',
      stores.runtimeEventStore,
    );
    const projected = session.projectTools(
      ['Read', 'Bash', 'Glob', 'Grep', 'apply_patch', 'Write', 'Edit'].map((name) => ({
        name,
        description: 'checkout tool',
        parameters: z.object({}),
        impl() {
          throw new Error('Checkout execution forbidden');
        },
      })),
    );
    assert.deepEqual(
      projected.map((tool) => tool.name),
      ['Read', 'Write', 'Edit'],
    );
    assert.deepEqual(session.projectTools([]), []);
    const readTool = projected[0]!;
    const readContext = {
      sessionId: 'settlement-session',
      turnId: 'read-contract',
      cwd: sourcePath,
      toolCallId: 'read-contract',
      abortSignal: new AbortController().signal,
      emitOutput() {},
    };
    await assert.rejects(
      async () =>
        readTool.impl(
          { path: 'hello.txt' },
          {
            ...readContext,
            sessionId: 'other-session',
          },
        ),
      /does not belong/,
    );
    await assert.rejects(async () => readTool.impl({ path: '../hello.txt' }, readContext));
    await assert.rejects(async () =>
      readTool.impl({ path: 'maka://runtime/anything' }, readContext),
    );
    assert.deepEqual(await readTool.impl({ path: 'hello.txt', offset: 0, limit: 1 }, readContext), {
      content: 'accepted original',
      offset: 0,
      returnedLines: 1,
      totalLines: 2,
      next: null,
    });
    assert.throws(
      () =>
        requireGitoxideManagedSessionInternal(
          { ...sessionCapability },
          'settlement-session',
          stores.runtimeEventStore,
        ),
      /does not match/,
    );
    assert.throws(
      () =>
        requireGitoxideManagedSessionInternal(
          sessionCapability,
          'other-session',
          stores.runtimeEventStore,
        ),
      /does not match/,
    );
    assert.throws(
      () =>
        requireGitoxideManagedSessionInternal(sessionCapability, 'settlement-session', {
          commitToolPrepared: (...args) => stores.runtimeEventStore.commitToolPrepared(...args),
          commitToolOutcome: (...args) => stores.runtimeEventStore.commitToolOutcome(...args),
        }),
      /does not match/,
    );
    const aborted = new AbortController();
    aborted.abort(new Error('cancel before session read'));
    await assert.rejects(
      session.readAcceptedFile('hello.txt', aborted.signal),
      /cancel before session read/,
    );
    await assert.rejects(
      session.prepareManagedMutation({
        sessionId: 'other-session',
        toolName: 'Write',
        args: { path: 'hello.txt', content: 'wrong session' },
        abortSignal: new AbortController().signal,
      }),
      /does not belong/,
    );
    const head: RuntimeEvent = {
      id: 'backend-user',
      sessionId: 'settlement-session',
      runId: 'settlement-run',
      invocationId: 'settlement-invocation',
      turnId: 'settlement-turn',
      ts: 1,
      partial: false,
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'Update the file twice' },
    };
    await stores.runtimeEventStore.appendRuntimeEvent(head.sessionId, head.runId!, head);
    const backend = new AiSdkBackend({
      sessionId: head.sessionId,
      header: {
        id: head.sessionId,
        cwd: sourcePath,
        permissionMode: 'ask',
        toolMode: 'direct',
        toolProfile: 'managed-files-v1',
      } as SessionHeader,
      connection: { slug: 'test', providerType: 'anthropic', defaultModel: 'test' },
      apiKey: 'offline',
      modelId: 'test',
      maxSteps: 4,
      readExecutionBoundary: async () => createExternalExecutionBoundary(),
      readPermissionMode: async () => 'ask',
      loadTurnRuntimeEvents: () =>
        stores.runtimeEventStore.readImmutableRuntimeEvents(head.sessionId, head.runId!),
      runtimeCommitSink: session.runtimeCommitSink,
      prepareManagedMutation: async (input) => {
        const prepared = await session.prepareManagedMutation(input);
        return {
          ...prepared,
          async commitOutcome(...args) {
            await assert.rejects(
              prepared.commitOutcome(
                {
                  ...args[0],
                  runtimeEvent: { ...args[0].runtimeEvent, sessionId: 'other-session' },
                },
                args[1],
              ),
              /does not belong/,
            );
            const event = await prepared.commitOutcome(...args);
            if (mode === 'backend-crash-first') process.exit(83);
            return event;
          },
        };
      },
      tools: [
        ...session.projectTools([
          {
            name: 'Read',
            description: 'read checkout',
            parameters: z.object({ path: z.string() }),
            impl: async () => ({ content: await readFile(join(sourcePath, 'hello.txt'), 'utf8') }),
          },
          {
            name: 'Write',
            description: 'write accepted content',
            parameters: z.object({ path: z.string(), content: z.string() }),
            impl() {
              throw new Error('Checkout Write forbidden');
            },
          },
          {
            name: 'Edit',
            description: 'edit accepted content',
            parameters: z.object({
              path: z.string(),
              old_string: z.string(),
              new_string: z.string(),
            }),
            impl() {
              throw new Error('Checkout Edit forbidden');
            },
          },
        ]),
      ],
      modelFactory: () =>
        new MockLanguageModelV4({
          doStream: async () => {
            const current = step++;
            const usage = {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            };
            return {
              stream: simulateReadableStream<LanguageModelV4StreamPart>({
                chunks:
                  current < 3
                    ? [
                        { type: 'stream-start', warnings: [] },
                        {
                          type: 'tool-call',
                          toolCallId: `backend-call-${current}`,
                          toolName: current === 0 ? 'Write' : current === 1 ? 'Edit' : 'Read',
                          input: JSON.stringify(
                            current === 0
                              ? { path: 'hello.txt', content: 'first result\n' }
                              : current === 1
                                ? {
                                    path: 'hello.txt',
                                    old_string: 'first result',
                                    new_string: 'second result',
                                  }
                                : { path: 'hello.txt' },
                          ),
                        },
                        {
                          type: 'finish',
                          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                          usage,
                        },
                      ]
                    : [
                        { type: 'stream-start', warnings: [] },
                        { type: 'text-start', id: 'done' },
                        { type: 'text-delta', id: 'done', delta: 'Done' },
                        { type: 'text-end', id: 'done' },
                        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
                      ],
              }),
            };
          },
        }),
    });
    const events = [];
    try {
      for await (const event of backend.send({
        text: 'Update the file twice',
        context: [],
        runtimeContext: [head],
        headAnchorRuntimeEvent: head,
        turnId: head.turnId!,
        runId: head.runId,
        invocationId: head.invocationId,
      }))
        events.push(event);
    } finally {
      await backend.dispose();
    }
    assert.equal(
      events.filter((event) => event.type === 'tool_result').length,
      3,
      JSON.stringify(events),
    );
    assert.equal(
      events.some((event) => event.type === 'error'),
      false,
      JSON.stringify(events),
    );
    assert.equal((await session.readAcceptedFile('hello.txt')).content, 'second result\n');
    const readOutcome = (
      await stores.runtimeEventStore.readImmutableRuntimeEvents(head.sessionId, head.runId!)
    ).find((event) => event.content?.kind === 'function_response' && event.content.name === 'Read');
    assert.ok(readOutcome?.content?.kind === 'function_response');
    assert.deepEqual(readOutcome.content.result, {
      kind: 'json',
      value: { content: 'second result\n', offset: 0, returnedLines: 2, totalLines: 2, next: null },
    });
    writeSync(
      1,
      JSON.stringify({ results: events.filter((event) => event.type === 'tool_result') }),
    );
    await stores.sessionStore.close?.();
    await assert.rejects(session.readAcceptedFile('hello.txt'));
    await assert.rejects(
      session.prepareManagedMutation({
        sessionId: 'settlement-session',
        toolName: 'Write',
        args: { path: 'hello.txt', content: 'after close' },
        abortSignal: new AbortController().signal,
      }),
    );
    await leaseOwner.close();
    process.exit(0);
  }
  if (mode?.startsWith('runtime-')) {
    let id = 0;
    let published: unknown;
    const runtime = new ToolRuntime({
      sessionId: 'settlement-session',
      runId: 'settlement-run',
      invocationId: 'settlement-invocation',
      turnId: 'settlement-turn',
      header: { id: 'settlement-session', cwd: sourcePath, permissionMode: 'ask' } as SessionHeader,
      connection: { slug: 'test', providerType: 'openai', defaultModel: 'test' },
      modelId: 'test',
      newId: () => `runtime-event-${++id}`,
      now: () => ++id,
      readExecutionBoundary: async () => createExternalExecutionBoundary(),
      readPermissionMode: async () => 'ask',
      getPermissionPauseTarget: () => null,
      runtimeCommitSink: {
        commitToolPrepared: (input) => stores.runtimeEventStore.commitToolPrepared(input),
        commitToolOutcome: async () => {
          throw new Error('Generic T2 must not run');
        },
      },
      prepareManagedMutation: async (input) => {
        const prepared = await prepareGitoxideRuntimeMutationInternal(stores, {
          ...input,
          workspaceKey: 'crash-session',
          acceptedRepositoryOwnerToken,
          acceptedRepositoryCapability: capability,
        });
        return {
          ...prepared,
          async commitOutcome(...args) {
            const durable = await prepared.commitOutcome(...args);
            // Real Runtime-built T2 committed; no result has been published yet.
            if (mode.includes('crash')) process.exit(81);
            return durable;
          },
        };
      },
    });
    const settled = await runtime.settleToolCall({
      tool: {
        name: mode.endsWith('rejection') ? 'Edit' : 'Write',
        description: 'managed mutation',
        parameters: {},
        impl() {
          throw new Error('Checkout impl forbidden');
        },
      },
      turnId: 'settlement-turn',
      toolCallId: 'settlement-call',
      input: mode.endsWith('rejection')
        ? { path: 'hello.txt', old_string: 'missing snippet', new_string: 'replacement' }
        : {
            path: 'hello.txt',
            content: mode.endsWith('noop') ? 'accepted original\n' : 'runtime result\n',
          },
      abortSignal: new AbortController().signal,
      eventSink: {
        push(event) {
          if (event.type === 'tool_result') {
            if (mode.includes('crash')) throw new Error('Result published before crash');
            published = event.content;
          }
        },
        async pushAndWaitUntilConsumed() {},
      },
    });
    assert.ok(published);
    writeSync(1, JSON.stringify({ published, result: settled.result }));
    await stores.sessionStore.close?.();
    await leaseOwner.close();
    process.exit(0);
  }
  if (mode !== 'reopen') {
    const candidateOwnerToken = {};
    const operationId = 'crash-candidate-operation';
    const newFile = mode === 'settle-new-file' || mode === 'crash-after-new-file';
    const noChange =
      mode === 'recover-no-change' ||
      mode === 'settle-no-change' ||
      mode === 'crash-after-no-change' ||
      mode === 'settle-false-no-change';
    const args = {
      path: newFile ? 'new/nested.txt' : 'hello.txt',
      content: noChange && mode !== 'settle-false-no-change' ? file.content : 'candidate result\n',
      ...(mode === 'crash-after-edit-rejection'
        ? { old_string: 'missing snippet', new_string: 'replacement' }
        : {}),
    };
    const toolName = mode === 'crash-after-edit-rejection' ? 'Edit' : 'Write';
    const identity = {
      sessionId: 'settlement-session',
      runId: 'settlement-run',
      invocationId: 'settlement-invocation',
      turnId: 'settlement-turn',
    };
    const callId = 'settlement-call';
    if (settling) {
      if (!baseline) throw new Error('Missing fixture baseline');
      const prepare = owner.prepareMutation;
      const mutableArgs = { ...args };
      const preparation = prepare({
        workspaceKey: 'crash-session',
        acceptedRepositoryOwnerToken,
        acceptedRepositoryCapability: capability,
        toolName,
        args: mutableArgs,
      });
      mutableArgs.path = 'changed-after-admission.txt';
      mutableArgs.content = 'untrusted later content';
      const admission = await preparation;
      assert.equal(admission.canonicalArgsHash, canonicalToolArgsHash(toolName, args));
      assert.equal(admission.baseContent, newFile ? null : file.content);
      assert.deepEqual(admission.args, args);
      assert.ok(Object.isFrozen(admission));
      assert.ok(Object.isFrozen(admission.args));
      assert.ok(Object.isFrozen(admission.mutation));
      if (mode === 'settle-candidate') {
        const input: Parameters<typeof prepare>[0] = {
          workspaceKey: 'crash-session',
          acceptedRepositoryOwnerToken,
          acceptedRepositoryCapability: capability,
          toolName,
          args,
        };
        const aborted = new AbortController();
        aborted.abort(new Error('cancel admission'));
        await assert.rejects(
          prepare({ ...input, abortSignal: aborted.signal }),
          /cancel admission/,
        );
        const during = new AbortController();
        const pending = prepare({ ...input, abortSignal: during.signal });
        during.abort(new Error('cancel pending admission'));
        await assert.rejects(pending, /cancel pending admission/);
        await assert.rejects(prepare({ ...input, acceptedRepositoryOwnerToken: {} }));
        await assert.rejects(
          prepare({ ...input, workspaceKey: 'other-workspace' }),
          /does not match/,
        );
        for (const path of ['foo/../hello.txt', 'dir\\hello.txt', '/hello.txt'])
          await assert.rejects(prepare({ ...input, args: { ...args, path } }), /canonical path/);
        let getterCalls = 0;
        await assert.rejects(
          prepare({
            ...input,
            args: {
              path: args.path,
              get content() {
                getterCalls++;
                return 'bad';
              },
            },
          }),
          /Invalid managed/,
        );
        assert.equal(getterCalls, 0);
        assert.deepEqual(
          await stores.runtimeEventStore.readImmutableRuntimeEvents(
            identity.sessionId,
            identity.runId,
          ),
          [],
        );
      }
      await stores.runtimeEventStore.commitToolPrepared({
        operationId,
        journalEventId: `${operationId}_prepared`,
        providerToolCallId: callId,
        toolName,
        canonicalArgsHash: canonicalToolArgsHash(toolName, args),
        recoveryMode: 'reconcile',
        committedAt: 1,
        runtimeEvent: {
          id: 'settlement-call-event',
          ...identity,
          ts: 1,
          partial: false,
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: callId, name: toolName, args },
          refs: { operationId, toolCallId: callId },
        },
        dispatchRuntimeEvent: {
          id: 'settlement-dispatch-event',
          ...identity,
          ts: 1,
          partial: false,
          role: 'system',
          author: 'system',
          refs: { operationId, toolCallId: callId },
          actions: {
            toolDispatch: {
              protocol: 't1_after_preflight_v1',
              operationId,
              providerToolCallId: callId,
              toolName,
              canonicalArgsHash: canonicalToolArgsHash(toolName, args),
              recoveryMode: 'reconcile',
              managedMutation: admission.mutation,
            },
          },
        },
      });
      await assert.rejects(
        prepare({
          workspaceKey: 'crash-session',
          acceptedRepositoryOwnerToken,
          acceptedRepositoryCapability: capability,
          toolName,
          args,
        }),
        /unsettled mutation/,
      );
    }
    if (mode === 'crash-after-edit-rejection' || mode === 'settle-false-rejection') {
      const accept = owner.acceptRejectedOperation;
      const input: Parameters<typeof accept>[0] = {
        workspaceKey: 'crash-session',
        acceptedRepositoryOwnerToken,
        acceptedRepositoryCapability: capability,
        toolOutcome: {
          operationId,
          journalEventId: `${operationId}_outcome`,
          committedAt: 2,
          runtimeEvent: {
            id: 'settlement-outcome-event',
            ...identity,
            ts: 2,
            partial: false,
            role: 'tool',
            author: 'tool',
            refs: { operationId, toolCallId: callId },
            actions: {
              managedMutationTerminal: {
                protocol: 'managed_mutation_terminal_v1',
                operationId,
                dispatchEventId: 'settlement-dispatch-event',
                workspaceInstanceId: baseline!.head.workspaceEpochId.replace('epoch_', 'instance_'),
                terminalKind: 'operation_failed_no_effect',
              },
            },
            content: {
              kind: 'function_response',
              id: callId,
              name: toolName,
              isError: true,
              result: {
                kind: 'text',
                text: "old_string not found in hello.txt; it must match the file's text including whitespace and indentation",
              },
            },
          },
        },
      };
      if (mode === 'settle-false-rejection') {
        await assert.rejects(accept(input), /Operation has no deterministic rejection/);
        writeSync(1, JSON.stringify({ rejected: true }));
        process.exit(0);
      }
      await assert.rejects(accept({ ...input, acceptedRepositoryOwnerToken: {} }));
      await assert.rejects(
        accept({
          ...input,
          toolOutcome: {
            ...input.toolOutcome,
            runtimeEvent: {
              ...input.toolOutcome.runtimeEvent,
              content: {
                kind: 'function_response',
                id: callId,
                name: toolName,
                isError: true,
                result: { kind: 'text', text: 'unverified error' },
              },
            },
          },
        }),
        /Rejected outcome does not match/,
      );
      const { actions: _terminal, ...withoutTerminal } = input.toolOutcome.runtimeEvent;
      await assert.rejects(
        accept({
          ...input,
          toolOutcome: { ...input.toolOutcome, runtimeEvent: withoutTerminal },
        }),
        /terminal fact is missing/,
      );
      assert.equal(
        (await stores.runtimeEventStore.listUnsettledToolOperations(identity.sessionId)).length,
        1,
      );
      const accepted = await accept(input);
      const retry = await accept(input);
      assert.equal(accepted.created, true);
      assert.equal(retry.created, false);
      writeSync(1, JSON.stringify({ accepted, retry }));
      process.exit(79);
    }
    const candidate = await (mode === 'retry-candidate' || mode === 'conflicting-candidate'
      ? verifyExistingGitoxideCandidateInternal
      : createGitoxideCandidateInternal)({
      acceptedRepositoryOwnerToken,
      acceptedRepositoryCapability: capability,
      candidateOwnerToken,
      operationId,
      path: args.path,
      content:
        mode === 'conflicting-candidate' || mode === 'settle-wrong-content'
          ? 'conflicting result\n'
          : mode === 'settle-false-no-change'
            ? file.content
            : args.content,
    });
    const proof = requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal({
      acceptedRepositoryOwnerToken,
      acceptedRepositoryCapability: capability,
      candidateOwnerToken,
      candidateOutcomeCapability: candidate.candidateOutcomeCapability,
    });
    if (mode === 'recover-no-change') {
      const input = {
        workspaceKey: 'crash-session',
        ...identity,
        operationId,
        acceptedRepositoryOwnerToken,
        acceptedRepositoryCapability: capability,
      };
      const accepted = await owner.recoverCandidate(input);
      const retry = await owner.recoverCandidate(input);
      assert.deepEqual(accepted.event, retry.event);
      writeSync(1, JSON.stringify({ accepted, retry, proof }));
      process.exit(0);
    }
    if (settling) {
      const transformed = transformManagedMutation({
        toolName: 'Write',
        canonicalPath: args.path,
        baseContent: newFile ? null : file.content,
        args,
      });
      const toolOutcome = {
        operationId,
        journalEventId: `${operationId}_outcome`,
        committedAt: 2,
        runtimeEvent: {
          id: 'settlement-outcome-event',
          ...identity,
          ts: 2,
          partial: false,
          role: 'tool' as const,
          author: 'tool' as const,
          refs: { operationId, toolCallId: callId },
          ...(noChange
            ? {
                actions: {
                  managedMutationTerminal: {
                    protocol: 'managed_mutation_terminal_v1' as const,
                    operationId,
                    dispatchEventId: 'settlement-dispatch-event',
                    workspaceInstanceId: baseline!.head.workspaceEpochId.replace(
                      'epoch_',
                      'instance_',
                    ),
                    terminalKind: 'no_workspace_change' as const,
                  },
                },
              }
            : {}),
          content: {
            kind: 'function_response' as const,
            id: callId,
            name: 'Write',
            result: transformed.providerResult,
          },
        },
      };
      const accept = noChange ? owner.acceptUnchangedCandidate : owner.acceptPublishedCandidate;
      const input = {
        workspaceKey: 'crash-session',
        acceptedRepositoryOwnerToken,
        acceptedRepositoryCapability: capability,
        candidateOwnerToken,
        candidateOutcomeCapability: candidate.candidateOutcomeCapability,
        toolOutcome,
      };
      if (mode === 'settle-wrong-content' || mode === 'settle-false-no-change') {
        await assert.rejects(
          accept(input),
          /Candidate content does not match the durable operation/,
        );
        writeSync(
          1,
          JSON.stringify({
            rejected: true,
            unsettled: await stores.runtimeEventStore.listUnsettledToolOperations(
              identity.sessionId,
            ),
          }),
        );
      } else {
        await assert.rejects(
          (noChange ? owner.acceptPublishedCandidate : owner.acceptUnchangedCandidate)(input),
          /disposition does not match/,
        );
        await assert.rejects(accept({ ...input, candidateOwnerToken: {} }));
        if (noChange) {
          await assert.rejects(
            accept({
              ...input,
              toolOutcome: {
                ...toolOutcome,
                runtimeEvent: {
                  ...toolOutcome.runtimeEvent,
                  content: { ...toolOutcome.runtimeEvent.content, isError: true },
                },
              },
            }),
            /outcome does not match/,
          );
          const { actions: _terminal, ...withoutTerminal } = toolOutcome.runtimeEvent;
          await assert.rejects(
            accept({ ...input, toolOutcome: { ...toolOutcome, runtimeEvent: withoutTerminal } }),
            /terminal fact is missing/,
          );
        }
        await assert.rejects(
          accept({
            ...input,
            toolOutcome: {
              ...toolOutcome,
              runtimeEvent: {
                ...toolOutcome.runtimeEvent,
                content: { ...toolOutcome.runtimeEvent.content, result: { fake: 'success' } },
              },
            },
          }),
          /outcome does not match/,
        );
        const accepted = await accept(input);
        if (mode === 'settle-candidate') {
          await assert.rejects(
            owner.prepareMutation({
              workspaceKey: 'crash-session',
              acceptedRepositoryOwnerToken,
              acceptedRepositoryCapability: capability,
              toolName,
              args,
            }),
            /does not match current accepted workspace/,
          );
        }
        if (
          mode === 'crash-after-settlement' ||
          mode === 'crash-after-new-file' ||
          mode === 'crash-after-no-change'
        ) {
          writeSync(1, JSON.stringify({ accepted, proof }));
          process.exit(79);
        }
        const retry = await accept(input);
        writeSync(
          1,
          JSON.stringify({
            accepted,
            retry,
            proof,
            unsettled: await stores.runtimeEventStore.listUnsettledToolOperations(
              identity.sessionId,
            ),
          }),
        );
      }
    } else {
      writeSync(1, JSON.stringify({ proof, acceptedContent: file.content }));
      if (mode === 'crash-after-candidate') process.exit(78);
    }
  } else {
    writeSync(
      1,
      JSON.stringify({
        content: file.content,
        commit: file.acceptedCommitOid,
        tree: file.acceptedTreeOid,
      }),
    );
  }
} finally {
  await stores.sessionStore.close?.();
  await leaseOwner.close();
}
