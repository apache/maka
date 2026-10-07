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

import { buildBackgroundTaskHealthTool } from '@maka/runtime/background-task-health-tool';
import { buildRecallTools, type RecallToolDeps } from '@maka/runtime/recall-tools';
import { RECALL_SYNTHETIC_TEXT_PATTERNS } from '@maka/runtime/recall-candidates';
import type { SessionManager } from '@maka/runtime/session-manager';
import { createArtifactAttachmentResourceReader } from '@maka/storage/artifact-stores';
import { createReadImageSnapshotStore } from '@maka/storage/read-image-snapshot-store';
import type { StorageWriterComposition } from '@maka/storage/storage-writer-composition';
import { createHostChildAgentToolComposition } from './child-agent-composition.js';
import { createHostExecutionArtifactServices } from './execution-artifacts.js';
import { HostRecallCoordinator } from './recall-coordinator.js';
import { createRecallMaterialFetch } from './recall-material-fetch.js';
import type { HostRuntimePolicyCoordinator } from './runtime-policy-coordinator.js';
import type { HostRuntimeResourceCoordinator } from './runtime-resource-coordinator.js';
import type { RuntimeHostSandboxComposition } from './sandbox-composition.js';
import { createHostWebFetchService, createHostWebFetchToolFromService } from './web-fetch-tool.js';
import {
  createHostWebSearchService,
  createHostWebSearchToolFromService,
} from './web-search-tool.js';

export type RuntimeHostToolComposition = ReturnType<typeof createRuntimeHostToolComposition>;

