import { randomUUID } from 'node:crypto';
import { createRunCompositionSnapshot } from '@maka/core/run-composition';
import { resolveModelVisionSupport } from '@maka/core/model-metadata';
import { relayModelProfile } from '@maka/core/model-thinking';
import { effectiveBaseUrl, PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import type {
  ProviderCredentialResolver,
  ProviderCredentialSelectionReason,
} from '@maka/core/provider-credential-routing';
import type { RuntimePolicySnapshot } from '@maka/core/runtime-policy';
import type { ModelCallAttempt } from '@maka/core/model-call-attempt';
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
import {
  readDuringBackendCreation,
  resolveExecutionTarget,
  type ResolvedExecutionTarget,
} from './execution-model-authority.js';
import {
  createHostCredentialResolver,
  type HostCredentialResolver,
} from './provider-credential-resolver-composition.js';
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
  /** Test seam for asserting resolver ownership on backend-creation failures. */
  readonly createCredentialResolver?: (
    input: HostAiSdkBackendInput,
    target: ResolvedExecutionTarget,
  ) => Promise<HostCredentialResolver | undefined>;
  readonly childAgents?: HostChildAgentBackendCapabilities;
  readonly createFetchTransport?: (proxy: ProxiedFetchProxy | null) => ProxiedFetchTransport;
}

