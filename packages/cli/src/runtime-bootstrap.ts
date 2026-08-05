import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AiSdkBackend,
  AgentGraphCoordinator,
  AgentGraphSupervisorWakeCoordinator,
  AutomationManager,
  AutomationScheduler,
  BackendRegistry,
  GoalManager,
  RuntimeReadModel,
  SessionManager,
  ShellRunProcessManager,
  buildAutomationTool,
  buildAskUserQuestionTool,
  buildRequestSandboxBoundaryTool,
  buildBuiltinTools,
  buildSessionRecapMessages,
  buildChildAgentTools,
  createBuiltinSandboxManager,
  isBuiltinFilesystemWorkerSandboxAvailable,
  createSandboxDiagnosticsProvider,
  createProviderRequestCaptureRecorder,
  createFilesystemWorkerLaunchSpecProvider,
  createLocalContinuationSafetyInspector,
  createConfiguredSubagentCatalog,
  drainGoalTurn,
  FilesystemWorkerClient,
  buildDefaultContextBudgetPolicy,
  buildSkillAgentTool,
  buildSkillSearchAgentTool,
  SkillShadowSelectionTracker,
  buildGoalTools,
  buildParentAgentTools,
  assertProductBindingCatalogClean,
  AGENT_TOOL_GROUP_ID,
  buildLlmHistorySummarizer,
  buildNativeWebSearchTool,
  cleanupLegacyHistoryCompactArtifacts,
  buildProviderOptions,
  buildSubscriptionModelFetch,
  evaluateAutomationCanFire,
  getAIModel,
  generateSessionTitle as generateRuntimeSessionTitle,
  loadHistoryCompactBlocksFromArtifacts,
  listRunnableBuiltinAgentDefinitions,
  replayPlanItemsToModelMessages,
  recoverAgentGraphSupervisorContextOverflow,
  resolveSkillDiscoveryPaths,
  resolveSelectedModelContextWindow,
  projectEffectiveProductToolSurface,
  routeWebSearchTools,
  type AutomationDefinition,
  type EffectiveProductToolSurface,
  type HostCapabilities,
  type HostCapabilitiesResolver,
  type MakaTool,
  type InvocationResult,
  type InvocationSource,
  type ShellRunUpdate,
  type SkillSource,
  type ModelMessage,
} from '@maka/runtime';
import {
  createSqliteAgentRunStore,
  createAttachmentByteReader,
  createSqliteArtifactStore,
  createAutomationStore,
  createConnectionStore,
  createFileCredentialStore,
  openRuntimeEventPersistence,
  createForeignSessionStore,
  createGitWorktreeChildExecutor,
  createReadImageSnapshotter,
  createSessionStore,
  isSessionNotFoundError,
  createSettingsStore,
  createSqliteShellRunStore,
  assertSessionBundleRootLayout,
  type ForeignSessionStore,
  persistProviderRequestCaptureArtifact,
} from '@maka/storage';
import { createAgentGraphControlStore } from '@maka/storage/agent-graph-control-store';
import { resolveStorageRoot } from '@maka/storage/root-authority';
import { resolveWorkspaceIdentity } from '@maka/storage/workspace-identity';
import { fetchProviderModels } from '@maka/runtime';
import { createApiKeyOnboardingSurface, type MakaOnboardingSurface } from './onboarding.js';
import { isActiveShellRunStatus, resolveModelVisionSupport } from '@maka/core';
import type { ModelChoice, ReadySessionTarget } from './connection-target.js';
import {
  listReadyModelChoices,
  resolveDefaultSessionTarget,
  resolveSessionTargetForSlug,
} from './connection-target.js';
import { buildCliSystemPrompt, buildCliTurnTailPrompt } from './cli-system-prompt.js';
import { CliGoalContinuation } from './cli-goal-continuation.js';
import { cleanRecapText } from './session-recap.js';

export interface MakaCliRuntimeContext {
  /** Legacy shared-root input retained for callers that do not split roots. */
  workspaceRoot: string;
  /** Durable session-owned state root used by the runtime stores. */
  stateRoot: string;
  /** Host-injected configuration root used by connections, credentials, and settings. */
  configRoot: string;
  cwd: string;
  runtime: SessionManager;
  target: ReadySessionTarget;
  /** Selectable models across every ready connection, for the `/model` picker. */
  modelChoices: ModelChoice[];
  /** Tools passed to the backend, including TUI-only interactive and subagent tools. */
  tools: MakaTool[];
  /**
   * Explicit skill invocation surface (issue #1148): the discovery source +
   * host gate shared with the Skill tool and the system-prompt catalog, so
   * `/skill:<name>` autocomplete, highlight, and submit-time injection all
   * resolve against exactly what the host can load.
   */
  skills: MakaCliSkillSurface;
  automationManager: AutomationManager;
  automationScheduler: AutomationScheduler;
  subscribeShellRunUpdates(listener: (update: ShellRunUpdate) => void): () => void;
  listShellRunUpdates(sessionId: string): Promise<ShellRunUpdate[]>;
  goalManager: GoalManager;
  goalContinuation: CliGoalContinuation;
  /** One-sentence session recap generator (issue #1055), shared by `/recap` and idle-return auto-recap. */
  recap: SessionRecapGenerator;
  /** Read-only scanner for other agents' sessions (Claude Code, Codex), for the resume picker (#1057). */
  foreignSessions: ForeignSessionStore;
  /** Host-owned Graph runtime used by the TUI and `maka run --graph`. */
  agentGraph?: {
    reserveActivity(sessionId: string): { release(): void };
    waitForCompletion(sessionId: string): Promise<void>;
  };
  close(): Promise<void>;
  /** API-key onboarding surface for the /setup wizard (#1098). */
  onboarding: MakaOnboardingSurface;
}

