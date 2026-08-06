import { randomUUID } from 'node:crypto';
import type { SessionChangedReason, SessionEvent } from '@maka/core';
import type { ToolInvocationRecord } from '@maka/core/usage-stats/types';
import {
  AiSdkBackend,
  buildDefaultContextBudgetPolicy,
  buildLlmHistorySummarizer,
  buildProviderOptions,
  createProviderRequestCaptureRecorder,
  getAIModel,
  loadHistoryCompactBlocksFromArtifacts,
  loadSynthesisCacheBlocksFromArtifacts,
  persistSynthesisCacheBlocksToArtifacts,
  recordToolInvocation,
  renderPlanExecutionPrompt,
  renderInterruptedPlanContext,
  renderPlanModePrompt,
  resolveSelectedModelContextWindow,
} from '@maka/runtime';
import type {
  BackendFactory,
  GoalTurnOutcome,
  HostCapabilities,
  SessionActivityLease,
  SessionActivityRegistry,
  SessionManager,
  ToolArtifactRecorderInput,
  buildPricingLookup,
} from '@maka/runtime';
import type { createSqliteModelCallLedger } from '@maka/storage';
import {
  type ArtifactStore,
  createAttachmentByteReader,
  openRuntimeEventPersistence,
  persistProviderRequestCaptureArtifact,
  type TelemetryRepo,
} from '@maka/storage';
import { WEB_SEARCH_TOOL_NAME } from './web-search/agent-tool.js';
import { errorCode, errorMessage, errorReason } from './chat-readiness.js';
import type { assembleDesktopTools } from './tool-assembly.js';
import type { ToolArtifactPersistence } from './tool-artifact-persistence.js';
import type { createMainGoalWiring } from './goal-wiring.js';
import type { createSubscriptionModelFetch } from './subscription-model-fetch.js';
import type { createSystemPromptMainService } from './system-prompt-main.js';
import { startDesktopSessionTurn, type SessionGoalBoundary } from './session-turn-stream.js';
import {
  resolveDesktopBackendToolSurface,
  type DesktopBackendToolSurfaceDeps,
} from './desktop-backend-tool-surface.js';

type AssembledTools = ReturnType<typeof assembleDesktopTools>;
type SystemPromptMainService = ReturnType<typeof createSystemPromptMainService>;
type SubscriptionModelFetchBuilder = ReturnType<typeof createSubscriptionModelFetch>;
type GoalWiring = ReturnType<typeof createMainGoalWiring>;
type ModelCallLedger = ReturnType<typeof createSqliteModelCallLedger>;
type PricingLookup = ReturnType<typeof buildPricingLookup>;
type RuntimeCommitStore = Awaited<ReturnType<typeof openRuntimeEventPersistence>>['runtimeCommitStore'];
const SKILL_CATALOG_TRACE_DECISION_LIMIT = 100;

export interface AiSdkBackendFactoryDeps extends DesktopBackendToolSurfaceDeps {
  buildSubscriptionModelFetch: SubscriptionModelFetchBuilder;
  systemPromptService: SystemPromptMainService;
  telemetryRepo: TelemetryRepo;
  modelCallLedger: ModelCallLedger;
  ensureUsageReady: () => Promise<void>;
  artifactStore: ArtifactStore;
  desktopSessionSkillHosts: Map<string, HostCapabilities>;
  sandboxDiagnosticsProvider: AssembledTools['sandboxDiagnosticsProvider'];
  persistToolArtifacts: ToolArtifactPersistence['persistToolArtifacts'];
  toolResultArchive: ToolArtifactPersistence['toolResultArchive'];
  runtimeCommitStore: RuntimeCommitStore;
  safeSendToRenderer: (channel: string, ...args: unknown[]) => void;
  emitSessionsChanged: (reason: SessionChangedReason, sessionId?: string) => void;
  getRuntime: () => SessionManager;
  getLookupPricing: () => PricingLookup;
}

/**
 * Build the real `ai-sdk` backend factory (arch R5). Pure move of main.ts's
 * `backends.register('ai-sdk', async (ctx) => …)` closure. Two module-scoped
 * seams that resolve AFTER the registration point are injected as accessors:
 * `getRuntime` (the SessionManager is constructed after registration) and
 * `getLookupPricing` (a mutable pricing lookup reassigned by usage IPC + startup;
 * snapshotted once for the `lookupPricing` field — matching the original
 * module-`let` closure semantics exactly).
 */