type HostExecutionRuntimePolicyAuthority = RuntimePolicyStoresWriter;

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
  // Credential Profile routing (PR 3 baseline): when the resolved connection
  // declares balanced routing and the provider uses API keys, compose the
  // resolver from the Router (PR 2) + Catalog/Vault/Health. OAuth providers
  // stay on the legacy path until PR 5, and legacy_primary/missing routing
  // keeps the fixed-key fast path byte-for-byte identical.
  let credentialResolver: HostCredentialResolver | undefined;
  try {
    credentialResolver = await (input.createCredentialResolver ?? buildCredentialResolver)(input, target);
  } catch (error) {
    // buildCredentialResolver owns its routing store only after creation;
    // a throw inside leaves nothing to dispose, so just propagate.
    throw error;
  }
  // The resolver holds an operational DB lease from the moment it is
  // created until the backend takes ownership: any failure before that
  // point must dispose it, or the lease leaks.
  let pricingSnapshot: Awaited<ReturnType<HostAiSdkBackendInput['usage']['pricing']['snapshot']>>;
  let runtimePolicySnapshot: RuntimePolicySnapshot;
  let pricing: ReturnType<typeof buildPricingLookup>;
  try {
    pricingSnapshot = await readDuringBackendCreation(
      () => input.usage.pricing.snapshot(),
      input.context.abortSignal,
    );
    pricing = buildPricingLookup(pricingSnapshot.overrides);
    runtimePolicySnapshot = await readDuringBackendCreation(
      () => input.runtimePolicy.runtimePolicy.getSnapshot(),
      input.context.abortSignal,
    );
  } catch (error) {
    credentialResolver?.dispose();
    throw error;
  }
  let transport: ProxiedFetchTransport | undefined;
  let modelComposition!: HostRunComposer;
  try {
    transport = createFetchTransport(toRuntimePolicyProxy(target.networkProxy, target.proxySecret));
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
      throw error;
    }
  }
  const providerOptions = buildProviderOptions(
    target.connection,
    target.model,
    input.context.header.thinkingLevel,
  );
  const contextWindow = resolveSelectedModelContextWindow(target.connection, target.model);
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
  const modelFactory = (
    modelInput: Parameters<typeof getAIModel>[0],
  ): ReturnType<typeof getAIModel> =>
    getAIModel({
      ...modelInput,
      fetch: modelInput.fetch ?? modelFetch,
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
  const recordModelCallAttempt = async (attempt: ModelCallAttempt): Promise<void> => {
    try {
      await input.context.recordModelCallAttempt?.(attempt);
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
        ...(credentialResolver && target.credentialRouting?.mode === 'balanced'
          ? {
              credentialRouting: {
                resolver: credentialResolver,
                connectionId: target.connectionId ?? '',
                providerId: target.connection.providerType,
                dispose: () => credentialResolver.dispose(),
              },
            }
          : {}),
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
          ? { memoryExtraction: input.memoryExtraction.sourceCapabilities() }
          : {}),
        loadHistoryCompactCheckpoint: input.context.loadHistoryCompactCheckpoint,
        summarizeHistoryCompact: buildLlmHistorySummarizer({
          resolveModel: (leasedApiKey, leasedFetch) =>
            modelFactory({
              connection: target.connection,
              apiKey: leasedApiKey ?? apiKey,
              modelId: target.model,
              ...(leasedFetch ? { fetch: leasedFetch } : {}),
            }),
          providerOptions,
          ...(credentialResolver
            ? {
                acquireCredential: () =>
                  acquireAuxiliaryHistoryCredential({
                    resolver: credentialResolver,
                    connectionId: target.connectionId ?? '',
                    connectionSlug: target.connection.slug,
                    providerId: target.connection.providerType,
                    modelId: target.model,
                    sessionId: input.context.sessionId,
                  }),
              }
            : {}),
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
      () => modelComposition?.release?.(),
    );
  } catch (error) {
    try {
      await transport?.close();
    } finally {
      modelComposition?.release?.();
      credentialResolver?.dispose();
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
/**
 * Build the Credential Profile resolver for a resolved execution target when
 * the connection is in balanced API-key routing mode; otherwise undefined
 * (legacy fast path). OAuth providers stay legacy until PR 5.
 */
async function buildCredentialResolver(
  input: HostAiSdkBackendInput,
  target: ResolvedExecutionTarget,
): Promise<HostCredentialResolver | undefined> {
  const routing = target.credentialRouting;
  if (!routing || routing.mode !== 'balanced' || !target.connectionId) return undefined;
  const provider = PROVIDER_DEFAULTS[target.connection.providerType];
  if (
    provider.authKind !== 'api_key' &&
    provider.authKind !== 'optional_api_key' &&
    provider.authKind !== 'oauth_token'
  ) {
    return undefined;
  }
  const model = target.connection.models?.find((candidate) => candidate.id === target.model);
  // Connection-level request headers are part of the execution basis digest
  // (RFC 8.4): their credential identity/revision must match what the
  // coordinator's balanced-activation gate computes, or verification written
  // at activation would not be visible to dispatch.
  const requestHeaders = await input.runtimePolicy.operations.exportCredentialMaterial({
    scope: 'connection',
    connectionId: target.connectionId,
    kind: 'request_headers',
  });
  return createHostCredentialResolver({
    runtimePolicy: input.runtimePolicy,
    workspaceRoot: input.context.workspaceRoot,
    connectionId: target.connectionId,
    connectionSlug: target.connection.slug,
    providerType: target.connection.providerType,
    endpoint: effectiveBaseUrl(target.connection),
    apiProtocol: model?.apiProtocol,
    requestHeadersCredentialId: requestHeaders?.credentialId ?? null,
    requestHeadersCredentialRevision: requestHeaders?.revision ?? null,
    requestBodyOverlayJson: target.connection.requestBodyOverlay
      ? JSON.stringify(target.connection.requestBodyOverlay)
      : null,
    authKind: provider.authKind,
    routing,
    ...(provider.authKind === 'oauth_token'
      ? {
          oauthCredentials: input.oauthCredentials,
          connection: target.connection,
          sessionId: input.context.sessionId,
          modelId: target.model,
          createFetchTransport: input.createFetchTransport ?? createProxiedFetchTransport,
          proxy: toRuntimePolicyProxy(target.networkProxy, target.proxySecret),
        }
      : {}),
  });
}

/**
 * Acquire a Credential Profile lease for the host history summarizer (RFC
 * 6.3/9.1). The summarizer runs outside the turn pump, so it binds on a
 * synthetic auxiliary turn id, settles with the real outcome, and releases
 * in a finally.
 */
async function acquireAuxiliaryHistoryCredential(input: {
  resolver: HostCredentialResolver;
  connectionId: string;
  connectionSlug: string;
  providerId: string;
  modelId: string;
  sessionId: string;
}): Promise<{
  apiKey?: string;
  attribution?: {
    profileId: string;
    selectionReason: ProviderCredentialSelectionReason;
  };
  settle(outcome: 'success' | 'failure' | 'aborted'): Promise<void>;
  release(): void;
}> {
  const auxiliaryTurnId = `aux:history:${input.sessionId}`;
  const lease = await input.resolver.acquireAttempt({
    connectionId: input.connectionId,
    connectionSlug: input.connectionSlug,
    providerId: input.providerId,
    modelId: input.modelId,
    sessionId: input.sessionId,
    turnId: auxiliaryTurnId,
    logicalCallId: auxiliaryTurnId,
    callKind: 'history_compact',
    excludedProfileIds: new Set(),
    reason: 'initial',
    signal: new AbortController().signal,
  });
  return {
    apiKey: lease?.apiKey,
    ...(lease
      ? {
          attribution: {
            profileId: lease.profileId,
            selectionReason: lease.selectionReason,
          },
        }
      : {}),
    settle: async (outcome) => {
      if (!lease) return;
      if (outcome === 'success') {
        await input.resolver.settle(lease, { kind: 'success' });
        return;
      }
      if (outcome === 'aborted') {
        await input.resolver.settle(lease, { kind: 'aborted' });
        return;
      }
      await input.resolver.settle(lease, {
        kind: 'failure',
        failure: { kind: 'unknown', retryable: false },
        routingHint: { kind: 'unknown', scope: 'unknown', evidence: 'provider_adapter' },
      });
    },
    release: () => {
      input.resolver.releaseTurn(input.sessionId, auxiliaryTurnId);
    },
  };
}