export function resolveCliStreamConnectTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env.MAKA_STREAM_CONNECT_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return undefined;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error('MAKA_STREAM_CONNECT_TIMEOUT_MS must be a positive integer');
  }
  const timeoutMs = Number(raw);
  if (!Number.isSafeInteger(timeoutMs)) {
    throw new Error('MAKA_STREAM_CONNECT_TIMEOUT_MS must be a positive safe integer');
  }
  return timeoutMs;
}

/**
 * Generates a one-sentence recap of a session so far, using a tool-free model
 * call whose exchange is never written to the session's own history. Never
 * throws — failures resolve to `{ ok: false }` so callers can surface them
 * without a try/catch.
 */
export interface SessionRecapGenerator {
  generate(
    sessionId: string,
    reason: 'manual' | 'idle',
  ): Promise<{ ok: true; text: string; raw: string } | { ok: false; error: string }>;
}

export interface CreateMakaCliRuntimeContextInput {
  surface: 'tui' | 'run' | 'activation';
  /** Legacy root; both new roots default to this path. */
  workspaceRoot: string;
  /** Optional portable session-owned state root. */
  stateRoot?: string;
  /** Optional host-injected configuration root. */
  configRoot?: string;
  cwd: string;
  requestedConnectionSlug?: string;
  requestedModel?: string;
  maxSteps?: number;
  /** Compose the durable Graph control plane and Git-worktree child executor. */
  enableAgentGraph?: boolean;
  /** Canonical cwd used for one resumed session without rewriting its stored header. */
  sessionCwdOverride?: { sessionId: string; cwd: string };
  runtimeInvocationObserver?: (result: InvocationResult) => void | Promise<void>;
  /** Invocation provenance used by hosted activation callers. */
  runtimeSource?: InvocationSource;
  /** Enables authoritative safe-boundary continuation for hosted activation callers. */
  safeBoundaryResumeEnabled?: boolean;
  onSessionTitleChanged?: (sessionId: string) => void;
  /**
   * Optional cron executor. When provided, the Automation tool advertises the
   * cron kind and cron fires spawn a fresh session + run via this callback
   * (reviewer G1: a host derives cron support from the executor it passes in).
   * Omitted by the default CLI (no multi-session surface) — heartbeat only.
   */
  automationCreateFreshRun?: (
    prompt: string,
    automationId: string,
  ) => Promise<import('@maka/runtime').AutomationFireResult>;
}

export interface GetOrCreateCliClaudeDeviceIdDeps {
  newId?: () => string;
}

export interface MakaCliSkillSurface {
  /** Five-path discovery source for a session cwd (project-level paths are cwd-relative). */
  source(cwd: string): SkillSource;
  /** This host's capability surface — the same gate the Skill tool loads through. */
  host: HostCapabilities;
}

export function isMakaClaudeSubscriptionCloakEnabled(
  env: { MAKA_CLAUDE_SUBSCRIPTION_CLOAK?: string } = process.env,
): boolean {
  return env.MAKA_CLAUDE_SUBSCRIPTION_CLOAK !== '0';
}