/** Owns the shared builtin, recall, web, and child-agent tool surfaces. */
export function createRuntimeHostToolComposition(input: {
  readonly artifacts: StorageWriterComposition['artifacts'];
  readonly contextOffload: StorageWriterComposition['contextOffload'];
  readonly stores: StorageWriterComposition['execution'];
  readonly longTermMemory: StorageWriterComposition['longTermMemory'];
  readonly runtimePolicyStores: StorageWriterComposition['runtimePolicy'];
  readonly requestDrain: () => void;
  readonly sessionAdmission: Parameters<
    typeof createHostExecutionArtifactServices
  >[0]['sessionAdmission'];
  readonly archiveEvidence: Parameters<
    typeof createHostExecutionArtifactServices
  >[0]['archiveEvidence'];
  readonly runtimePolicy: Pick<HostRuntimePolicyCoordinator, 'modelTools'>;
  readonly runtimeResources: HostRuntimeResourceCoordinator;
  readonly sandbox: Pick<RuntimeHostSandboxComposition, 'sandboxManager' | 'filesystemWorker'>;
  readonly getSessionManager: () => SessionManager;
}) {
  const {
    artifacts: openedArtifactStore,
    contextOffload: openedContextOffloadStore,
    longTermMemory: longTermMemoryStore,
    stores,
    runtimePolicyStores,
    requestDrain,
    sessionAdmission,
    archiveEvidence,
    runtimePolicy,
    runtimeResources,
    getSessionManager,
  } = input;
  const { sandboxManager, filesystemWorker } = input.sandbox;
  const executionArtifacts = createHostExecutionArtifactServices({
    archiveEvidence,
    artifacts: openedArtifactStore,
    requestDrain,
    sessionAdmission,
    sessions: stores.sessionStore,
  });
  // Shared with recall's material fetch, so a file brought in from another
  // Session is answered by the same reader that answers one stored here.
  const attachmentResources = createArtifactAttachmentResourceReader({
    artifactStore: openedArtifactStore,
  });
  const builtinTools = {
    shellRuns: runtimeResources,
    runtimeResources,
    attachmentResources,
    backgroundTasks: runtimeResources,
    ptyControls: runtimeResources,
    ...(openedContextOffloadStore
      ? {
          snapshotImage: async (input: {
            readonly sessionId: string;
            readonly ownerId: string;
            readonly bytes: Uint8Array;
            readonly mimeType: string;
          }) =>
            createReadImageSnapshotStore(openedContextOffloadStore, input.sessionId).snapshot({
              ownerId: input.ownerId,
              bytes: input.bytes,
              mimeType: input.mimeType,
            }),
          releaseImageSnapshot: async (input: {
            readonly sessionId: string;
            readonly refId: string;
          }) => {
            await openedContextOffloadStore.releaseReference(input);
          },
        }
      : {}),
    ...(sandboxManager ? { sandboxManager } : {}),
    ...(filesystemWorker ? { filesystemWorker } : {}),
  };
  const webSearchService = createHostWebSearchService({
    policy: runtimePolicyStores.operations,
  });
  const webFetchService = createHostWebFetchService({
    policy: runtimePolicyStores.operations,
  });
  const backgroundTaskHealthTool = buildBackgroundTaskHealthTool(runtimeResources, webFetchService);
  // The recall surface is built once and shared: the model's tools and the
  // Host's `recall.query` operation answer from the same dependency graph, so
  // a UI search and a model recall cannot diverge in what they can see.
  const recallDeps: RecallToolDeps = {
    listSessions: () => getSessionManager().listSessions(),
    readMessages: async (sessionId, abortSignal) =>
      readRuntimeHostHistoryMessages(getSessionManager, sessionId, abortSignal),
    listCandidateSessions: async ({ terms, sessionIds, abortSignal }) => {
      if (abortSignal?.aborted) return null;
      // A storage failure only costs speed here: declining the fast path
      // sends recall back to reading transcripts, which yields the same
      // answer. Returning a partial candidate set instead would break the
      // superset contract and silently drop matches.
      const candidates = await getSessionManager()
        .listRecallCandidateSessions(sessionIds, terms)
        .catch(() => undefined);
      if (abortSignal?.aborted || !candidates) return null;
      return candidates;
    },
    countSearchableMessages: async ({ sessionIds }) =>
      (await getSessionManager()
        .countRecallSearchableMessages(sessionIds)
        .catch(() => undefined)) ?? null,
    syntheticTextPatterns: RECALL_SYNTHETIC_TEXT_PATTERNS,
    fetchMaterial: createRecallMaterialFetch({
      artifacts: openedArtifactStore,
      attachments: attachmentResources,
    }),
    searchFacts: async ({ sessionId, terms, limit }) => {
      const workspaceKey = sessionId
        ? await stores.sessionStore
            .readHeaderSnapshot(sessionId)
            .then((header) => header.workspaceRoot)
            .catch(() => undefined)
        : undefined;
      const records = await longTermMemoryStore.searchByKeys({
        terms,
        match: 'prefix',
        ...(workspaceKey ? { workspaceKey } : {}),
        limit,
      });
      return records.map((record) => ({
        content: record.item.content,
        kind: record.item.kind,
        observedAt: record.item.observedAt,
      }));
    },
    getPrivacyContext: async () => ({
      incognitoActive: (await runtimePolicyStores.runtimePolicy.getSnapshot()).policy.privacy
        .incognitoActive,
    }),
  };
  const recallTools = buildRecallTools(recallDeps);
  const recall = new HostRecallCoordinator(recallDeps);
  const childHostTools = [
    createHostWebSearchToolFromService(webSearchService),
    createHostWebFetchToolFromService(webFetchService),
    backgroundTaskHealthTool,
    ...runtimePolicy.modelTools,
  ];
  const hostTools = [...childHostTools, ...recallTools];
  const childAgentTools = createHostChildAgentToolComposition({
    builtinTools,
    hostTools: childHostTools,
    worktreePatchWriteBackAvailable: true,
  });
  return Object.freeze({
    executionArtifacts,
    builtinTools,
    webSearchService,
    webFetchService,
    recall,
    hostTools,
    childAgentTools,
  });
}

export async function readRuntimeHostHistoryMessages(
  getSessionManager: () => Pick<SessionManager, 'getMessages'>,
  sessionId: string,
  abortSignal?: AbortSignal,
): Promise<Awaited<ReturnType<SessionManager['getMessages']>> | null> {
  if (abortSignal?.aborted) return null;
  const messages = await getSessionManager()
    .getMessages(sessionId)
    .catch(() => null);
  return abortSignal?.aborted ? null : messages;
}
