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

import { buildHistoryTools } from '@maka/runtime/history-tools';
import type { SessionManager } from '@maka/runtime/session-manager';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import {
  createArtifactAttachmentResourceReader,
  createReadImageSnapshotter,
} from '@maka/storage/artifact-stores';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';
import {
  createHostChildAgentToolComposition,
  type HostChildAgentToolComposition,
} from './child-agent-composition.js';
import {
  createHostExecutionArtifactServices,
  type HostExecutionArtifactServices,
} from './execution-artifacts.js';
import type { HostRuntimePolicyCoordinator } from './runtime-policy-coordinator.js';
import type { HostRuntimeResourceCoordinator } from './runtime-resource-coordinator.js';
import type { RuntimeHostSandboxComposition } from './sandbox-composition.js';
import type { HostTaskLedgerCoordinator } from './task-ledger-coordinator.js';
import { createHostWebFetchService, createHostWebFetchToolFromService } from './web-fetch-tool.js';
import {
  createHostWebSearchService,
  createHostWebSearchToolFromService,
} from './web-search-tool.js';

export interface RuntimeHostToolComposition {
  readonly executionArtifacts: HostExecutionArtifactServices;
  readonly builtinTools: Parameters<typeof createHostChildAgentToolComposition>[0]['builtinTools'];
  readonly webSearchService: ReturnType<typeof createHostWebSearchService>;
  readonly webFetchService: ReturnType<typeof createHostWebFetchService>;
  readonly childHostTools: readonly MakaTool[];
  readonly hostTools: readonly MakaTool[];
  readonly childAgentTools: HostChildAgentToolComposition;
}

/** Composes the Host-owned tool catalog and the services shared by its tool surfaces. */
export function createRuntimeHostToolComposition(input: {
  readonly artifacts: Parameters<typeof createHostExecutionArtifactServices>[0]['artifacts'];
  readonly requestDrain: () => void;
  readonly runtimePolicyStores: RuntimePolicyStoresWriter;
  readonly runtimePolicy: Pick<HostRuntimePolicyCoordinator, 'modelTools'>;
  readonly runtimeResources: HostRuntimeResourceCoordinator;
  readonly sandbox: Pick<RuntimeHostSandboxComposition, 'sandboxManager' | 'filesystemWorker'>;
  readonly taskLedger: HostTaskLedgerCoordinator;
  readonly getSessionManager: () => SessionManager;
}): RuntimeHostToolComposition {
  const executionArtifacts = createHostExecutionArtifactServices({
    artifacts: input.artifacts,
    requestDrain: input.requestDrain,
  });
  const builtinTools = {
    shellRuns: input.runtimeResources,
    runtimeResources: input.runtimeResources,
    attachmentResources: createArtifactAttachmentResourceReader({ artifactStore: input.artifacts }),
    backgroundTasks: input.runtimeResources,
    ptyControls: input.runtimeResources,
    snapshotImage: createReadImageSnapshotter(input.artifacts),
    ...(input.sandbox.sandboxManager ? { sandboxManager: input.sandbox.sandboxManager } : {}),
    ...(input.sandbox.filesystemWorker ? { filesystemWorker: input.sandbox.filesystemWorker } : {}),
  };
  const webSearchService = createHostWebSearchService({
    policy: input.runtimePolicyStores.operations,
  });
  const webFetchService = createHostWebFetchService({
    policy: input.runtimePolicyStores.operations,
  });
  const historyTools = buildHistoryTools({
    listSessions: () => input.getSessionManager().listSessions(),
    readMessages: (sessionId, abortSignal) =>
      readRuntimeHostHistoryMessages(input.getSessionManager(), sessionId, abortSignal),
    getPrivacyContext: async () => ({
      incognitoActive: (await input.runtimePolicyStores.runtimePolicy.getSnapshot()).policy.privacy
        .incognitoActive,
    }),
  });
  const childHostTools = Object.freeze([
    createHostWebSearchToolFromService(webSearchService),
    createHostWebFetchToolFromService(webFetchService),
    ...input.runtimePolicy.modelTools,
  ]);
  const hostTools = Object.freeze([...childHostTools, ...historyTools]);
  const childAgentTools = createHostChildAgentToolComposition({
    taskLedger: input.taskLedger,
    builtinTools,
    hostTools: childHostTools,
    worktreePatchWriteBackAvailable: true,
  });
  return Object.freeze({
    executionArtifacts,
    builtinTools,
    webSearchService,
    webFetchService,
    childHostTools,
    hostTools,
    childAgentTools,
  });
}

export async function readRuntimeHostHistoryMessages(
  manager: Pick<SessionManager, 'getMessages'>,
  sessionId: string,
  abortSignal?: AbortSignal,
): Promise<Awaited<ReturnType<SessionManager['getMessages']>> | null> {
  if (abortSignal?.aborted) return null;
  const messages = await manager.getMessages(sessionId).catch(() => null);
  return abortSignal?.aborted ? null : messages;
}
