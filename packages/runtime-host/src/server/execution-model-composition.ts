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
import { createRunCompositionSnapshot } from '@maka/core/run-composition';
import { resolveModelVisionSupport } from '@maka/core/model-metadata';
import { relayModelProfile } from '@maka/core/model-thinking';
import type { ModelCallAttempt } from '@maka/core/model-call-attempt';
import type { ModelCallCommit } from '@maka/core/agent-run';
import type { PermissionMode } from '@maka/core/permission';
import { AiSdkBackend } from '@maka/runtime/ai-sdk-backend';
import {
  buildDefaultContextBudgetPolicy,
  resolveSelectedModelContextWindow,
} from '@maka/runtime/context-budget-policy';
import { buildLlmHistorySummarizer } from '@maka/runtime/history-compact-summarizer';
import {
  buildOpenAiCodexHistoryCompactor,
  withOpenAiCodexHistoryCompactionFallback,
} from '@maka/runtime/openai-codex-history-compactor';
import { buildPricingLookup, recordToolInvocation } from '@maka/runtime/telemetry';
import { buildProviderOptions, getAIModel } from '@maka/runtime/model-factory';
import {
  createProxiedFetchTransport,
  type ProxiedFetchProxy,
  type ProxiedFetchTransport,
} from '@maka/runtime/network/scoped-fetch-transport';
import { stableHash, toolCatalogHash } from '@maka/runtime/request-shape';
import { toolAvailabilityHash } from '@maka/runtime/tool-availability';
import {
  type BackendFactoryContext,
  type BackendPreparationContext,
  type PreparedBackendActivation,
} from '@maka/runtime/session-manager';
import { type RuntimeCommitSink } from '@maka/runtime/runtime-commit-sink';
import {
  createAttachmentByteReader,
  createReadImageSnapshotPlanner,
  persistProviderRequestCaptureArtifact,
  type InteractiveArtifactStoreWriter,
} from '@maka/storage/artifact-stores';
import type { InteractiveContextOffloadReader } from '@maka/storage/context-offload-store';
import { createReadImageSnapshotReader } from '@maka/storage/read-image-snapshot-store';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';
import type { InteractiveUsageStoresWriter } from '@maka/storage/usage-stores';
import {
  createHostOAuthModelFetch,
  type HostOAuthExecutionAuthority,
} from './oauth-execution-authority.js';
import type { HostChildAgentBackendCapabilities } from './child-agent-composition.js';
import type { HostExecutionArtifactServices } from './execution-artifacts.js';
import type { HostMemoryExtractionCoordinator } from './memory-extraction-coordinator.js';
import {
  readDuringBackendCreation,
  resolveExecutionTarget,
  type ResolvedExecutionTarget,
} from './execution-model-authority.js';
import { toRuntimePolicyProxy } from './runtime-policy-proxy.js';
import type { HostRunComposer, HostRunComposerFactory } from './host-run-composer.js';

export interface HostAiSdkBackendInput {
  readonly context: BackendFactoryContext;
  readonly runtimePolicy: HostExecutionRuntimePolicyAuthority;
  readonly oauthCredentials: HostOAuthExecutionAuthority;
  readonly createRunComposer: HostRunComposerFactory;
  readonly memoryExtraction?: HostMemoryExtractionCoordinator;
  readonly artifacts: HostExecutionArtifactAuthority;
  readonly contextOffload?: InteractiveContextOffloadReader;
  readonly contextOffloadUnavailable?: boolean;
  readonly executionArtifacts: HostExecutionArtifactServices;
  readonly usage: HostExecutionUsageAuthority;
  readonly requestDrain: () => void;
  readonly runtimeCommitSink?: RuntimeCommitSink;
  readonly childAgents?: HostChildAgentBackendCapabilities;
  readonly createFetchTransport?: (proxy: ProxiedFetchProxy | null) => ProxiedFetchTransport;
}

export type HostAiSdkBackendPreparationInput = Omit<HostAiSdkBackendInput, 'context'> & {
  readonly context: BackendPreparationContext;
};