export async function createMakaCliRuntimeContext(
  input: CreateMakaCliRuntimeContextInput,
): Promise<MakaCliRuntimeContext> {
  const stateRoot = input.stateRoot ?? input.workspaceRoot;
  const configRoot = input.configRoot ?? input.workspaceRoot;
  const agentGraphEnabled = input.surface === 'tui' || input.enableAgentGraph === true;
  if (input.stateRoot !== undefined || input.configRoot !== undefined) {
    await assertSessionBundleRootLayout({
      stateRoot,
      configRoot,
      allowShared: false,
    });
  }
  await resolveStorageRoot({ path: stateRoot, kind: 'interactive' });
  const store = createSessionStore(stateRoot);
  const runStore = createSqliteAgentRunStore(stateRoot);
  const runtimePersistence = await openRuntimeEventPersistence({
    workspaceRoot: stateRoot,
  });
  const runtimeEventStore = runtimePersistence.runtimeEventStore;
  const shellRunStore = createSqliteShellRunStore(stateRoot);
  await Promise.all([runStore.ready?.(), shellRunStore.ready()]).catch(async (error) => {
    await store.close?.().catch(() => {});
    runtimePersistence.close();
    runStore.close?.();
    shellRunStore.close();
    throw error;
  });
  const artifactStore = createSqliteArtifactStore(stateRoot);
  const agentGraphControlStore = agentGraphEnabled
    ? createAgentGraphControlStore(stateRoot)
    : undefined;
  const worktreeChildExecutor = agentGraphEnabled
    ? createGitWorktreeChildExecutor({ storageRoot: stateRoot })
    : undefined;
  const agentGraphErrors = new Map<string, unknown>();
  let agentGraphCoordinator: AgentGraphCoordinator | undefined;
  let agentGraphSupervisorWakeCoordinator: AgentGraphSupervisorWakeCoordinator | undefined;
  const connectionStore = createConnectionStore(configRoot);
  const credentialStore = createFileCredentialStore(configRoot);
  const settingsStore = createSettingsStore(configRoot);
  const subagentCatalog = createConfiguredSubagentCatalog({
    getSettings: () => settingsStore.get(),
    getConnection: (slug) => connectionStore.get(slug),
  });
  // Read-only scanner over other agents' local session stores (~/.claude,
  // ~/.codex). Independent of the Maka workspace — takes no workspaceRoot.
  const foreignSessions = createForeignSessionStore();
  // Authoritative RuntimeEvent read model (issue #1055's session-recap
  // generator projects through this instead of re-deriving its own lossy
  // StoredMessage-based projection). Built once and shared — mirrors
  // SessionManager's own construction in session-manager.ts's readModel().
  const runtimeReadModel = new RuntimeReadModel({
    runStore,
    runtimeEventStore,
    projectionCache: store,
  });
  const targetInput = {
    connectionStore,
    credentialStore,
    requestedModel: input.requestedModel,
  };
  const target = input.requestedConnectionSlug
    ? await resolveSessionTargetForSlug(input.requestedConnectionSlug, targetInput)
    : await resolveDefaultSessionTarget(targetInput);
  const modelChoices = await listReadyModelChoices({ connectionStore, credentialStore });
  const backends = new BackendRegistry();
  const shellRunListeners = new Set<(update: ShellRunUpdate) => void>();
  const shellRuns = new ShellRunProcessManager({
    store: shellRunStore,
    newId: randomUUID,
    now: Date.now,
    onShellRunUpdate: (update) => {
      for (const listener of shellRunListeners) {
        try {
          listener(update);
        } catch {
          // One UI observer must not suppress updates for the rest.
        }
      }
    },
  });
  const sandboxManager = createBuiltinSandboxManager();
  const filesystemWorkerLaunchSpecProvider =
    sandboxManager && isBuiltinFilesystemWorkerSandboxAvailable()
      ? createFilesystemWorkerLaunchSpecProvider({
          runtime: 'node',
          platform: process.platform,
          resourceLocation: { kind: 'runtime' },
        })
      : undefined;
  const filesystemWorker =
    sandboxManager && filesystemWorkerLaunchSpecProvider
      ? new FilesystemWorkerClient({
          sandboxManager,
          getLaunchSpec: filesystemWorkerLaunchSpecProvider,
        })
      : undefined;
  const sandboxDiagnosticsProvider = createSandboxDiagnosticsProvider({
    ...(sandboxManager ? { sandboxManager } : {}),
    ...(filesystemWorkerLaunchSpecProvider
      ? { getFilesystemWorkerLaunchSpec: filesystemWorkerLaunchSpecProvider }
      : {}),
  });
  const tools = buildBuiltinTools({
    shellRuns,
    runtimeResources: shellRuns,
    backgroundTasks: shellRuns,
    ptyControls: shellRuns,
    snapshotImage: createReadImageSnapshotter(artifactStore),
    ...(sandboxManager ? { sandboxManager } : {}),
    ...(filesystemWorker
      ? {
          filesystemWorker,
        }
      : {}),
  });
  // Child sessions get fresh catalog tools. Their Read tool cannot inspect
  // parent runtime resources, and the SessionManager narrows this union to the
  // selected profile after checking host capabilities (for example, a
  // worktree executor for implementation children). Agent tools are excluded
  // so children cannot recursively spawn from this surface.
  const childAgentTools = agentGraphEnabled
    ? buildChildAgentTools([
        ...buildBuiltinTools({
          snapshotImage: createReadImageSnapshotter(artifactStore),
          ...(sandboxManager ? { sandboxManager } : {}),
          ...(filesystemWorker
            ? {
                filesystemWorker,
              }
            : {}),
        }),
        buildNativeWebSearchTool(),
      ])
    : [];
  const automationManager = new AutomationManager({
    generateId: () => randomUUID(),
    now: () => Date.now(),
  });
  // A heartbeat-only CLI owns no durable Automations and must not reconcile the
  // shared authority. A cron-enabled host persists through the same operational
  // SQLite authority as Desktop.
  const cronEnabled = input.automationCreateFreshRun !== undefined;
  const automationStore = createAutomationStore(stateRoot);
  // If the authority cannot be read, do not attempt a later replacement write.
  let durableStoreReadable = true;
  const syncAutomations = cronEnabled
    ? (): void => {
        if (!durableStoreReadable) return;
        const durable = automationManager
          .listAll()
          .filter((a) => a.durable && (a.status === 'active' || a.status === 'paused'));
        automationStore.sync(durable).catch((err) => {
          console.warn('[runtime-bootstrap] failed to persist durable automations:', err);
        });
      }
    : (): void => {
        /* heartbeat-only host owns no durable automations; never overwrite the shared store */
      };
  const automationTool = buildAutomationTool({
    automationManager,
    onAutomationChange: syncAutomations,
    cronEnabled,
  });

  // Load durable automations only on a host that can run them — a cron-disabled
  // host must not adopt/reconcile crons it doesn't own (see above).
  if (cronEnabled) {
    try {
      const saved = await automationStore.loadAll();
      automationManager.registerAll(saved);
    } catch (err) {
      durableStoreReadable = false;
      console.error(
        '[runtime-bootstrap] durable automation store unreadable; persistence disabled to avoid data loss:',
        err,
      );
    }
  }

  const goalManager = new GoalManager({ generateId: () => randomUUID(), now: () => Date.now() });
  const goalTokenCache = new Map<string, number>();
  let runtime!: SessionManager;
  // Construct the lifecycle authority before exposing Goal tools. The runtime
  // reference is only read after context creation, when a real turn settles.
  const goalContinuation = new CliGoalContinuation({
    goalManager,
    evaluator: {
      async evaluate(prompt: string, sessionId: string): Promise<string> {
        const ai = (await import('ai')) as unknown as {
          generateText(opts: Record<string, unknown>): Promise<{ text: string }>;
        };
        const header = await store.readHeader(sessionId);
        const ready = await resolveSessionTargetForSlug(header.llmConnectionSlug, {
          connectionStore,
          credentialStore,
          requestedModel: header.model,
        });
        const modelFetch = buildSubscriptionModelFetch({
          connection: ready.connection,
          sessionId: 'goal-evaluator',
          modelId: ready.model,
          ...(ready.connection.providerType === 'claude-subscription'
            ? {
                claude: {
                  cloakEnabled: isMakaClaudeSubscriptionCloakEnabled(),
                  deviceId: await getOrCreateCliClaudeDeviceId(configRoot),
                  accountUuid: ready.oauthTokens?.account_uuid ?? '',
                },
              }
            : {}),
        });
        const result = await ai.generateText({
          model: getAIModel({
            connection: ready.connection,
            apiKey: ready.apiKey ?? '',
            modelId: ready.model,
            fetch: modelFetch,
          }),
          prompt,
          providerOptions: buildProviderOptions(
            ready.connection,
            ready.model,
            header.thinkingLevel,
          ),
          maxOutputTokens: 1024,
        });
        return result.text;
      },
    },
    async getRecentContext(sessionId: string): Promise<string> {
      const messages = await runtime.getMessages(sessionId);
      let total = 0;
      for (const message of messages) {
        if (message.type === 'token_usage')
          total += message.total ?? message.input + message.output;
      }
      goalTokenCache.set(sessionId, total);
      return messages
        .slice(-10)
        .filter((message) => message.type === 'user' || message.type === 'assistant')
        .slice(-6)
        .map(
          (message) =>
            `[${message.type}]: ${(message.type === 'user' || message.type === 'assistant' ? message.text : '').slice(0, 500)}`,
        )
        .join('\n');
    },
    getTokenCount: (sessionId: string) => goalTokenCache.get(sessionId) ?? 0,
  });

  // One-sentence session recap (issue #1055): a tool-free model call over the
  // session's own history, never written back to it. Mirrors the goal
  // evaluator's connection resolution + call shape above.
  const recap: SessionRecapGenerator = {
    async generate(sessionId, reason) {
      let modelId = '';
      // The actual bounded request sent to the model (projection + budget trim
      // + trailing instruction), persisted verbatim to the artifact below.
      let requestMessages: ModelMessage[] = [];
      let rawText = '';
      let cleaned = '';
      let errorMessage: string | undefined;
      try {
        // Authoritative RuntimeEvent projection (issue #1182 review): reuses
        // the same read model, budget policy, and replay-plan projection the
        // backend uses for its own history, instead of re-deriving a lossy
        // StoredMessage-based one.
        const view = await runtimeReadModel.getSessionView(sessionId);
        const header = await store.readHeader(sessionId);
        const ready = await resolveSessionTargetForSlug(header.llmConnectionSlug, {
          connectionStore,
          credentialStore,
          requestedModel: header.model,
        });
        modelId = ready.model;
        const modelFetch = buildSubscriptionModelFetch({
          connection: ready.connection,
          sessionId: 'session-recap',
          modelId: ready.model,
          ...(ready.connection.providerType === 'claude-subscription'
            ? {
                claude: {
                  cloakEnabled: isMakaClaudeSubscriptionCloakEnabled(),
                  deviceId: await getOrCreateCliClaudeDeviceId(configRoot),
                  accountUuid: ready.oauthTokens?.account_uuid ?? '',
                },
              }
            : {}),
        });
        requestMessages = buildSessionRecapMessages({
          events: view.events,
          connection: ready.connection,
          modelId: ready.model,
        });
        const ai = (await import('ai')) as unknown as {
          generateText(opts: Record<string, unknown>): Promise<{ text: string }>;
        };
        const result = await ai.generateText({
          model: getAIModel({
            connection: ready.connection,
            apiKey: ready.apiKey ?? '',
            modelId: ready.model,
            fetch: modelFetch,
          }),
          messages: requestMessages,
          providerOptions: buildProviderOptions(
            ready.connection,
            ready.model,
            header.thinkingLevel,
          ),
          maxOutputTokens: 1024,
        });
        rawText = result.text;
        cleaned = cleanRecapText(rawText);
        return { ok: true as const, text: cleaned, raw: rawText };
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
        return { ok: false as const, error: errorMessage };
      } finally {
        try {
          await artifactStore.create({
            sessionId,
            turnId: randomUUID(),
            name: 'recap-request.json',
            kind: 'file',
            content: JSON.stringify(
              {
                reason,
                model: modelId,
                messageCount: requestMessages.length,
                messages: requestMessages,
                raw: rawText,
                cleaned,
                ...(errorMessage ? { error: errorMessage } : {}),
              },
              null,
              2,
            ),
            ...(cleaned ? { summary: cleaned.slice(0, 100) } : {}),
          });
        } catch {
          // Best-effort persistence; recap must work even if the artifact store fails.
        }
      }
    },
  };

  const goalTools =
    input.surface === 'tui'
      ? buildGoalTools({
          goalManager,
          goalContinuation,
          getTokenCount: (sessionId: string) => goalTokenCache.get(sessionId) ?? 0,
        })
      : [];
  const subagentTools = agentGraphEnabled
    ? buildParentAgentTools({
        definitions: listRunnableBuiltinAgentDefinitions({
          tools: childAgentTools.filter((tool) => tool.name !== 'WebSearch'),
          worktreeChildExecutorAvailable: worktreeChildExecutor !== undefined,
        }),
      })
    : [];
  const subagentToolNames = new Set(subagentTools.map((tool) => tool.name));
  const surfaceTools =
    input.surface === 'tui' ? [buildAskUserQuestionTool(), buildRequestSandboxBoundaryTool()] : [];
  let cliProductToolSurface: EffectiveProductToolSurface;
  const resolveCliSkillHost: HostCapabilitiesResolver = () =>
    cliProductToolSurface.hostCapabilities;
  const skillShadowTracker = new SkillShadowSelectionTracker();
  const skillTool = buildSkillAgentTool(
    ({ cwd }) => resolveSkillDiscoveryPaths(cwd, configRoot),
    resolveCliSkillHost,
    { shadowTracker: skillShadowTracker },
  );
  const skillSearchTool = buildSkillSearchAgentTool(
    ({ cwd }) => resolveSkillDiscoveryPaths(cwd, configRoot),
    resolveCliSkillHost,
    { shadowTracker: skillShadowTracker },
  );
  const boundTools = [
    ...tools,
    automationTool,
    ...goalTools,
    skillTool,
    skillSearchTool,
    ...subagentTools,
    ...surfaceTools,
  ];
  assertProductBindingCatalogClean(
    'cli',
    boundTools.map((tool) => tool.name),
  );
  cliProductToolSurface = projectEffectiveProductToolSurface({
    host: 'cli',
    tools: boundTools,
    policy: {
      economy: input.surface === 'tui' && !process.env.MAKA_DISABLE_DEFERRED_TOOLS,
    },
  });
  const allTools = [...cliProductToolSurface.tools];

  backends.register('ai-sdk', async (ctx) => {
    const header =
      input.sessionCwdOverride?.sessionId === ctx.sessionId
        ? { ...ctx.header, cwd: input.sessionCwdOverride.cwd }
        : ctx.header;
    // Resolve the session's own connection — not the global default — so a
    // /model switch that rebinds the session to another provider actually runs
    // on that provider (the desktop app resolves the backend the same way).
    const ready = await resolveSessionTargetForSlug(header.llmConnectionSlug, {
      connectionStore,
      credentialStore,
      requestedModel: header.model,
    });
    const modelFetch = buildSubscriptionModelFetch({
      connection: ready.connection,
      sessionId: ctx.sessionId,
      modelId: ready.model,
      ...(ready.connection.providerType === 'claude-subscription'
        ? {
            claude: {
              cloakEnabled: isMakaClaudeSubscriptionCloakEnabled(),
              deviceId: await getOrCreateCliClaudeDeviceId(configRoot),
              accountUuid: ready.oauthTokens?.account_uuid ?? '',
            },
          }
        : {}),
    });
    const sandboxDiagnosticsSnapshot = await sandboxDiagnosticsProvider.resolve({
      mode: header.permissionMode,
      cwd: header.cwd,
    });
    const streamConnectTimeoutMs = resolveCliStreamConnectTimeoutMs();
    const agentGraphSupervisorTools =
      !ctx.tools && agentGraphEnabled
        ? await agentGraphCoordinator!.toolsForSession(ctx.sessionId)
        : [];
    const settings = await settingsStore.get();
    const routedChildTools = routeWebSearchTools({
      tools:
        settings.webSearch.defaultProvider === 'model'
          ? childAgentTools
          : childAgentTools.filter((tool) => tool.name !== 'WebSearch'),
      settings: settings.webSearch,
      connection: ready.connection,
      model: ready.model,
      privacy: settings.privacy,
    });
    const targetSubagentTools =
      !ctx.tools && agentGraphEnabled
        ? buildParentAgentTools({
            definitions: listRunnableBuiltinAgentDefinitions({
              tools: routedChildTools,
              worktreeChildExecutorAvailable: worktreeChildExecutor !== undefined,
            }),
          })
        : [];
    const routedTools = routeWebSearchTools({
      tools: ctx.tools
        ? ctx.tools
        : [
            ...allTools.filter((tool) => !subagentToolNames.has(tool.name)),
            ...targetSubagentTools,
            ...agentGraphSupervisorTools,
          ],
      settings: settings.webSearch,
      connection: ready.connection,
      model: ready.model,
      privacy: settings.privacy,
      allowAddNative: ctx.tools === undefined,
    });
    const productToolSurface = projectEffectiveProductToolSurface({
      host: 'cli',
      tools: routedTools,
      policy: cliProductToolSurface.identity.policy,
    });
    const backendTools = [...productToolSurface.tools];
    const admitsAgentChildren = productToolSurface.boundSurfaceIds.includes(AGENT_TOOL_GROUP_ID);
    return new AiSdkBackend({
      sessionId: ctx.sessionId,
      header: { ...header, model: ready.model },
      appendMessage:
        ctx.appendMessage ?? ((message) => ctx.store.appendMessage(ctx.sessionId, message)),
      readExecutionBoundary: () => ctx.store.readExecutionBoundary!(ctx.sessionId),
      ...(input.surface === 'tui'
        ? {
            createSandboxBoundaryRequest: (request) =>
              ctx.store.createSandboxBoundaryRequest!(request),
            settleSandboxBoundaryRequest: (request) =>
              ctx.store.settleSandboxBoundaryRequest!(request),
          }
        : {}),
      connection: ready.connection,
      apiKey: ready.apiKey,
      modelId: ready.model,
      modelFactory: (modelInput) => getAIModel({ ...modelInput, fetch: modelFetch }),
      tools: backendTools,
      sandboxDiagnosticsSnapshot,
      toolAvailability: productToolSurface.toolAvailability,
      ...(admitsAgentChildren
        ? {
            spawnChildAgent: (childInput) => runtime.spawnChildAgent(ctx.sessionId, childInput),
            spawnChildSession: (childInput) =>
              runtime.spawnChildSession(ctx.sessionId, {
                spawnedBy: {
                  parentRunId: childInput.parentRunId,
                  parentTurnId: childInput.parentTurnId,
                  toolCallId: childInput.toolCallId,
                },
                agentProfile: childInput.agentProfile,
                ...(childInput.subagentId ? { subagentId: childInput.subagentId } : {}),
                prompt: childInput.prompt,
                ...(childInput.swarm ? { swarm: childInput.swarm } : {}),
                abortSignal: childInput.abortSignal,
                ...(childInput.onReady ? { onReady: childInput.onReady } : {}),
                ...(childInput.onEvent ? { onEvent: childInput.onEvent } : {}),
              }),
            prepareChildAgentResume: (sourceRunId) =>
              runtime.prepareChildAgentResume(ctx.sessionId, sourceRunId),
            resumeChildAgent: (childInput) => runtime.resumeChildAgent(ctx.sessionId, childInput),
            retryChildAgent: (childInput) => runtime.retryChildAgent(ctx.sessionId, childInput),
            listChildAgents: () => runtime.listChildAgents(ctx.sessionId),
            readChildAgentOutput: (childInput) =>
              runtime.readChildAgentOutput(ctx.sessionId, childInput),
          }
        : {}),
      providerOptions: buildProviderOptions(ready.connection, ready.model, header.thinkingLevel),
      ...(streamConnectTimeoutMs !== undefined ? { streamConnectTimeoutMs } : {}),
      contextBudget: buildDefaultContextBudgetPolicy(ready.connection, {
        name: 'cli-default-history-budget',
        modelId: ready.model,
      }),
      supportsVision: resolveModelVisionSupport(
        ready.connection.providerType,
        ready.connection.models,
        ready.model,
      ),
      readAttachmentBytes: createAttachmentByteReader({ artifactStore, sessionId: ctx.sessionId }),
      loadHistoryCompact: (event) => loadHistoryCompactBlocksFromArtifacts(artifactStore, event),
      loadHistoryCompactCheckpoint: ctx.loadHistoryCompactCheckpoint,
      summarizeHistoryCompact: buildLlmHistorySummarizer({
        // Reuse the same connection/model the session already drives, so the
        // summary stays consistent with the model that will consume it.
        resolveModel: () =>
          getAIModel({
            connection: ready.connection,
            apiKey: ready.apiKey,
            modelId: ready.model,
            fetch: modelFetch,
          }),
        providerOptions: buildProviderOptions(ready.connection, ready.model, header.thinkingLevel),
      }),
      // The canonical metering sink (#1679). Without it this composition root
      // produces diagnostics and no accounting at all — for `/compact` and for
      // ordinary sends alike.
      ...(ctx.recordModelCallAttempt ? { recordModelCallAttempt: ctx.recordModelCallAttempt } : {}),
      recordHistoryCompactCheckpoint: ctx.recordHistoryCompactCheckpoint,
      loadTurnRuntimeEvents: ctx.loadTurnRuntimeEvents,
      allowMidTurnHistoryCompaction: ctx.allowMidTurnHistoryCompaction,
      systemPrompt:
        ctx.systemPrompt ??
        (async ({ cwd, emitSkillCatalogTrace }) => {
          const settings = await settingsStore.get();
          return buildCliSystemPrompt({
            settings,
            cwd,
            workspaceRoot: configRoot,
            host: productToolSurface.hostCapabilities,
            modelContextWindow: resolveSelectedModelContextWindow(ready.connection, ready.model),
            onSkillSelection: (report) =>
              emitSkillCatalogTrace?.('Skill catalog selection completed', {
                policyVersion: report.policyVersion,
                budgetChars: report.budgetChars,
                usedChars: report.usedChars,
                totalCount: report.totalCount,
                eligibleCount: report.eligibleCount,
                advertisedCount: report.advertisedCount,
                omittedCount: report.omittedCount,
              }),
          });
        }),
      turnTailPrompt: ({ cwd }) =>
        buildCliTurnTailPrompt({ cwd, sessionId: ctx.sessionId, automationManager, goalManager }),
      shellRunContextSummary: ctx.shellRunContextSummary,
      recordRunTrace: ctx.recordRunTrace,
      ...(ctx.recordProviderRequestCapture
        ? {
            recordProviderRequestCapture: createProviderRequestCaptureRecorder({
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
            }),
            recordProviderRequestAttempt: ctx.recordProviderRequestAttempt,
          }
        : {}),
      newId: randomUUID,
      now: Date.now,
      ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
      ...(runtimePersistence.runtimeCommitStore
        ? { runtimeCommitSink: runtimePersistence.runtimeCommitStore }
        : {}),
    });
  });

  const resolveChildTools = async (sessionId: string): Promise<readonly MakaTool[]> => {
    const header = await store.readHeader(sessionId);
    const ready = await resolveSessionTargetForSlug(header.llmConnectionSlug, {
      connectionStore,
      credentialStore,
      requestedModel: header.model,
    });
    const settings = await settingsStore.get();
    return routeWebSearchTools({
      tools:
        settings.webSearch.defaultProvider === 'model'
          ? childAgentTools
          : childAgentTools.filter((tool) => tool.name !== 'WebSearch'),
      settings: settings.webSearch,
      connection: ready.connection,
      model: ready.model,
      privacy: settings.privacy,
    });
  };

  runtime = new SessionManager({
    store,
    runStore,
    runtimeEventStore,
    ...(runtimePersistence.runtimeCommitStore
      ? {
          runtimeCommitSink: runtimePersistence.runtimeCommitStore,
          toolBoundaryProtocol: runtimePersistence.runtimeCommitStore.toolBoundaryProtocol,
        }
      : {}),
    shellRuns,
    backends,
    subagentCatalog,
    runtimeSource: input.runtimeSource ?? (input.surface === 'activation' ? 'gateway' : undefined),
    safeBoundaryResumeEnabled:
      input.safeBoundaryResumeEnabled ??
      (input.surface === 'activation' || process.env.MAKA_RUNTIME_SAFE_BOUNDARY_RESUME === '1'),
    onContinuationLifecycleEvent: (event) => {
      const writeDiagnostic = input.surface === 'activation' ? console.error : console.info;
      writeDiagnostic('[runtime-resume]', JSON.stringify(event));
    },
    inspectContinuationSafety: createLocalContinuationSafetyInspector({
      readSessionCwd: async (sessionId) => (await store.readHeader(sessionId)).cwd,
      resolveWorkspaceIdentity: async (cwd) => resolveWorkspaceIdentity({ path: cwd }),
      listAvailableToolNames: async () => allTools.map((tool) => tool.name),
      hasPendingBackgroundOperations: async (sessionId) => {
        const [shellUpdates, runs] = await Promise.all([
          shellRuns.listSessionUpdates(sessionId),
          runStore.listSessionRuns(sessionId),
        ]);
        return (
          shellUpdates.some((update) => isActiveShellRunStatus(update.result.status)) ||
          runs.some(
            (run) =>
              run.parentRunId !== undefined &&
              ['created', 'running', 'waiting_for_user'].includes(run.status),
          )
        );
      },
    }),
    ...(agentGraphEnabled
      ? { childTools: childAgentTools, resolveChildTools, worktreeChildExecutor }
      : {}),
    runtimeInvocationObserver: input.runtimeInvocationObserver,
    onSessionTitleChanged: input.onSessionTitleChanged,
    ...(input.surface === 'tui'
      ? {
          generateSessionTitle: async ({ sessionId, header, sourceText }) => {
            const ready = await resolveSessionTargetForSlug(header.llmConnectionSlug, {
              connectionStore,
              credentialStore,
              requestedModel: header.model,
            });
            const modelFetch = buildSubscriptionModelFetch({
              connection: ready.connection,
              sessionId,
              modelId: ready.model,
              ...(ready.connection.providerType === 'claude-subscription'
                ? {
                    claude: {
                      cloakEnabled: isMakaClaudeSubscriptionCloakEnabled(),
                      deviceId: await getOrCreateCliClaudeDeviceId(configRoot),
                      accountUuid: ready.oauthTokens?.account_uuid ?? '',
                    },
                  }
                : {}),
            });
            return generateRuntimeSessionTitle({
              model: getAIModel({
                connection: ready.connection,
                apiKey: ready.apiKey ?? '',
                modelId: ready.model,
                fetch: modelFetch,
              }),
              providerOptions: buildProviderOptions(ready.connection, ready.model),
              sourceText,
            });
          },
        }
      : {}),
    cleanupHistoryCompactArtifacts: async (cleanupInput) => {
      await cleanupLegacyHistoryCompactArtifacts({
        ...cleanupInput,
        artifactStore,
        onDiagnostic: (diagnostic) => console.warn('[history-compact-cleanup]', diagnostic),
      });
    },
    newId: randomUUID,
    now: Date.now,
  });
  if (agentGraphControlStore) {
    agentGraphSupervisorWakeCoordinator = new AgentGraphSupervisorWakeCoordinator({
      activityRegistry: goalContinuation.activities,
      wakeStore: agentGraphControlStore,
      readSnapshot: (rootSessionId) => agentGraphCoordinator!.getSnapshot(rootSessionId),
      startTurn: async (sessionId, message, activity, abortSignal, isCurrent) => {
        if (!(await isCurrent())) {
          return {
            kind: 'superseded',
            turnId: message.turnId,
            reason: 'Agent graph supervisor checkpoint was superseded before execution.',
          };
        }
        let stopPromise: Promise<void> | undefined;
        const stop = (): void => {
          stopPromise ??= runtime.stopSession(sessionId, { source: 'graph_supervisor' });
        };
        abortSignal.addEventListener('abort', stop, { once: true });
        if (abortSignal.aborted) stop();
        try {
          return await drainGoalTurn({
            events: runtime.sendMessage(sessionId, message),
            turnId: message.turnId,
            activity,
          });
        } finally {
          abortSignal.removeEventListener('abort', stop);
          await stopPromise;
        }
      },
      isSessionDeliverable: async (sessionId) => {
        try {
          const header = await store.readHeader(sessionId);
          return !header.isArchived && header.status !== 'archived';
        } catch (error) {
          if (isSessionNotFoundError(error)) return false;
          throw error;
        }
      },
      inspectAttempt: async (rootSessionId, attemptId, turnId) => {
        const runs = (await runStore.listSessionRuns(rootSessionId)).filter(
          (run) => run.agentGraphWakeAttemptId === attemptId && run.turnId === turnId,
        );
        if (runs.length > 1) {
          throw new Error(
            `Agent graph supervisor wake attempt ${attemptId} has multiple AgentRuns`,
          );
        }
        return runs[0]?.status ?? 'missing';
      },
      recoverContextOverflow: (rootSessionId, { abortSignal }) =>
        recoverAgentGraphSupervisorContextOverflow({
          rootSessionId,
          compactTurnId: randomUUID(),
          abortSignal,
          compactSession: (sessionId, input) => runtime.compactSession(sessionId, input),
        }),
      newId: randomUUID,
      onDiagnostic: (diagnostic) => {
        console.warn('[agent-graph-supervisor-wake]', JSON.stringify(diagnostic));
      },
      onError: (rootSessionId, error) => {
        agentGraphErrors.set(rootSessionId, error);
      },
    });
    agentGraphCoordinator = new AgentGraphCoordinator({
      sessionStore: store,
      runStore,
      runtimeEventStore,
      controlStore: agentGraphControlStore,
      runtime,
      newId: randomUUID,
      onReconciliation: (rootSessionId, result) => {
        agentGraphSupervisorWakeCoordinator!.notify(rootSessionId, result);
      },
      onError: (rootSessionId, error) => {
        agentGraphErrors.set(rootSessionId, error);
      },
    });
  }
  await runtime.recoverInterruptedSessions();

  const automationScheduler = new AutomationScheduler({
    automationManager,
    canFire: async (automation) => {
      if (
        automation.kind === 'heartbeat' &&
        goalContinuation.activities.whenIdle(automation.sessionId)
      ) {
        return false;
      }
      return evaluateAutomationCanFire(automation, {
        // The CLI has no incognito UI, but the setting is shared — honour it if set.
        isIncognitoActive: async () =>
          (await settingsStore.get()).privacy?.incognitoActive === true,
        readSessionHeader: (sessionId) => store.readHeader(sessionId),
        // Default idle set {active, done, waiting_for_user} — a session parked
        // waiting for the user IS the wakeup's home scenario (#639): the
        // heartbeat starts a turn in place of the user. It still never fires
        // into a 'running' (mid-turn) session.
        // Cron is disabled here (createFreshRun omitted); the scheduler ignores it.
      });
    },
    // Heartbeat: inject into the automation's session; resolve after the drain.
    // The CLI has no multi-session UI, so cron (fresh-session) is disabled —
    // createFreshRun is omitted, so the tool advertises heartbeat only.
    injectTurn: async (sessionId, prompt, automationId) => {
      const turnId = randomUUID();
      const outcome = await goalContinuation.runAutomationTurn({
        sessionId,
        turnId,
        start: () =>
          runtime.sendMessage(sessionId, {
            turnId,
            text: prompt,
            origin: { kind: 'automation', automationId },
          }),
      });
      const error =
        outcome.kind === 'errored' || outcome.kind === 'suspended'
          ? outcome.reason
          : outcome.kind === 'aborted'
            ? 'Automation turn was aborted.'
            : undefined;
      return {
        runId: turnId,
        ok: outcome.kind === 'completed',
        ...(error ? { error } : {}),
      };
    },
    createFreshRun: input.automationCreateFreshRun,
    // unref() the tick timer: a background poll must never hold the CLI
    // process open. Without this, any bootstrap consumer that exits without
    // close() (a finished one-shot run, a test) hangs on the 5s tick forever.
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    },
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    onStateChange: syncAutomations,
  });

  automationScheduler.start();

  return {
    workspaceRoot: input.workspaceRoot,
    stateRoot,
    configRoot,
    cwd: input.cwd,
    runtime,
    target,
    modelChoices,
    tools: allTools,
    skills: {
      source: (cwd) => resolveSkillDiscoveryPaths(cwd, configRoot),
      host: cliProductToolSurface.hostCapabilities,
    },
    automationManager,
    automationScheduler,
    subscribeShellRunUpdates: (listener) => {
      shellRunListeners.add(listener);
      return () => shellRunListeners.delete(listener);
    },
    listShellRunUpdates: (sessionId) => runtime.listShellRunUpdates(sessionId),
    goalManager,
    goalContinuation,
    onboarding: createApiKeyOnboardingSurface({
      connectionStore,
      credentialStore,
      fetchModels: fetchProviderModels,
    }),
    recap,
    foreignSessions,
    ...(agentGraphCoordinator && agentGraphSupervisorWakeCoordinator
      ? {
          agentGraph: {
            reserveActivity: (sessionId: string) => goalContinuation.activities.reserve(sessionId),
            waitForCompletion: async (sessionId: string) => {
              for (;;) {
                await agentGraphCoordinator!.waitForIdle(sessionId);
                await agentGraphSupervisorWakeCoordinator!.waitForIdle();
                await agentGraphCoordinator!.waitForIdle(sessionId);
                const error = agentGraphErrors.get(sessionId);
                if (error !== undefined) throw error;
                const snapshot = await agentGraphCoordinator!.getSnapshot(sessionId);
                if (snapshot.closed || snapshot.scheduleRevision === 0) return;
                await agentGraphSupervisorWakeCoordinator!.waitForIdle();
                await agentGraphCoordinator!.waitForIdle(sessionId);
                const settled = await agentGraphCoordinator!.getSnapshot(sessionId);
                if (settled.closed) return;
                throw new Error(
                  `Agent graph became idle without finish (status=${settled.status}, revision=${settled.scheduleRevision}, snapshot=${settled.snapshotVersion})`,
                );
              }
            },
          },
        }
      : {}),
    close: async () => {
      // Stop the automation scheduler's timer (else it keeps the process alive
      // and ticks into a stopped session), then terminate background shell runs.
      automationScheduler.dispose();
      goalContinuation.dispose();
      goalManager.dispose();
      await agentGraphSupervisorWakeCoordinator?.close();
      await agentGraphCoordinator?.close();
      agentGraphControlStore?.close();
      await shellRuns.terminateAll();
      shellRunListeners.clear();
      await store.close?.();
      runtimePersistence.close();
      runStore.close?.();
      shellRunStore.close();
      artifactStore.close?.();
    },
  };
}

export async function getOrCreateCliClaudeDeviceId(
  workspaceRoot: string,
  deps: GetOrCreateCliClaudeDeviceIdDeps = {},
): Promise<string> {
  const deviceIdFilePath = join(workspaceRoot, '.maka_cli_claude_device_id');
  try {
    const existing = (await readFile(deviceIdFilePath, 'utf8')).trim();
    if (/^[a-f0-9]{64}$/i.test(existing)) return existing.toLowerCase();
  } catch {
    // fall through to create; device id persistence is best-effort metadata.
  }

  const next = (deps.newId ?? (() => randomBytes(32).toString('hex')))().toLowerCase();
  try {
    await mkdir(dirname(deviceIdFilePath), { recursive: true });
    await writeFile(deviceIdFilePath, next, { mode: 0o600 });
    await chmod(deviceIdFilePath, 0o600);
  } catch {
    // best-effort persistence; use the generated id for this process if disk fails.
  }
  return next;
}