export function createAiSdkBackendFactory(deps: AiSdkBackendFactoryDeps): BackendFactory {
  const {
    buildSubscriptionModelFetch,
    systemPromptService,
    telemetryRepo,
    modelCallLedger,
    ensureUsageReady,
    artifactStore,
    desktopSessionSkillHosts,
    sandboxDiagnosticsProvider,
    persistToolArtifacts,
    toolResultArchive,
    runtimeCommitStore,
    safeSendToRenderer,
    emitSessionsChanged,
    getRuntime,
    getLookupPricing,
  } = deps;

  return async (ctx) => {
    await ensureUsageReady();
    const toolSurface = await resolveDesktopBackendToolSurface(deps, ctx);
    const {
      connection,
      apiKey,
      model,
      supportsVision,
      collaborationMode,
      planState,
      activeExecution,
      interruptedExecution,
      selectedTools,
      toolAvailability: backendToolAvailability,
      skillHost: backendSkillHost,
      admitsAgentChildren,
    } = toolSurface;
    const modelFetch = buildSubscriptionModelFetch(connection, ctx.sessionId, model);
    const memoryPromptSnapshot = await systemPromptService.buildLocalMemoryPromptFragment(ctx.sessionId);
    // Legacy child-run backends share the parent sessionId; linked child
    // sessions have their own id. Both receive a narrower tool surface without
    // the Desktop Skill tool, so only a session's full backend owns this entry.
    if (!ctx.tools) desktopSessionSkillHosts.set(ctx.sessionId, backendSkillHost);
    const effectivePermissionMode = collaborationMode === 'plan' ? 'explore' : ctx.header.permissionMode;
    const sandboxDiagnosticsSnapshot = await sandboxDiagnosticsProvider.resolve({
      mode: effectivePermissionMode,
      cwd: ctx.header.cwd,
    });
    // Hoisted out of the backend input so the shape stays readable; the
    // auxiliary summarizer no longer needs any of it (#1679).
    const providerRequestCapture = ctx.recordProviderRequestCapture
      ? createProviderRequestCaptureRecorder({
          persistArtifact: async (capture) => {
            const artifact = await persistProviderRequestCaptureArtifact(artifactStore, {
              sessionId: ctx.sessionId,
              turnId: capture.turnId,
              captureId: capture.captureId,
              step: capture.step,
              serializedRequest: capture.serializedRequest,
              now: Date.now(),
            });
            return { artifactId: artifact.id };
          },
          recordLedger: ctx.recordProviderRequestCapture,
        })
      : undefined;

    return new AiSdkBackend({
      sessionId: ctx.sessionId,
      header: { ...ctx.header, model, permissionMode: effectivePermissionMode },
      appendMessage: ctx.appendMessage ?? ((message) => ctx.store.appendMessage(ctx.sessionId, message)),
      readExecutionBoundary: () => ctx.store.readExecutionBoundary!(ctx.sessionId),
      createSandboxBoundaryRequest: (request) =>
        ctx.store.createSandboxBoundaryRequest!(request),
      settleSandboxBoundaryRequest: (request) =>
        ctx.store.settleSandboxBoundaryRequest!(request),
      connection,
      apiKey: apiKey ?? '',
      modelId: model,
      modelFactory: (input) => getAIModel({ ...input, fetch: modelFetch }),
      tools: selectedTools,
      sandboxDiagnosticsSnapshot,
      planTraceContext: {
        mode: collaborationMode,
        storeVersion: planState.storeVersion,
        ...(activeExecution
          ? {
              planId: activeExecution.planId,
              proposalId: activeExecution.proposalId,
              executionId: activeExecution.executionId,
            }
          : {}),
      },
      toolAvailability: backendToolAvailability,
      ...(admitsAgentChildren
        ? {
            spawnChildAgent: (input) => getRuntime().spawnChildAgent(ctx.sessionId, input),
            spawnChildSession: (input) => {
              const observation = createLinkedChildEventProjection({
                lifecycle: 'created',
                safeSendToRenderer,
                emitSessionsChanged,
                onReady: input.onReady,
                onEvent: input.onEvent,
              });
              return getRuntime().spawnChildSession(ctx.sessionId, {
                spawnedBy: {
                  parentRunId: input.parentRunId,
                  parentTurnId: input.parentTurnId,
                  toolCallId: input.toolCallId,
                },
                agentProfile: input.agentProfile,
                ...(input.subagentId ? { subagentId: input.subagentId } : {}),
                prompt: input.prompt,
                ...(input.swarm ? { swarm: input.swarm } : {}),
                abortSignal: input.abortSignal,
                onReady: observation.onReady,
                onEvent: observation.onEvent,
              });
            },
            prepareChildAgentResume: (sourceRunId) =>
              getRuntime().prepareChildAgentResume(ctx.sessionId, sourceRunId),
            resumeChildAgent: (input) => {
              const observation = createLinkedChildEventProjection({
                lifecycle: 'continued',
                safeSendToRenderer,
                emitSessionsChanged,
                onReady: input.onReady,
                onEvent: input.onEvent,
              });
              return getRuntime().resumeChildAgent(ctx.sessionId, {
                ...input,
                onReady: observation.onReady,
                onEvent: observation.onEvent,
              });
            },
            retryChildAgent: (input) => {
              const observation = createLinkedChildEventProjection({
                lifecycle: 'continued',
                safeSendToRenderer,
                emitSessionsChanged,
                onReady: input.onReady,
                onEvent: input.onEvent,
              });
              return getRuntime().retryChildAgent(ctx.sessionId, {
                ...input,
                onReady: observation.onReady,
                onEvent: observation.onEvent,
              });
            },
            listChildAgents: () => getRuntime().listChildAgents(ctx.sessionId),
            readChildAgentOutput: (input) =>
              getRuntime().readChildAgentOutput(ctx.sessionId, input),
          }
        : {}),
      providerOptions: buildProviderOptions(connection, model, ctx.header.thinkingLevel),
      contextBudget: buildDefaultContextBudgetPolicy(connection, {
        name: 'desktop-default-history-budget',
        modelId: model,
      }),
      systemPrompt: async ({ cwd, emitSkillCatalogTrace }) => {
        const base = await systemPromptService.buildBackendSystemPrompt(
          ctx.header,
          cwd,
          {
            memoryFragment: memoryPromptSnapshot,
            childInstruction: ctx.systemPrompt,
            skillBudget: { contextWindow: resolveSelectedModelContextWindow(connection, model) },
            host: backendSkillHost,
          },
        );
        const skillReport = systemPromptService.getLastSkillSelectionReport(cwd);
        if (skillReport) {
          emitSkillCatalogTrace?.('Skill catalog selection completed', {
            policyVersion: skillReport.policyVersion,
            budgetChars: skillReport.budgetChars,
            usedChars: skillReport.usedChars,
            totalCount: skillReport.totalCount,
            eligibleCount: skillReport.eligibleCount,
            advertisedCount: skillReport.advertisedCount,
            omittedCount: skillReport.omittedCount,
            decisionCount: skillReport.decisions.length,
            decisionsTruncated:
              skillReport.decisions.length > SKILL_CATALOG_TRACE_DECISION_LIMIT,
            decisions: skillReport.decisions
              .slice(0, SKILL_CATALOG_TRACE_DECISION_LIMIT)
              .map((decision) => ({
                skillRef: decision.ref,
                reason: decision.reason,
                ...(decision.rank !== undefined ? { rank: decision.rank } : {}),
              })),
          });
        }
        return collaborationMode === 'plan' ? `${base}\n\n${renderPlanModePrompt()}` : base;
      },
      turnTailPrompt: async ({ cwd, sessionId }) => {
        const base = await systemPromptService.buildTurnTailPrompt(cwd, sessionId);
        const execution = activeExecution ?? (
          collaborationMode === 'plan' ? interruptedExecution : undefined
        );
        if (!execution) return base;
        const proposal = planState.proposals.find(
          (candidate) => candidate.proposalId === execution.proposalId,
        );
        if (!proposal) return base;
        const planContext = activeExecution
          ? renderPlanExecutionPrompt({ proposal, execution: activeExecution })
          : renderInterruptedPlanContext({ proposal, execution });
        return `${base}\n\n${planContext}`;
      },
      shellRunContextSummary: ctx.shellRunContextSummary,
      lookupPricing: getLookupPricing(),
      // One canonical record, one commit point (#1679): the AgentRun stream is
      // the only durable authority, and the ledger is a projection written only
      // after the authority holds the record. A failed projection marks the run
      // so the Usage read path re-derives it from the stream. Settlement runs
      // after the provider call completed and billed, so neither step may fail
      // the turn — the seam swallows what is thrown here.
      recordModelCallAttempt: async (attempt) => {
        await ctx.recordModelCallAttempt?.(attempt);
        // Marked before the projection, so a crash between the two still
        // leaves a run the repair path can find.
        await modelCallLedger
          .markRunPendingReprojection(attempt.sessionId, attempt.runId)
          .catch(() => undefined);
        await modelCallLedger.record(attempt);
        await modelCallLedger
          .clearPendingReprojection(attempt.sessionId, attempt.runId)
          .catch(() => undefined);
      },
      recordToolInvocation: (event: ToolInvocationRecord) =>
        recordToolInvocation(
          { repo: telemetryRepo },
          // PR-AGENT-WEB-SEARCH-TOOL-0: scrub the query out of the
          // telemetry record. The agent passes the raw user query as
          // the tool argument; persisting it in `argsSummary` would
          // leak user-derived content into the usage log.
          event.toolName === WEB_SEARCH_TOOL_NAME
            ? { ...event, argsSummary: undefined }
            : event,
        ),
      recordToolArtifacts: (event: ToolArtifactRecorderInput) => persistToolArtifacts(ctx.header.cwd, event),
      toolResultArchive,
      readAttachmentBytes: createAttachmentByteReader({ artifactStore, sessionId: ctx.sessionId }),
      ...(runtimeCommitStore
        ? { runtimeCommitSink: runtimeCommitStore }
        : {}),
      supportsVision,
      loadHistoryCompact: (event) => loadHistoryCompactBlocksFromArtifacts(artifactStore, event),
      loadHistoryCompactCheckpoint: ctx.loadHistoryCompactCheckpoint,
      summarizeHistoryCompact: buildLlmHistorySummarizer({
        // Reuse the same connection/model the session already drives, so the
        // summary stays consistent with the model that will consume it.
        resolveModel: () =>
          getAIModel({ connection, apiKey: apiKey ?? '', modelId: model, fetch: modelFetch }),
        providerOptions: buildProviderOptions(connection, model, ctx.header.thinkingLevel),
      }),
      loadSynthesisCache: (event) => loadSynthesisCacheBlocksFromArtifacts(artifactStore, event),
      writeSynthesisCache: (event) => persistSynthesisCacheBlocksToArtifacts(artifactStore, event, {
        onArtifactCreated: (artifact) => {
          safeSendToRenderer('artifacts:changed', {
            reason: 'created',
            artifactId: artifact.id,
            sessionId: artifact.sessionId,
            ts: Date.now(),
          });
        },
      }),
      recordRunTrace: ctx.recordRunTrace,
      ...(providerRequestCapture
        ? {
            recordProviderRequestCapture: providerRequestCapture,
            recordProviderRequestAttempt: ctx.recordProviderRequestAttempt,
          }
        : {}),
      recordHistoryCompactCheckpoint: ctx.recordHistoryCompactCheckpoint,
      loadTurnRuntimeEvents: ctx.loadTurnRuntimeEvents,
      allowMidTurnHistoryCompaction: ctx.allowMidTurnHistoryCompaction,
      recordActiveFullCompactBlock: ctx.recordActiveFullCompactBlock,
      recordSemanticCompactBlock: ctx.recordSemanticCompactBlock,
      newId: randomUUID,
      now: Date.now,
    });
  };
}