type HostExecutionRuntimePolicyAuthority = {
  readonly operations: Pick<RuntimePolicyStoresWriter['operations'], 'resolveExecutionConnection'>;
  readonly runtimePolicy: Pick<RuntimePolicyStoresWriter['runtimePolicy'], 'getSnapshot'>;
};

type HostExecutionArtifactAuthority = Pick<
  InteractiveArtifactStoreWriter,
  'create' | 'createOwned' | 'readDurableAttachmentBinary' | 'deleteOwnedArtifactInSession'
>;

type HostExecutionUsageAuthority = {
  readonly telemetry: Pick<InteractiveUsageStoresWriter['telemetry'], 'recordToolInvocation'>;
  readonly modelCalls: Pick<
    InteractiveUsageStoresWriter['modelCalls'],
    'catchUpModelCallProjection'
  >;
  readonly pricing: Pick<InteractiveUsageStoresWriter['pricing'], 'snapshot'>;
};

/** Builds one real provider backend from canonical Host state. */
export async function createHostAiSdkBackend(input: HostAiSdkBackendInput): Promise<AiSdkBackend> {
  const createFetchTransport = input.createFetchTransport ?? createProxiedFetchTransport;
  const target = await readDuringBackendCreation(
    () =>
      resolveExecutionTarget(
        input.context.header,
        input.runtimePolicy,
        input.oauthCredentials,
        createFetchTransport,
      ),
    input.context.abortSignal,
  );
  return await buildHostAiSdkBackend(input, target);
}

