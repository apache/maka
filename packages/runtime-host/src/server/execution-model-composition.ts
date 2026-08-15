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
import { buildPricingLookup, recordToolInvocation } from '@maka/runtime/telemetry';
import { buildProviderOptions, getAIModel } from '@maka/runtime/model-factory';
import { createProviderRequestCaptureRecorder } from '@maka/runtime/provider-request-telemetry';
import {
  createProxiedFetchTransport,
  type ProxiedFetchProxy,
  type ProxiedFetchTransport,
} from '@maka/runtime/network/scoped-fetch-transport';
import { stableHash, toolCatalogHash } from '@maka/runtime/request-shape';
import { toolAvailabilityHash } from '@maka/runtime/tool-availability';
import { type BackendFactoryContext } from '@maka/runtime/session-manager';
import { type RuntimeCommitSink } from '@maka/runtime/runtime-commit-sink';
import {
  createAttachmentByteReader,
  persistProviderRequestCaptureArtifact,
  type InteractiveArtifactStoreWriter,
} from '@maka/storage/artifact-stores';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';
import type { InteractiveUsageStoresWriter } from '@maka/storage/usage-stores';
import {
  createHostOAuthModelFetch,
  type HostOAuthExecutionAuthority,
} from './oauth-execution-authority.js';
import type { HostChildAgentBackendCapabilities } from './child-agent-composition.js';
import type { HostExecutionArtifactServices } from './execution-artifacts.js';
import type { HostMemoryExtractionCoordinator } from './memory-extraction-coordinator.js';
import { readDuringBackendCreation, resolveExecutionTarget } from './execution-model-authority.js';
import { toRuntimePolicyProxy } from './runtime-policy-proxy.js';
import type { HostRunComposer, HostRunComposerFactory } from './host-run-composer.js';

export interface HostAiSdkBackendInput {
  readonly context: BackendFactoryContext;
  readonly runtimePolicy: HostExecutionRuntimePolicyAuthority;
  readonly oauthCredentials: HostOAuthExecutionAuthority;
  readonly claudeDeviceId: string;
  readonly createRunComposer: HostRunComposerFactory;
  readonly memoryExtraction?: HostMemoryExtractionCoordinator;
  readonly artifacts: HostExecutionArtifactAuthority;
  readonly executionArtifacts: HostExecutionArtifactServices;
  readonly usage: HostExecutionUsageAuthority;
  readonly requestDrain: () => void;
  readonly runtimeCommitSink?: RuntimeCommitSink;
  readonly childAgents?: HostChildAgentBackendCapabilities;
  readonly createFetchTransport?: (proxy: ProxiedFetchProxy | null) => ProxiedFetchTransport;
}

type HostExecutionRuntimePolicyAuthority = {
  readonly operations: Pick<RuntimePolicyStoresWriter['operations'], 'resolveExecutionConnection'>;
  readonly runtimePolicy: Pick<RuntimePolicyStoresWriter['runtimePolicy'], 'getSnapshot'>;
};

type HostExecutionArtifactAuthority = Pick<
  InteractiveArtifactStoreWriter,
  'create' | 'readDurableAttachmentBinary'
>;