interface LinkedChildReady {
  childSessionId?: string;
  turnId: string;
  runId?: string;
  agentId: string;
  agentName: string;
}

/**
 * Bridge linked-child events onto the child Session's normal Desktop channel
 * while the parent tool call remains the stream consumer.
 * Direct user follow-ups already use createSessionStreamer; this closes the
 * nested spawn/resume/retry observation gap without inventing a subagent-only
 * event protocol.
 */
export function createLinkedChildEventProjection<
  Ready extends LinkedChildReady = LinkedChildReady,
>(input: {
  lifecycle: 'created' | 'continued';
  safeSendToRenderer: (channel: string, ...args: unknown[]) => void;
  emitSessionsChanged: (reason: SessionChangedReason, sessionId?: string) => void;
  onReady?: (ready: Ready) => void | Promise<void>;
  onEvent?: (event: SessionEvent) => void;
}): {
  onReady(ready: Ready): Promise<void>;
  onEvent(event: SessionEvent): void;
} {
  let childSessionId: string | undefined;
  let messageAppendBroadcasted = false;
  return {
    async onReady(ready) {
      childSessionId = ready.childSessionId;
      if (childSessionId) {
        input.emitSessionsChanged(
          input.lifecycle === 'created' ? 'created' : 'status-change',
          childSessionId,
        );
        input.emitSessionsChanged('turn-status-change', childSessionId);
      }
      await input.onReady?.(ready);
    },
    onEvent(event) {
      if (childSessionId) {
        input.safeSendToRenderer(`sessions:event:${childSessionId}`, event);
        if (!messageAppendBroadcasted) {
          input.emitSessionsChanged('message-appended', childSessionId);
          messageAppendBroadcasted = true;
        }
        if (isStatusChangingSessionEvent(event)) {
          input.emitSessionsChanged('status-change', childSessionId);
        }
        if (isTurnStatusChangingSessionEvent(event)) {
          input.emitSessionsChanged('turn-status-change', childSessionId);
        }
      }
      input.onEvent?.(event);
    },
  };
}