async function buildHostAiSdkBackend(
  input: HostAiSdkBackendInput,
  target: ResolvedExecutionTarget,
): Promise<AiSdkBackend> {
  const createFetchTransport = input.createFetchTransport ?? createProxiedFetchTransport;
  const pricingSnapshot = await readDuringBackendCreation(
    () => input.usage.pricing.snapshot(),
    input.context.abortSignal,
  );
  const pricing = buildPricingLookup(pricingSnapshot.overrides);
  const runtimePolicySnapshot = await readDuringBackendCreation(
    () => input.runtimePolicy.runtimePolicy.getSnapshot(),
    input.context.abortSignal,
  );
  const transport = createFetchTransport(
    toRuntimePolicyProxy(target.networkProxy, target.proxySecret),
  );
  let apiKey = target.apiKey;
  let modelFetch: typeof fetch = transport.fetch;
  const oauthBinding = target.oauthBinding;
  if (oauthBinding) {
    try {
      const initialOAuthTokens = await readDuringBackendCreation(
        () => oauthBinding.resolve(),
        input.context.abortSignal,
      );
      apiKey = initialOAuthTokens.access_token;
      modelFetch = createHostOAuthModelFetch({
        binding: oauthBinding,
        initialTokens: initialOAuthTokens,
        connection: target.connection,
        sessionId: input.context.sessionId,
        modelId: target.model,
        fetchFn: transport.fetch,
      });
    } catch (error) {
      await transport.close();
      throw error;
    }
  }
  const providerOptions = buildProviderOptions(
    target.connection,
    target.model,
    input.context.header.thinkingLevel,
  );
  const contextWindow = resolveSelectedModelContextWindow(target.connection, target.model);
  let modelComposition: HostRunComposer;
  try {
    modelComposition = await readDuringBackendCreation(
      async () =>
        await input.createRunComposer({
          backendContext: input.context,
          connection: target.connection,
          modelId: target.model,
          runtimePolicy: runtimePolicySnapshot,
          contextWindow: contextWindow ?? null,
        }),
      input.context.abortSignal,
    );
  } catch (error) {
    await transport.close();
    throw error;
  }
  const modelFactory = (
    modelInput: Parameters<typeof getAIModel>[0],
  ): ReturnType<typeof getAIModel> =>
    getAIModel({
      ...modelInput,
      fetch: modelFetch,
      requestHeaders: target.requestHeaders,
    });
  const resolveHistoryCompactModel = () =>
    getAIModel({
      connection: target.connection,
      apiKey,
      modelId: target.model,
      fetch: modelFetch,
      requestHeaders: target.requestHeaders,
    });
  const textHistorySummarizer = buildLlmHistorySummarizer({
    resolveModel: resolveHistoryCompactModel,
    providerOptions,
  });
  const summarizeHistoryCompact =
    target.connection.providerType === 'openai-codex' && input.context.header.llmConnectionId
      ? withOpenAiCodexHistoryCompactionFallback(
          buildOpenAiCodexHistoryCompactor({
            resolveModel: resolveHistoryCompactModel,
            connectionId: input.context.header.llmConnectionId,
            providerStateIdentity: target.providerStateIdentity,
            modelId: target.model,
            providerOptions,
          }),
          textHistorySummarizer,
        )
      : textHistorySummarizer;
  const historyCompactRoute =
    target.connection.providerType === 'openai-codex' && input.context.header.llmConnectionId
      ? 'provider_native'
      : 'text_summary';
  let telemetryDrainRequested = false;
  const persistTelemetry = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      if (!telemetryDrainRequested) {
        telemetryDrainRequested = true;
        input.requestDrain();
      }
      throw error;
    }
  };
  const telemetry = {
    insertToolInvocation: (
      record: Parameters<typeof input.usage.telemetry.recordToolInvocation>[0],
    ) => persistTelemetry(() => input.usage.telemetry.recordToolInvocation(record)),
  };
  /**
   * One canonical record, one commit point (#1679).
   *
   * The AgentRun stream is the only durable authority. The Usage ledger is a
   * projection of it and is written only once the authority holds the record —
   * writing both in parallel would make the ledger a second source of truth,
   * free to diverge with no way back.
   *
   * A failed projection is recoverable, not lost: its checkpoint remains
   * behind the AgentRun sequence until a later catch-up consumes it. The
   * projection may not fail the turn — the provider call has already completed
   * and billed.
   */
  let accountingAuthorityFailed = false;
  const recordModelCallAttempt = async (
    commit: ModelCallCommit<ModelCallAttempt>,
  ): Promise<void> => {
    const attempt = commit.attempt;
    try {
      // Forwarded whole. Taking `attempt` alone here is what silently dropped
      // the derived latest-context row before it reached storage (#2323).
      await input.context.recordModelCallAttempt?.(commit);
    } catch (error) {
      accountingAuthorityFailed = true;
      throw error;
    }
    await input.usage.modelCalls
      .catchUpModelCallProjection({ sessionId: attempt.sessionId, runId: attempt.runId })
      .catch(() => undefined);
  };
  /**
   * Fail-closed pre-dispatch gate, keyed on the authority alone. A stale
   * projection is recoverable and must not block a send; an authority that has
   * stopped accepting records means the next dispatch produces spend nothing
   * will ever hold, so the send fails before the provider is called.
   *
   * Not `telemetryDrainRequested`: that flag tracks the frozen legacy table,
   * which no longer meters main sends at all.
   */
  const assertModelCallAccountingReady = (): void => {
    if (accountingAuthorityFailed) {
      throw new Error('Canonical model-call accounting authority is unavailable');
    }
  };
  const persistPreparedRequestArtifact = async (capture: {
    turnId: string;
    captureId: string;
    step: number;
    serializedRequest: string;
  }): Promise<{ artifactId: string }> => {
    const artifact = await persistProviderRequestCaptureArtifact(input.artifacts, {
      sessionId: input.context.sessionId,
      turnId: capture.turnId,
      captureId: capture.captureId,
      step: capture.step,
      serializedRequest: capture.serializedRequest,
      now: Date.now(),
    });
    return { artifactId: artifact.id };
  };
  const resolveRunPrompt = async (context: {
    readonly turnId: string;
    readonly emitSkillCatalogTrace?: (message: string, data?: Record<string, unknown>) => void;
  }) => {
    const resolved = await modelComposition.resolveSystemPrompt({
      sessionId: input.context.sessionId,
      turnId: context.turnId,
      cwd: input.context.header.cwd,
      ...(context.emitSkillCatalogTrace
        ? { emitSkillCatalogTrace: context.emitSkillCatalogTrace }
        : {}),
    });
    const model = target.model.replace(/[\r\n\t]+/g, ' ').trim();
    return Object.freeze({
      ...resolved,
      text: [`Active model: ${model}`, resolved.text].filter(Boolean).join('\n\n'),
    });
  };
  const recordRunComposition = input.context.recordRunComposition;
  const commitRunComposition = recordRunComposition
    ? async (context: { readonly turnId: string; readonly runId: string }): Promise<void> => {
        const resolved = await resolveRunPrompt(context);
        await recordRunComposition(
          context.runId,
          createRunCompositionSnapshot({
            composerId: modelComposition.composerId,
            composerRevision: modelComposition.composerRevision,
            sourceRevisions: resolved.sourceRevisions,
            baseSystemPromptHash: stableHash(resolved.text ?? ''),
            toolCatalogHash: toolCatalogHash(modelComposition.tools),
            toolAvailabilityHash: toolAvailabilityHash(modelComposition.toolAvailability),
            baseProviderOptionsHash: stableHash(providerOptions),
            toolNames: modelComposition.tools.map(({ name }) => name),
            contextWindow: contextWindow ?? null,
          }),
        );
      }
    : undefined;
  const planProjectionImage = createReadImageSnapshotPlanner(
    input.artifacts,
    (sessionId, artifactId) =>
      input.artifacts.deleteOwnedArtifactInSession(sessionId, artifactId, 'tool_result_projection'),
  );

  try {
    return new HostAiSdkBackend(
      {
        sessionId: input.context.sessionId,
        header: {
          ...input.context.header,
          model: target.model,
          permissionMode: resolveCollaborationPermissionMode({
            collaborationMode: input.context.header.collaborationMode ?? 'agent',
            permissionMode: input.context.header.permissionMode,
          }),
        },
        appendMessage:
          input.context.appendMessage ??
          ((message) => input.context.store.appendMessage(input.context.sessionId, message)),
        readExecutionBoundary: () =>
          input.context.store.readExecutionBoundary(input.context.sessionId),
        ...(input.context.store.createSandboxBoundaryRequest
          ? {
              createSandboxBoundaryRequest: (request) =>
                input.context.store.createSandboxBoundaryRequest!(request),
            }
          : {}),
        ...(input.context.store.settleSandboxBoundaryRequest
          ? {
              settleSandboxBoundaryRequest: (request) =>
                input.context.store.settleSandboxBoundaryRequest!(request),
            }
          : {}),
        connection: target.connection,
        providerStateIdentity: target.providerStateIdentity,
        apiKey,
        modelId: target.model,
        modelFactory,
        tools: [...modelComposition.tools],
        toolAvailability: modelComposition.toolAvailability,
        ...(modelComposition.planTraceContext
          ? { planTraceContext: modelComposition.planTraceContext }
          : {}),
        ...(!input.context.tools && input.childAgents ? input.childAgents : {}),
        providerOptions,
        contextBudget: buildDefaultContextBudgetPolicy({
          name: 'runtime-host-default-history-budget',
          modelId: target.model,
        }),
        supportsVision: resolveModelVisionSupport(
          target.connection.providerType,
          target.connection.models,
          target.model,
          relayModelProfile(target.connection, target.model)?.vision,
        ),
        readAttachmentBytes: createAttachmentByteReader({
          artifactStore: input.artifacts,
          sessionId: input.context.sessionId,
          ...(input.contextOffload
            ? {
                readImageSnapshots: createReadImageSnapshotReader(
                  input.contextOffload,
                  input.context.sessionId,
                ),
              }
            : {}),
          ...(!input.contextOffload && input.contextOffloadUnavailable
            ? { readImageSnapshotsUnavailable: true }
            : {}),
        }),
        prepareDurableProjectionArtifact: ({ turnId, bytes, mediaType }) =>
          planProjectionImage({
            sessionId: input.context.sessionId,
            turnId,
            name: 'Tool Result image',
            bytes,
            mimeType: mediaType,
          }),
        recordToolArtifacts: input.executionArtifacts.recordToolArtifacts,
        toolResultArchive: input.executionArtifacts.toolResultArchive,
        ...(!input.context.tools &&
        !input.context.header.subagentParent &&
        input.context.header.collaborationMode !== 'plan' &&
        input.memoryExtraction
          ? {
              memoryExtraction: input.memoryExtraction.sourceCapabilities(
                runtimePolicySnapshot.policy.privacy.incognitoActive
                  ? { allowed: false, reason: 'incognito' }
                  : runtimePolicySnapshot.policy.memory.enabled
                    ? { allowed: true }
                    : { allowed: false, reason: 'disabled' },
              ),
            }
          : {}),
        loadHistoryCompactCheckpoint: input.context.loadHistoryCompactCheckpoint,
        summarizeHistoryCompact,
        historyCompactRoute,
        recordHistoryCompactCheckpoint: input.context.recordHistoryCompactCheckpoint,
        loadModelProjectionTransitions: input.context.loadModelProjectionTransitions,
        recordModelProjectionTransition: input.context.recordModelProjectionTransition,
        loadTurnRuntimeEvents: input.context.loadTurnRuntimeEvents,
        allowMidTurnHistoryCompaction: input.context.allowMidTurnHistoryCompaction,
        recordRunTrace: input.context.recordRunTrace,
        ...(commitRunComposition
          ? {
              beforeRunProviderDispatch: commitRunComposition,
            }
          : {}),
        systemPrompt: async (context) => {
          const resolved = await resolveRunPrompt({
            turnId: context.turnId,
            ...(context.emitSkillCatalogTrace
              ? { emitSkillCatalogTrace: context.emitSkillCatalogTrace }
              : {}),
          });
          return resolved.text;
        },
        lookupPricing: pricing,
        recordModelCallAttempt,
        assertModelCallAccountingReady,
        persistPreparedRequestArtifact,
        recordToolInvocation: (event) => recordToolInvocation({ repo: telemetry }, event),
        ...(input.runtimeCommitSink ? { runtimeCommitSink: input.runtimeCommitSink } : {}),
        newId: randomUUID,
        now: Date.now,
      },
      transport.close,
      () => modelComposition.release?.(),
    );
  } catch (error) {
    try {
      await transport.close();
    } finally {
      modelComposition.release?.();
    }
    throw error;
  }
}