type HostExecutionUsageAuthority = {
  readonly telemetry: Pick<InteractiveUsageStoresWriter['telemetry'], 'recordToolInvocation'>;
  readonly modelCalls: Pick<
    InteractiveUsageStoresWriter['modelCalls'],
    'markRunPendingReprojection' | 'recordModelCallAttempt' | 'clearPendingReprojection'
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
        claudeDeviceId: input.claudeDeviceId,
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
   * A failed projection is recoverable, not lost: the run is marked so the
   * Usage authority re-derives it from the stream, and even a lost marker is
   * recovered by a full re-projection. Neither step may fail the turn — the
   * provider call has already completed and billed.
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
    // Mark before projecting, not after failing. A marker written only on a
    // caught error cannot cover the case the error path never runs — the
    // process exiting between the two writes — which would leave the record in
    // the authority and invisible to Usage. Marking first makes this an intent
    // record: a crash anywhere after it still leaves a run the repair finds.
    await input.usage.modelCalls
      .markRunPendingReprojection(attempt.sessionId, attempt.runId)
      .catch(() => undefined);
    await input.usage.modelCalls.recordModelCallAttempt(attempt);
    await input.usage.modelCalls
      .clearPendingReprojection(attempt.sessionId, attempt.runId)
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
  let artifactDrainRequested = false;
  const providerRequestCapture = input.context.recordProviderRequestCapture
    ? createProviderRequestCaptureRecorder({
        persistArtifact: async (capture) => {
          try {
            const artifact = await persistProviderRequestCaptureArtifact(input.artifacts, {
              sessionId: input.context.sessionId,
              turnId: capture.turnId,
              captureId: capture.captureId,
              step: capture.step,
              serializedRequest: capture.serializedRequest,
              now: Date.now(),
            });
            return { artifactId: artifact.id };
          } catch (error) {
            if (!artifactDrainRequested) {
              artifactDrainRequested = true;
              input.requestDrain();
            }
            throw error;
          }
        },
        recordLedger: input.context.recordProviderRequestCapture,
      })
    : undefined;
  const recordProviderRequestAttempt = input.context.recordProviderRequestAttempt ?? (() => {});
  const resolveRunPrompt = async (context: {
    readonly turnId: string;
    readonly runId?: string;
    readonly emitSkillCatalogTrace?: (message: string, data?: Record<string, unknown>) => void;
  }) => {
    return await modelComposition.resolveSystemPrompt({
      sessionId: input.context.sessionId,
      turnId: context.turnId,
      ...(context.runId ? { runId: context.runId } : {}),
      cwd: input.context.header.cwd,
      workspaceRoot: input.context.workspaceRoot,
      ...(context.emitSkillCatalogTrace
        ? { emitSkillCatalogTrace: context.emitSkillCatalogTrace }
        : {}),
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
        contextBudget: buildDefaultContextBudgetPolicy(target.connection, {
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
        summarizeHistoryCompact: buildLlmHistorySummarizer({
          resolveModel: () =>
            modelFactory({
              connection: target.connection,
              apiKey,
              modelId: target.model,
            }),
          providerOptions,
        }),
        recordHistoryCompactCheckpoint: input.context.recordHistoryCompactCheckpoint,
        loadTurnRuntimeEvents: input.context.loadTurnRuntimeEvents,
        allowMidTurnHistoryCompaction: input.context.allowMidTurnHistoryCompaction,
        recordActiveFullCompactBlock: input.context.recordActiveFullCompactBlock,
        recordSemanticCompactBlock: input.context.recordSemanticCompactBlock,
        recordRunTrace: input.context.recordRunTrace,
        ...(commitRunComposition
          ? {
              beforeRunProviderDispatch: commitRunComposition,
            }
          : {}),
        systemPrompt: async (context) => {
          const resolved = await resolveRunPrompt({
            turnId: context.turnId,
            ...(context.runId ? { runId: context.runId } : {}),
            ...(context.emitSkillCatalogTrace
              ? { emitSkillCatalogTrace: context.emitSkillCatalogTrace }
              : {}),
          });
          return resolved.text;
        },
        turnTailPrompt: modelComposition.turnTailPrompt,
        shellRunContextSummary: input.context.shellRunContextSummary,
        lookupPricing: pricing,
        recordModelCallAttempt,
        assertModelCallAccountingReady,
        recordToolInvocation: (event) => recordToolInvocation({ repo: telemetry }, event),
        ...(input.runtimeCommitSink ? { runtimeCommitSink: input.runtimeCommitSink } : {}),
        ...(providerRequestCapture
          ? {
              recordProviderRequestCapture: providerRequestCapture,
              ...(input.context.recordProviderRequestAttempt
                ? {
                    recordProviderRequestAttempt,
                  }
                : {}),
            }
          : {}),
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