interface StreamEventsOptions {
  turnId: string;
  goalBoundary: SessionGoalBoundary;
  activity?: SessionActivityLease;
  observeEvent?: (event: SessionEvent) => void;
}

interface StreamEventsResult {
  turnId: string;
  ok: boolean;
  error?: string;
  outcome: GoalTurnOutcome;
}

export type StreamEvents = (
  sessionId: string,
  iterator: AsyncIterable<SessionEvent>,
  options: StreamEventsOptions,
) => Promise<StreamEventsResult>;

export interface SessionStreamerDeps {
  sessionActivities: SessionActivityRegistry;
  goalWiring: GoalWiring;
  computerUseOverlay: AssembledTools['computerUseOverlay'];
  /**
   * The picture-in-picture mirror, retired on the same signal as the cursor.
   *
   * Cleared only when a session was stopped, archived or deleted, the mirror
   * would outlive the run it belonged to and keep showing that run's last
   * frame while the next turn drove a different application. A mirror showing
   * the wrong window is worse than no mirror, because it is read as "this is
   * what the agent is doing".
   */
  computerUsePip?: { complete(sessionId: string): void };
  /**
   * The menu-bar item, retired on the same signal as the cursor.
   *
   * A turn ending is the run ending, so this is where the indicator goes away
   * and — because the item is the authority on whether anything is still
   * driving the machine — where the keep-awake assertion it took out is given
   * back. Clearing it only on stop/archive/delete would mean the assertion
   * outlived every run that ended by finishing.
   */
  computerUseStatusItem?: { clearForSession(sessionId: string): void };
  /**
   * The screen-lock guard, retired on the same signal, for the same reason.
   *
   * It holds the ids of sessions it will release on unlock, and it had no
   * turn-end caller at all: the session IPC cleared it on delete, stop and
   * archive, but a turn that simply finished left its id in the set for the
   * lifetime of the process. Two hundred turns in distinct sessions across a
   * day left two hundred ids held, and every unlock walked all of them. The
   * status item was cleared here and the guard was not, which is the kind of
   * asymmetry nobody notices until the set is the thing being measured.
   */
  computerUseScreenLock?: { clearForSession(sessionId: string): void };
  computerUseTools: AssembledTools['computerUseTools'];
  safeSendToRenderer: (channel: string, ...args: unknown[]) => void;
  emitSessionsChanged: (
    reason: SessionChangedReason,
    sessionId?: string,
    extra?: { turnId?: string },
  ) => void;
  interruptActivePlanExecution?: (sessionId: string, reason: string) => Promise<unknown>;
}