export async function prepareHostAiSdkBackend(
  input: HostAiSdkBackendPreparationInput,
): Promise<PreparedBackendActivation> {
  const createFetchTransport = input.createFetchTransport ?? createProxiedFetchTransport;
  const preparedTarget = await readDuringBackendCreation(
    () =>
      resolveExecutionTarget(
        input.context.header,
        input.runtimePolicy,
        input.oauthCredentials,
        createFetchTransport,
      ),
    input.context.abortSignal,
  );
  return {
    providerStateIdentity: preparedTarget.providerStateIdentity,
    build: (context) =>
      buildHostAiSdkBackend(
        {
          ...input,
          context,
        },
        preparedTarget,
      ),
  };
}

class HostAiSdkBackend extends AiSdkBackend {
  constructor(
    input: ConstructorParameters<typeof AiSdkBackend>[0],
    private readonly closeTransport: () => Promise<void>,
    private readonly releaseClientCapabilities: () => void,
  ) {
    super(input);
  }

  override async dispose(): Promise<void> {
    try {
      await super.dispose();
    } finally {
      try {
        await this.closeTransport();
      } finally {
        this.releaseClientCapabilities();
      }
    }
  }
}

export function resolveCollaborationPermissionMode(input: {
  readonly collaborationMode: 'agent' | 'plan';
  readonly permissionMode: PermissionMode;
}): PermissionMode {
  return input.collaborationMode === 'plan' && input.permissionMode !== 'bypass'
    ? 'explore'
    : input.permissionMode;
}