function isStatusChangingSessionEvent(event: SessionEvent): boolean {
  return event.type === 'sandbox_boundary_request' ||
    event.type === 'sandbox_boundary_decision_ack' ||
    event.type === 'complete' ||
    event.type === 'abort' ||
    event.type === 'error';
}

function isTurnStatusChangingSessionEvent(event: SessionEvent): boolean {
  return event.type === 'complete' || event.type === 'abort' || event.type === 'error';
}

/**
 * Session event fan-out plumbing (arch R5). Pure move of main.ts's `streamEvents`
 * plus its two event-classifier helpers. Returns the `streamEvents` function that
 * every turn-driving call site in main.ts drives; behavior is identical to the
 * in-main.ts original.
 */
export function createSessionStreamer(deps: SessionStreamerDeps): StreamEvents {
  const {
    sessionActivities,
    goalWiring,
    computerUseOverlay,
    computerUsePip,
    computerUseStatusItem,
    computerUseScreenLock,
    computerUseTools,
    safeSendToRenderer,
    emitSessionsChanged,
    interruptActivePlanExecution,
  } = deps;

  return function streamEvents(
    sessionId: string,
    iterator: AsyncIterable<SessionEvent>,
    options: StreamEventsOptions,
  ): Promise<StreamEventsResult> {
    let userAppendBroadcasted = false;
    const turnId = options.turnId;
    const started = startDesktopSessionTurn({
      sessionId,
      events: iterator,
      turnId,
      goalBoundary: options.goalBoundary,
      activities: sessionActivities,
      ...(options.activity ? { activity: options.activity } : {}),
      beginObservedTurn: (externalSessionId, externalTurnId) =>
        goalWiring.coordinator.beginObservedTurn(externalSessionId, externalTurnId),
      onEvent: (event) => {
        if (!userAppendBroadcasted) {
          emitSessionsChanged('message-appended', sessionId, { turnId });
          userAppendBroadcasted = true;
        }
        safeSendToRenderer(`sessions:event:${sessionId}`, event);
        if (isStatusChangingSessionEvent(event)) {
          emitSessionsChanged('status-change', sessionId, { turnId });
        }
        if (isTurnStatusChangingSessionEvent(event)) {
          emitSessionsChanged('turn-status-change', sessionId, { turnId });
          computerUseOverlay.clearForSession(sessionId);
          // The turn ended, which is what the mirror calls a run. It lingers
          // rather than vanishing: a person watching background work looks
          // over at the moment the answer arrives, which is the moment an
          // immediate teardown would take the window away. A dismissal expires
          // here too, alongside the two clears either side of this line.
          computerUsePip?.complete(sessionId);
          computerUseStatusItem?.clearForSession(sessionId);
          computerUseScreenLock?.clearForSession(sessionId);
          computerUseTools.clearSession(sessionId);
        }
        options.observeEvent?.(event);
      },
      onStreamError: (error) => {
        const event = {
          type: 'error',
          id: randomUUID(),
          turnId,
          ts: Date.now(),
          recoverable: false,
          code: errorCode(error),
          reason: errorReason(error),
          message: errorMessage(error),
        } satisfies SessionEvent;
        safeSendToRenderer(`sessions:event:${sessionId}`, event);
        emitSessionsChanged('status-change', sessionId, { turnId });
        emitSessionsChanged('turn-status-change', sessionId, { turnId });
        computerUseOverlay.clearForSession(sessionId);
        // A stream that dies ends the turn as surely as a completion event
        // does, and it is the path where the last frame matters most.
        computerUsePip?.complete(sessionId);
        // A turn that dies is still a turn that ended. Leaving the item up here
        // would leave the power assertion held by a run that no longer exists.
        computerUseStatusItem?.clearForSession(sessionId);
        computerUseScreenLock?.clearForSession(sessionId);
        computerUseTools.clearSession(sessionId);
      },
      onDrained: async (outcome) => {
        emitSessionsChanged('message-appended', sessionId, { turnId });
        if (
          interruptActivePlanExecution &&
          (outcome.kind === 'aborted' || outcome.kind === 'errored')
        ) {
          await interruptActivePlanExecution(
            sessionId,
            outcome.kind === 'aborted' ? 'turn_aborted' : `turn_error:${outcome.reason}`,
          ).catch(() => undefined);
        }
      },
    });
    // Thrown SYNCHRONOUSLY, and that is load-bearing. A refused turn never runs
    // `onEvent` / `onStreamError` / `onDrained`, so no change ever names it —
    // and a client's arm stays unconfirmed until its turn is named, holding Stop
    // and the composer lock. Throwing synchronously is what carries the failure
    // out through the `void streamEvents(...)` call in the send handler: it
    // rejects that handler's promise instead of resolving `{ ok: true }`, so the
    // client disarms in its own catch. Made async, this line would be swallowed
    // by the `void` and latch the UI until restart.
    if (started.kind === 'unavailable') throw new Error(started.reason);
    return started.completion.then((outcome) => {
      const failureReason = outcome.kind === 'errored' || outcome.kind === 'suspended'
        ? outcome.reason
        : undefined;
      return {
        turnId,
        ok: outcome.kind === 'completed',
        ...(failureReason ? { error: failureReason } : {}),
        outcome,
      };
    });
  };
}
