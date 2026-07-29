import { app, dialog, ipcMain, powerSaveBlocker, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { wireAppLifecycle } from './app-lifecycle.js';
import {
  collapseSessionRevisions,
  filterModelVisibleTaskLedgerTasks,
  resolveSystemUiLocale,
  resolveUiLocale,
} from '@maka/core';
import type {
  BotProvider,
  ConnectionEvent,
  SessionChangedEvent,
  SessionChangedReason,
  SessionEvent,
  SessionHeader,
} from '@maka/core';
import { deriveBotStatusPersistenceUpdate } from './bot-status-persistence.js';
import { runThreadSearch } from './search/thread-search.js';
import { assembleDesktopTools } from './tool-assembly.js';
import { createToolArtifactPersistence } from './tool-artifact-persistence.js';
import { ClaudeSubscriptionService } from './oauth/claude-subscription-service.js';
import { OpenAiCodexService } from './oauth/openai-codex-service.js';
import { createOpenAiCodexE2eFixtureService } from './openai-codex-e2e-fixture.js';
import { GitHubCopilotSubscriptionService } from './oauth/github-copilot-subscription-service.js';
import { XaiOAuthService } from './oauth/xai-oauth-service.js';
import { CursorSubscriptionService } from './oauth/cursor-subscription-service.js';
import { AntigravitySubscriptionService } from './oauth/antigravity-subscription-service.js';
import type { WorkspacePrivacyContext } from '@maka/core/incognito';
import { ok } from '@maka/core/result';
import {
  AgentGraphCoordinator,
  AgentGraphSupervisorWakeCoordinator,
  BackendRegistry,
  FakeBackend,
  SessionManager,
  createLocalContinuationSafetyInspector,
  buildDeepResearchTools,
  getAIModel,
  generateSessionTitle as generateRuntimeSessionTitle,
  buildProviderOptions,
  buildPricingLookup,
  BotRegistry,
  ShellRunProcessManager,
  SessionActivityRegistry,
  listInvocableSkills,
  prepareSkillInvocationMessage,
  resolveSkillDiscoveryPaths,
} from '@maka/runtime';
import type {
  BotIncomingMessage,
  BotStatus,
  GoalTurnOutcome,
  HostCapabilities,
  HostCapabilitiesResolver,
} from '@maka/runtime';
import type { LlmConnection } from '@maka/core/llm-connections';
import {
  createAgentRunStore,
  createAgentMailboxStore,
  createArtifactStore,
  createDeepResearchStore,
  createReadImageSnapshotter,
  createConnectionStore,
  createGitWorktreeChildExecutor,
  createPlanReminderStore,
  createPlanStore,
  createProjectCatalog,
  openRuntimeEventPersistence,
  createSessionStore,
  createSettingsStore,
  createMcpConfigStore,
  createShellRunStore,
  createTelemetryRepo,
} from '@maka/storage';
import { createAgentGraphControlStore } from '@maka/storage/agent-graph-control-store';
import { resolveWorkspaceIdentity } from '@maka/storage/workspace-identity';
import { McpClientManager } from '@maka/mcp';
import { registerMcpIpcMain } from './mcp-ipc-main.js';
import {
  ensureSessionCanSendOrRebind,
  errorMessage,
  requireReadyConnection,
} from './chat-readiness.js';
import { assertDesktopExecutionBoundary } from './desktop-execution-admission.js';
import { createFileCredentialStore } from './credential-store.js';
import { bindOnboardingDeps, createOnboardingService } from './onboarding-service.js';
import { createDailyReviewArchiveStore } from './daily-review-archive-store.js';
import { resolveE2eFixture, seedE2eFixture } from './e2e-fixture.js';
import { resolveBuildInfo } from './build-info.js';
import { resolveShellEnv } from './shell-env.js';
import { OpenGatewayService } from './open-gateway.js';
import { LocalMemoryService } from './local-memory-service.js';
import { createAttachmentApprovalRegistry } from './attachment-approval.js';
import { cleanupLegacyHistoryCompactArtifacts } from '@maka/runtime';
import { computerUseServiceHealth } from './computer-use-host.js';
import { createMainWindowController } from './main-window.js';
import { createDailyReviewMainService } from './daily-review-main.js';
import { createPlanReminderMainService } from './plan-reminders-main.js';
import { createBotIncomingMainService } from './bot-incoming-main.js';
import { createSubscriptionModelFetch } from './subscription-model-fetch.js';
import { createSystemPromptMainService } from './system-prompt-main.js';
import { createMainTaskLedgerWiring } from './task-ledger-wiring.js';
import { createMainAutomationWiring, evaluateAutomationCanFire } from './automation-wiring.js';
import { createMainGoalWiring } from './goal-wiring.js';
import { createOAuthModelConnectionsMainService } from './oauth-model-connections-main.js';
import { registerMemoryIpc } from './memory-ipc-main.js';
import { registerSubscriptionIpc } from './subscription-ipc-main.js';
import { registerBrowserIpc } from './browser-ipc-main.js';
import { registerConnectionsIpc } from './connections-ipc-main.js';
import { registerConfigIpc } from './config-ipc-main.js';
import { registerPlanReminderIpc } from './plan-reminders-ipc-main.js';
import { registerWorkspaceResourcesIpc } from './workspace-resources-ipc-main.js';
import type { NewSessionSkillContext } from './workspace-resources-ipc-main.js';
import { registerDailyReviewIpc } from './daily-review-ipc-main.js';
import { registerUsageIpc } from './usage-ipc-main.js';
import { registerWebSearchIpc } from './web-search-ipc-main.js';
import { registerNotificationsIpc } from './notifications-ipc-main.js';
import { registerAppIpc } from './app-ipc-main.js';
import { registerGitIpc } from './git-ipc-main.js';
import { registerWorkspaceSearchIpc } from './workspace-search-ipc-main.js';
import { registerWorkspaceInstructionsIpc } from './workspace-instructions-ipc-main.js';
import { registerOnboardingIpc } from './onboarding-ipc-main.js';
import { registerSessionEntryIpc } from './session-entry-ipc-main.js';
import { registerPermissionsIpc } from './permissions-ipc-main.js';
import {
  createPermissionOverlayMain,
  registerPermissionOverlayIpc,
} from './permission-overlay/permission-overlay-main.js';
import { registerSettingsIpc } from './settings-ipc-main.js';
import type { SettingsIpcHandle } from './settings-ipc-main.js';
import { createE2eFixtureBotOnboardingAdapters } from './bot-onboarding-e2e-fixture.js';
import { createKeepSystemAwakeController } from './keep-system-awake.js';
import { createSettingsRuntimeEffects } from './settings-runtime-effects.js';
import { createAiSdkBackendFactory, createSessionStreamer } from './session-stream.js';
import {
  resolveDesktopBackendToolSurface,
  resolveDesktopNewSessionSkillHost,
  resolveDesktopSessionSkillHost,
} from './desktop-backend-tool-surface.js';
import { registerGatewayIpc } from './gateway-ipc-main.js';
import { registerSessionsIpc } from './sessions-ipc-main.js';
import { registerAgentGraphIpc } from './agent-graph-ipc-main.js';
import {
  assertSessionCanSendFromHeader,
  isSessionLifecycleError,
  sessionLifecycleErrorFromReadFailure,
} from './session-lifecycle.js';
import { createProjectRootController } from './project-root-controller.js';
import { createProjectManagementService } from './project-management-service.js';
import {
  type DesktopCreateSessionInput,
  resolveDesktopSessionSelection,
  resolveNewSessionProjectInput,
} from './new-session-project.js';
import {
  assertSessionWorkspaceAvailable,
  isSessionWorkspaceUnavailableError,
  resolveProjectContextRoot,
} from './project-context-root.js';
import { resolveDesktopStorageRoot } from './storage-root-startup.js';

// E2E switches must never fire in a packaged build, and must never run against
// the real user data: a stray MAKA_E2E on a build/dev machine would otherwise
// swap in the fake backend or hide the window. app.isPackaged is true for
// asar-packaged builds; MAKA_E2E_USER_DATA_DIR must also be set, so the fake
// backend can't write test sessions into a real profile if someone sets only
// MAKA_E2E.
const hasIsolatedE2eProfile =
  !app.isPackaged &&
  !!process.env.MAKA_E2E_USER_DATA_DIR;
const isE2e = hasIsolatedE2eProfile && process.env.MAKA_E2E === '1';
const isComputerUseRealModelE2e =
  hasIsolatedE2eProfile &&
  process.env.MAKA_CU_REAL_MODEL_E2E === '1';
const isIsolatedE2e = isE2e || isComputerUseRealModelE2e;

// E2E isolation: redirect userData BEFORE the single-instance lock so the
// lock judges the throwaway dir, not the real user data — otherwise a
// developer with Maka open makes the E2E process exit as a "second instance".
// Gated by isE2e (not just the dir env) so a packaged build ignores it.
if (isIsolatedE2e && process.env.MAKA_E2E_USER_DATA_DIR) {
  app.setPath('userData', process.env.MAKA_E2E_USER_DATA_DIR);
}

// Electron does not enforce single-instance by default. Must run before any
// workspace/store setup below -- a losing second process exits immediately,
// before touching shared state. See the 'second-instance' listener below for
// what the surviving process does about it.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

const buildInfo = resolveBuildInfo(app.isPackaged, app.getAppPath());

// Resolve the user's login-shell PATH before any stores, tools, or child
// processes are created. On macOS, apps launched from Finder/Dock inherit a
// minimal PATH that lacks /opt/homebrew/bin, ~/.local/bin, etc. Only PATH is
// imported; application-control variables remain owned by this process.
// Skipped on Windows, when MAKA_SKIP_SHELL_ENV=1, and when launched from a
// terminal (TERM/COLORTERM set).
await resolveShellEnv();

// PR-VISUAL-SMOKE-HEADLESS: resolve the fixture defensively. An unknown
// scenario (e.g. a stale build, or a typo'd MAKA_E2E_FIXTURE) throws
// here during top-level module evaluation. Left uncaught it surfaces a
// blocking native error dialog. In fixture mode we instead log a parseable
// line and exit fast so the run fails in milliseconds with no dialog.
// Outside fixture mode the throw is rethrown.
let e2eFixture: ReturnType<typeof resolveE2eFixture>;
try {
  e2eFixture = resolveE2eFixture(
    process.env.MAKA_E2E_FIXTURE,
    app.isPackaged,
    process.env.MAKA_E2E_FIXTURE_REDUCED_MOTION,
    process.env.MAKA_E2E_FIXTURE_THEME,
    process.env.MAKA_E2E_FIXTURE_LOCALE,
    process.env.MAKA_E2E_FIXTURE_TIMEZONE,
    process.env.MAKA_E2E_FIXTURE_PLATFORM,
  );
} catch (error) {
  if (process.env.MAKA_E2E_FIXTURE) {
    console.error(`[e2e-fixture] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  throw error;
}
const workspaceRoot = join(app.getPath('userData'), 'workspaces', e2eFixture?.workspaceName ?? 'default');
const credentialStore = createFileCredentialStore(workspaceRoot);
if (e2eFixture) {
  console.log(`[e2e-fixture] scenario=${e2eFixture.scenario} workspace=${workspaceRoot}`);
  await seedE2eFixture({ workspaceRoot, fixture: e2eFixture, credentialStore });
} else {
  const storageRoot = await resolveDesktopStorageRoot(workspaceRoot, {
    confirmRepair: confirmDesktopStorageRootRepair,
  });
  if (!storageRoot) {
    app.exit(0);
    await new Promise<never>(() => {});
  }
}

async function confirmDesktopStorageRootRepair(): Promise<boolean> {
  await app.whenReady();
  const isChinese = resolveSystemUiLocale(app.getPreferredSystemLanguages()) === 'zh';
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: isChinese ? 'Maka 工作区需要修复' : 'Maka workspace needs repair',
    message: isChinese ? 'Maka 无法验证这个工作区。' : 'Maka cannot verify this workspace.',
    detail: isChinese
      ? `系统中的磁盘标识可能发生了变化。仅当这是本机原来的 Maka 工作区、而不是复制出的工作区时，才选择修复。\n\n${workspaceRoot}`
      : `The disk identity may have changed. Repair only if this is the original Maka workspace on this computer, not a copied workspace.\n\n${workspaceRoot}`,
    buttons: isChinese ? ['修复工作区', '退出'] : ['Repair Workspace', 'Exit'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return response === 0;
}
// 保持系统唤醒 (settings.system.keepSystemAwake): holds an Electron
// `powerSaveBlocker` so in-process scheduled tasks keep firing while the
// machine would otherwise sleep. Injected with electron's blocker; the
// controller owns the id + double-start guard. The blocker dies with the
// process, so quit needs no special teardown.
const keepSystemAwake = createKeepSystemAwakeController(powerSaveBlocker);
const store = createSessionStore(workspaceRoot);
const agentGraphControlStore = createAgentGraphControlStore(workspaceRoot);
const projectCatalog = createProjectCatalog(workspaceRoot);
const worktreeChildExecutor = createGitWorktreeChildExecutor({ storageRoot: workspaceRoot });
const planStore = createPlanStore(workspaceRoot);
const runStore = createAgentRunStore(workspaceRoot);
const runtimePersistence = await openRuntimeEventPersistence({
  workspaceRoot,
  sqliteCanonical: process.env.MAKA_RUNTIME_SQLITE_CANONICAL === '1',
});
const runtimeEventStore = runtimePersistence.runtimeEventStore;
const shellRunStore = createShellRunStore(workspaceRoot);
const connectionStore = createConnectionStore(workspaceRoot);
const settingsStore = createSettingsStore(workspaceRoot);
const mcpConfigStore = createMcpConfigStore(workspaceRoot);
const mcpManager = new McpClientManager({ clientName: 'maka-desktop', clientVersion: app.getVersion() });
let mcpStartup: Promise<void> | undefined;
function ensureMcpReady(): Promise<void> {
  if (!mcpStartup) {
    const startup = mcpConfigStore.get().then((config) => mcpManager.sync(config));
    mcpStartup = startup;
    void startup.catch(() => {
      if (mcpStartup === startup) mcpStartup = undefined;
    });
  }
  return mcpStartup;
}
const telemetryRepo = createTelemetryRepo(workspaceRoot);
const dailyReviewArchiveStore = createDailyReviewArchiveStore(workspaceRoot);
const artifactStore = createArtifactStore(workspaceRoot);
const deepResearchStore = createDeepResearchStore(workspaceRoot);
const storeReadImage = createReadImageSnapshotter(artifactStore);
const attachmentApprovals = createAttachmentApprovalRegistry();
// PR-OAUTH-SUBSCRIPTION-0: Claude subscription OAuth service.
// Lives in main process only; renderer accesses via IPC. Tokens
// never cross the IPC boundary (xuan G-X3). Cloak path is dynamic-
// imported behind MAKA_CLAUDE_SUBSCRIPTION_CLOAK flag (xuan G-X4)
// and lives in a separate module not statically imported here.
const claudeSubscription = new ClaudeSubscriptionService({
  userDataDir: app.getPath('userData'),
  openExternal: (url) => shell.openExternal(url),
  credentialStore,
});
// PR-MODEL-OAUTH-ALL-0: Codex / Cursor / Antigravity subscription
// services. Same shape as `claudeSubscription` — main-process only,
// IPC payloads never carry tokens, each gated behind its own
// MAKA_*_EXPERIMENTAL env var. Antigravity is a `preview` placeholder
// until the Google client_id question is resolved.
const openAiCodex = e2eFixture?.scenario === 'oauth-relogin'
  ? createOpenAiCodexE2eFixtureService()
  : new OpenAiCodexService({
      userDataDir: app.getPath('userData'),
      openExternal: (url) => shell.openExternal(url),
      credentialStore,
    });
const githubCopilotSubscription = new GitHubCopilotSubscriptionService({ credentialStore });
const xaiOAuth = new XaiOAuthService({
  credentialStore,
  openExternal: (url) => shell.openExternal(url),
});
const buildSubscriptionModelFetch = createSubscriptionModelFetch({
  claudeSubscription,
});
const oauthModelConnections = createOAuthModelConnectionsMainService({
  connectionStore,
  credentialStore,
  claudeSubscription,
  openAiCodex,
  githubCopilotSubscription,
  xaiOAuth,
  ...(e2eFixture?.scenario === 'oauth-relogin'
    ? { fetchModels: async () => [{ id: 'gpt-5.6-sol' }] }
    : {}),
});
const isClaudeSubscriptionAuthenticatedState = oauthModelConnections.isClaudeSubscriptionAuthenticatedState;

function syncClaudeSubscriptionConnection(): Promise<LlmConnection | null> {
  return oauthModelConnections.syncClaudeSubscriptionConnection();
}
function activateXaiOAuthConnection(): Promise<LlmConnection | null> {
  return oauthModelConnections.activateXaiOAuthConnection();
}
function syncXaiOAuthConnection(): Promise<LlmConnection | null> {
  return oauthModelConnections.syncXaiOAuthConnection();
}

function syncOpenAiCodexConnection(): Promise<LlmConnection | null> {
  return oauthModelConnections.syncOpenAiCodexConnection();
}

function activateOpenAiCodexConnection(): Promise<LlmConnection | null> {
  return oauthModelConnections.activateOpenAiCodexConnection();
}

function syncGitHubCopilotConnection(): Promise<LlmConnection | null> {
  return oauthModelConnections.syncGitHubCopilotConnection();
}

function syncOAuthModelConnections(): Promise<void> {
  return oauthModelConnections.syncOAuthModelConnections();
}

function resolveConnectionSecret(slug: string): Promise<string | null> {
  return oauthModelConnections.resolveConnectionSecret(slug);
}

/**
 * Read-only credential-presence check for status paths (onboarding's
 * `getSnapshot`) that must not trigger `resolveConnectionSecret`'s
 * OAuth near-expiry refresh — that refresh hits the network and
 * mutates local token state, which a read-only status read must never
 * do just by being observed. Send/test/fetch-models paths keep using
 * `resolveConnectionSecret` so they still benefit from the refresh.
 *
 * Takes the `LlmConnection` directly rather than a slug: callers that
 * already hold the connection list (onboarding does) skip the extra
 * `connectionStore.get()` round trip and derive state from one
 * consistent snapshot.
 */
function hasConnectionSecret(connection: LlmConnection): Promise<boolean> {
  return oauthModelConnections.hasConnectionSecret(connection);
}
const cursorSubscription = new CursorSubscriptionService({
  userDataDir: app.getPath('userData'),
  openExternal: (url) => shell.openExternal(url),
  credentialStore,
});
const antigravitySubscription = new AntigravitySubscriptionService({
  userDataDir: app.getPath('userData'),
  openExternal: (url) => shell.openExternal(url),
  credentialStore,
});

const planReminderStore = createPlanReminderStore(workspaceRoot);
const taskLedgerWiring = createMainTaskLedgerWiring(workspaceRoot);
const taskLedgerStore = taskLedgerWiring.store;
const agentMailboxStore = createAgentMailboxStore(workspaceRoot);

const sessionActivities = new SessionActivityRegistry();

// Unified Automation — single "Automation" tool for heartbeat + cron.
// Deps are resolved lazily since runtime/store aren't ready at this point.
const automationWiring = createMainAutomationWiring({
  workspaceRoot,
  async canFire(automation): Promise<boolean> {
    // Kind-aware fire gate (see evaluateAutomationCanFire): incognito blocks all;
    // cron is never gated on its creator session; heartbeat needs an idle session.
    return evaluateAutomationCanFire(automation, {
      isIncognitoActive: async () => (await getWorkspacePrivacyContext()).incognitoActive,
      readSessionHeader: (sessionId) => store.readHeader(sessionId),
    });
  },
  // Heartbeat: inject into the automation's own session; resolve after the stream.
  async injectTurn(sessionId: string, prompt: string, automationId: string) {
    await ensureSessionCanSend(sessionId);
    const turnId = randomUUID();
    const iterator = runtime.sendMessage(sessionId, {
      turnId, text: prompt, origin: { kind: 'automation', automationId },
    });
    const r = await streamEvents(sessionId, iterator, {
      turnId,
      goalBoundary: 'external',
    });
    return { runId: turnId, ok: r.ok, ...(r.error ? { error: r.error } : {}) };
  },
  // Cron: spawn a FRESH session (explore mode — no unapproved side effects) and
  // run the prompt there, so each fire is a first-class session + run.
  async createFreshRun(prompt: string, automationId: string) {
    const slug = await connectionStore.getDefault();
    const { connection, model } = await getReadyConnection(slug, undefined);
    const session = await createDesktopSession({
      backend: 'ai-sdk',
      llmConnectionSlug: connection.slug,
      model,
      permissionMode: 'explore',
      name: `Automation: ${prompt.slice(0, 32)}`,
      labels: ['automation', 'cron'],
    });
    emitSessionsChanged('created', session.id);
    await ensureSessionCanSend(session.id);
    const turnId = randomUUID();
    const iterator = runtime.sendMessage(session.id, {
      turnId, text: prompt, origin: { kind: 'automation', automationId },
    });
    const r = await streamEvents(session.id, iterator, {
      turnId,
      goalBoundary: 'external',
    });
    // Archive the fresh cron session after its run finalizes so recurring crons
    // do not accumulate an unbounded pile of active sessions. The session (with
    // its run/trace) is preserved under the archive, labelled automation/cron.
    try {
      await agentGraphCoordinator.stop(session.id);
      await goalWiring.archiveSession(session.id, () => runtime.archive(session.id));
      desktopSessionSkillHosts.delete(session.id);
      emitSessionsChanged('archived', session.id);
    } catch {}
    return { runId: turnId, ok: r.ok, ...(r.error ? { error: r.error } : {}) };
  },
});

// Load durable automations from disk on startup (fire-and-forget; errors are logged inside).
void automationWiring.loadDurableAutomations();

// Goal execution — autonomous turn-boundary continuation with an external
// evaluator (CC-style). Self-contained: no automation coupling (a goal is
// bounded by its own caps; a waiting goal re-checks via normal continuation).
const goalWiring = createMainGoalWiring({
  getDefaultConnectionSlug: () => connectionStore.getDefault(),
  getConnection: (slug) => connectionStore.get(slug),
  getSessionModel: async (sessionId) => {
    const header = await store.readHeader(sessionId);
    if (!header) return null;
    return { connectionSlug: header.llmConnectionSlug, model: header.model };
  },
  resolveConnectionSecret,
  buildSubscriptionModelFetch,
  getAIModel: (input) => getAIModel(input),
  buildProviderOptions: (connection, modelId) => buildProviderOptions(connection, modelId),
  getRecentMessages: async (sessionId) => {
    const messages = await runtime.getMessages(sessionId);
    return messages.slice(-10).map((m) => ({
      type: m.type,
      text: m.type === 'user' || m.type === 'assistant' ? m.text : undefined,
    }));
  },
  getTokenCount: async (sessionId) => {
    const messages = await runtime.getMessages(sessionId);
    let total = 0;
    for (const m of messages) {
      if (m.type === 'token_usage') total += (m.total ?? (m.input + m.output));
    }
    return total;
  },
  admitTurn: (sessionId, text) => {
    const whenIdle = sessionActivities.whenIdle(sessionId);
    if (whenIdle) return { kind: 'busy', whenIdle };
    const reservation = sessionActivities.reserve(sessionId);
    const turnId = randomUUID();
    return {
      kind: 'prepared',
      turnId,
      start: async (): Promise<GoalTurnOutcome> => {
        try {
          await ensureSessionCanSend(sessionId);
          const iterator = runtime.sendMessage(sessionId, { turnId, text });
          return (await streamEvents(sessionId, iterator, {
            turnId,
            goalBoundary: 'coordinator',
            activity: reservation,
          })).outcome;
        } catch (error) {
          reservation.release();
          return {
            kind: 'errored',
            turnId,
            reason: `Goal continuation could not start: ${errorMessage(error)}`,
          };
        }
      },
    };
  },
  // Surface every goal transition to the renderer so an active autonomous loop
  // is visible (badge + clear affordance) — never a silent token burn.
  onGoalChange: (goal) => emitSessionsChanged('goal-change', goal.sessionId),
  listActionableTaskKeys: async (sessionId) => {
    const tasks = await taskLedgerStore.list(sessionId, {
      includeTerminal: false,
      includeArchived: false,
    });
    return filterModelVisibleTaskLedgerTasks(tasks)
      .filter((task) => task.status === 'pending' || task.status === 'in_progress')
      .map((task) => task.key);
  },
  recordTaskGateDecision: async (trace) => {
    const runs = await runStore.listSessionRuns(trace.sessionId);
    const run = runs.find((candidate) => candidate.turnId === trace.turnId);
    if (!run) return;
    await runStore.appendEvent(trace.sessionId, run.runId, {
      type: 'task_gate_decided',
      id: randomUUID(),
      runId: run.runId,
      sessionId: trace.sessionId,
      turnId: trace.turnId,
      ts: Date.now(),
      message: `Task gate: ${trace.decision}`,
      data: {
        goalId: trace.goalId,
        decision: trace.decision,
        taskKeys: trace.taskKeys,
      },
    });
  },
});

async function getWorkspacePrivacyContext(): Promise<WorkspacePrivacyContext> {
  const settings = await settingsStore.get();
  return { incognitoActive: settings.privacy.incognitoActive === true };
}

const localMemory = new LocalMemoryService({
  workspaceRoot,
  getSettings: () => settingsStore.get(),
  updateSettings: (patch) => settingsStore.update(patch),
  getPrivacyContext: getWorkspacePrivacyContext,
});
// The synchronous Runtime Skill tools execute inside an already-built backend.
// Their resolver uses the exact host cached by that backend. Pre-send
// invocation and slash discovery derive a fresh surface from the persisted
// session header instead; see resolveDesktopSkillHostForSession below.
const desktopSessionSkillHosts = new Map<string, HostCapabilities>();
const resolveDesktopSkillHost: HostCapabilitiesResolver = ({ sessionId }) =>
  desktopSessionSkillHosts.get(sessionId) ?? desktopProductToolSurface.hostCapabilities;
// Window is created hidden for E2E and e2e-fixture runs so it never steals
// focus. Derived from the same isE2e gate as userData/fake-backend so the
// hidden-window switch stays in lockstep with the rest of the E2E isolation.
// MAKA_E2E_SHOW_WINDOW opts back into a visible window where there is no
// focus to steal (CI under xvfb): hidden windows only get ~1fps compositor
// BeginFrames on Linux, which stalls content-visibility inflation and any
// frame-paced E2E protocol (measured in the scroll-geometry climb: 38 frames
// over 31s). The E2E harness sets it, not the workflow — see fixtures.ts.
const startHidden = (Boolean(e2eFixture) || isIsolatedE2e)
  && process.env.MAKA_E2E_SHOW_WINDOW !== '1';
let onMainWindowClose = (): void => {};
const mainWindowController = createMainWindowController({
  workspaceRoot,
  e2eFixture,
  settingsStore,
  startHidden,
  onClose: () => onMainWindowClose(),
});
// Shared by 'second-instance' and 'activate': focus the existing window, or
// create one if all windows were closed while the app (macOS: still in the
// dock) stayed running -- a second launch attempt must not be a silent no-op.
function focusOrCreateMainWindow(signal: AbortSignal): void {
  if (mainWindowController.hasOpenWindows()) {
    mainWindowController.focus();
  } else {
    void mainWindowController
      .createWindow(signal)
      .catch((error) => console.error('[window] failed to create:', error));
  }
}
const safeSendToRenderer = mainWindowController.send;
taskLedgerStore.subscribe((event) => safeSendToRenderer('tasks:changed', event));
deepResearchStore.subscribe((event) => safeSendToRenderer('deepResearch:changed', event));
const deepResearchTools = buildDeepResearchTools({
  store: deepResearchStore,
  artifactStore,
  onArtifactCreated: (event) => safeSendToRenderer('artifacts:changed', event),
});
const openGateway = new OpenGatewayService({
  getSettings: () => settingsStore.get(),
  listSessions: async () => collapseSessionRevisions(await runtime.listSessions()),
  readMessages: (sessionId) => runtime.getMessages(sessionId),
  sendMessage: async (sessionId, input) => {
    await ensureSessionCanSend(sessionId);
    const turnId = randomUUID();
    const iterator = runtime.sendMessage(sessionId, {
      turnId,
      text: input.text,
    });
    void streamEvents(sessionId, iterator, {
      turnId,
      goalBoundary: 'external',
    });
    return { turnId };
  },
  searchThread: (query) =>
    runThreadSearch({ source: 'thread', query }, {
      listSessions: () => runtime.listSessions(),
      readMessages: (sessionId: string) => runtime.getMessages(sessionId),
      getPrivacyContext: getWorkspacePrivacyContext,
    }),
  onStatusChanged: (status) => {
    safeSendToRenderer('gateway:statusChanged', status);
  },
});
const backends = new BackendRegistry();
const shellRuns = new ShellRunProcessManager({
  store: shellRunStore,
  newId: randomUUID,
  now: Date.now,
  onShellRunUpdate: (update) => {
    safeSendToRenderer('shell-runs:update', update);
  },
});
const {
  persistToolArtifacts,
  snapshotReadImage,
  persistArchivedToolResult,
  readArchivedToolResult,
  readArchivedToolResultResource,
} = createToolArtifactPersistence({ artifactStore, storeReadImage, safeSendToRenderer });

const {
  riveTools,
  browserTools,
  computerUse,
  computerUseOverlay,
  computerUseTools,
  agentTeamLeadTools,
  desktopProductToolSurface,
  builtinTools,
  childAgentTools,
  sandboxDiagnosticsProvider,
} = assembleDesktopTools({
  isComputerUseRealModelE2e,
  workspaceRoot,
  taskLedgerStore,
  taskLedgerWiring,
  automationWiring,
  goalWiring,
  agentMailboxStore,
  settingsStore,
  shellRuns,
  snapshotReadImage,
  readArchivedToolResultResource,
  getWorkspacePrivacyContext,
  resolveDesktopSkillHost,
});
let agentGraphCoordinator: AgentGraphCoordinator;
let agentGraphSupervisorWakeCoordinator: AgentGraphSupervisorWakeCoordinator;
const desktopBackendToolSurfaceDeps = {
  isComputerUseRealModelE2e,
  ensureMcpReady,
  getReadyConnection,
  mcpManager,
  taskLedgerStore,
  deepResearchTools,
  computerUseTools,
  agentTeamLeadTools,
  builtinTools,
  toolEconomy: desktopProductToolSurface.identity.policy.economy,
  planStore,
  getAgentGraphSupervisorTools: (sessionId: string) =>
    agentGraphCoordinator.toolsForSession(sessionId),
};
// Cursor-overlay teardown assigns a module-scoped `let`, so it stays in main.ts.
onMainWindowClose = () => computerUseOverlay.destroyAll();
const systemPromptService = createSystemPromptMainService({
  settingsStore,
  workspaceRoot,
  localMemory,
  taskLedger: taskLedgerStore,
  goalManager: goalWiring.manager,
  hostCapabilities: desktopProductToolSurface.hostCapabilities,
});
let lookupPricing = buildPricingLookup();
let usageReadiness: Promise<void> | undefined;
function ensureUsageReady(): Promise<void> {
  if (!usageReadiness) {
    const readiness = telemetryRepo.load().then(() => {
      lookupPricing = buildPricingLookup(telemetryRepo.listPricingOverrides());
    });
    usageReadiness = readiness;
    void readiness.catch(() => {
      if (usageReadiness === readiness) usageReadiness = undefined;
    });
  }
  return usageReadiness;
}
// Track the last status fields that affect persisted diagnostics. The reason
// is part of the key because a running bridge can remain degraded while a
// newer, more useful failure replaces the previous one.
const previousBotStatus = new Map<BotProvider, Pick<BotStatus, 'readiness' | 'reason'>>();
let botIncoming: ReturnType<typeof createBotIncomingMainService>;
// Single authority for the "current project root" selection, shared across the
// app/window, git, workspace-search, workspace-instructions, and session-entry
// IPC surfaces. botIncoming and automation cron runs read the current
// selection through the thin `resolveCurrentProjectRoot` adapter below.
const projectRootController = createProjectRootController({
  lastProjectPathFile: join(workspaceRoot, 'last-project-path.json'),
  fallbackRoots: () => [process.cwd(), app.getAppPath()],
});
const projectManagement = createProjectManagementService({
  catalog: projectCatalog,
  sessions: store,
  chooseDirectory: async () => {
    const result = await mainWindowController.showOpenDialog({
      title: '添加项目',
      properties: ['openDirectory'],
    });
    return result.canceled ? undefined : result.filePaths[0];
  },
  selection: projectRootController,
});
const resolveCurrentProjectRoot: () => Promise<string> = () => projectRootController.current();
const resolveProjectRootForContext = (sessionId: unknown): Promise<string> =>
  resolveProjectContextRoot(sessionId, {
    currentProjectRoot: resolveCurrentProjectRoot,
    readSessionCwd: async (id) => (await store.readHeader(id)).cwd,
  });
const botRegistry = new BotRegistry({
  onIncomingMessage: (message: BotIncomingMessage) => {
    // Only log incoming bot messages in dev — production stdout leaking
    // platform + chatId is operational noise at best and a small privacy
    // signal at worst (which bridges are connected, with what frequency).
    if (process.env.VITE_DEV_SERVER_URL || process.env.NODE_ENV === 'development') {
      console.log('[bot] incoming message', message.platform, message.chatId);
    }
    void botIncoming.handleBotIncomingMessage(message);
  },
  onStatusChange: (status: BotStatus) => {
    safeSendToRenderer('settings:bots:statusChanged', status);
    // PR-BOT-LASTERROR-FROM-SEND-0: persist send-path failure reasons
    // to settings so they survive a Settings page close/reopen. The
    // existing connection-test path writes `lastError` only on test
    // failures; without this hook, a runtime 429 / timeout would
    // disappear the moment the renderer status panel closed.
    const previous = previousBotStatus.get(status.platform);
    previousBotStatus.set(status.platform, {
      readiness: status.readiness,
      reason: status.reason,
    });
    const update = deriveBotStatusPersistenceUpdate(previous, status);
    if (update) {
      void settingsStore.update({
        botChat: {
          channels: {
            [status.platform]: {
              ...update,
              readinessUpdatedAt: Date.now(),
            },
          },
        },
      }).catch(() => {});
    }
  },
});
const planReminders = createPlanReminderMainService({
  store: planReminderStore,
  getPrivacyContext: getWorkspacePrivacyContext,
  sendBotMessage: (platform, chatId, text) =>
    botRegistry.sendMessage(platform, chatId, text),
  emitChanged: (reason, reminder) => {
    safeSendToRenderer('plans:changed', {
      type: 'plans_changed',
      reason,
      reminderId: reminder.id,
      ts: Date.now(),
    });
  },
  emitDue: (reminder) => {
    safeSendToRenderer('plans:due', reminder);
  },
});

app.setName('Maka');

backends.register('ai-sdk', createAiSdkBackendFactory({
  ...desktopBackendToolSurfaceDeps,
  buildSubscriptionModelFetch,
  systemPromptService,
  telemetryRepo,
  ensureUsageReady,
  artifactStore,
  desktopSessionSkillHosts,
  sandboxDiagnosticsProvider,
  persistToolArtifacts,
  persistArchivedToolResult,
  readArchivedToolResult,
  runtimeCommitStore: runtimePersistence.runtimeCommitStore,
  safeSendToRenderer,
  openGateway,
  emitSessionsChanged,
  getRuntime: () => runtime,
  getLookupPricing: () => lookupPricing,
}));

backends.register('fake', (ctx) =>
  new FakeBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store, appendMessage: ctx.appendMessage }),
);

// E2E: also route 'ai-sdk' (requested by sessions:create, the single
// session-creation IPC) through the deterministic fake backend, so no
// session-creation path can escape the E2E seam and hit a real provider.
// Registered after the real ai-sdk factory to override it (BackendRegistry
// uses last-write-wins).
// Production builds never set MAKA_E2E.
if (isE2e) {
  backends.register('ai-sdk', (ctx) =>
    new FakeBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store, appendMessage: ctx.appendMessage }),
  );
}

const runtime = new SessionManager({
  store,
  planStore,
  runStore,
  runtimeEventStore,
  ...(runtimePersistence.runtimeCommitStore
    ? { toolBoundaryProtocol: runtimePersistence.runtimeCommitStore.toolBoundaryProtocol }
    : {}),
  shellRuns,
  backends,
  childTools: childAgentTools,
  worktreeChildExecutor,
  safeBoundaryResumeEnabled: process.env.MAKA_RUNTIME_SAFE_BOUNDARY_RESUME === '1',
  onContinuationLifecycleEvent: (event) => {
    console.info('[runtime-resume]', JSON.stringify(event));
  },
  inspectContinuationSafety: createLocalContinuationSafetyInspector({
    readSessionCwd: async (sessionId) => (await store.readHeader(sessionId)).cwd,
    resolveWorkspaceIdentity: async (cwd) => resolveWorkspaceIdentity({ path: cwd }),
    listAvailableToolNames: async () => [
      ...builtinTools.map((tool) => tool.name),
      'expert_dispatch',
    ],
    hasPendingBackgroundOperations: async (sessionId) => {
      const [shellUpdates, runs] = await Promise.all([
        shellRuns.listSessionUpdates(sessionId),
        runStore.listSessionRuns(sessionId),
      ]);
      return (
        shellUpdates.some((update) => update.result.status === 'running') ||
        runs.some(
          (run) =>
            run.parentRunId !== undefined &&
            ['created', 'running', 'waiting_for_user'].includes(run.status),
        )
      );
    },
  }),
  listArtifactsForTurn: async (sessionId, turnId) =>
    (await artifactStore.list(sessionId)).filter((artifact) =>
      artifact.turnId === turnId && artifact.status !== 'deleted'
    ),
  cleanupHistoryCompactArtifacts: async (input) => {
    await cleanupLegacyHistoryCompactArtifacts({
      ...input,
      artifactStore,
      onDiagnostic: (diagnostic) => console.warn('[history-compact-cleanup]', diagnostic),
    });
  },
  generateSessionTitle: async ({ sessionId, header, sourceText }) => {
    const { connection, apiKey, model } = await getReadyConnection(header.llmConnectionSlug, header.model);
    return generateRuntimeSessionTitle({
      model: getAIModel({
        connection,
        apiKey: apiKey ?? '',
        modelId: model,
        fetch: buildSubscriptionModelFetch(connection, sessionId, model),
      }),
      providerOptions: buildProviderOptions(connection, model),
      sourceText,
    });
  },
  onSessionTitleChanged: (sessionId) => emitSessionsChanged('renamed', sessionId),
  newId: randomUUID,
  now: Date.now,
});
agentGraphSupervisorWakeCoordinator = new AgentGraphSupervisorWakeCoordinator({
  activityRegistry: sessionActivities,
  wakeStore: agentGraphControlStore,
  readSnapshot: (rootSessionId) => agentGraphCoordinator.getSnapshot(rootSessionId),
  startTurn: async (sessionId, input, activity, abortSignal) => {
    let stopPromise: Promise<void> | undefined;
    const stop = () => {
      stopPromise ??= runtime.stopSession(sessionId, { source: 'graph_supervisor' });
    };
    abortSignal.addEventListener('abort', stop, { once: true });
    if (abortSignal.aborted) stop();
    try {
      await ensureSessionCanSend(sessionId);
      if (abortSignal.aborted) {
        return { kind: 'aborted', turnId: input.turnId };
      }
      const iterator = runtime.sendMessage(sessionId, input);
      return (
        await streamEvents(sessionId, iterator, {
          turnId: input.turnId,
          goalBoundary: 'none',
          activity,
        })
      ).outcome;
    } finally {
      abortSignal.removeEventListener('abort', stop);
      await stopPromise;
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
  newId: randomUUID,
  onError: (rootSessionId) => {
    emitSessionsChanged('status-change', rootSessionId);
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
    agentGraphSupervisorWakeCoordinator.notify(rootSessionId, result);
  },
});
let settingsIpc: SettingsIpcHandle | undefined;
let mcpToolSnapshot = JSON.stringify(mcpManager.tools());
mcpManager.onChange(() => {
  safeSendToRenderer('mcp:changed', mcpManager.statuses());
  const nextSnapshot = JSON.stringify(mcpManager.tools());
  if (nextSnapshot === mcpToolSnapshot) return;
  mcpToolSnapshot = nextSnapshot;
  void runtime.refreshIdleBackends().catch((error) => {
    console.warn('[mcp] failed to refresh backend tool snapshots:', error);
  });
});
const dailyReview = createDailyReviewMainService({
  archiveStore: dailyReviewArchiveStore,
  connectionStore,
  telemetryRepo,
  ensureUsageReady,
  listSessions: async () => collapseSessionRevisions(await runtime.listSessions()),
  resolveConnectionSecret,
  buildSubscriptionModelFetch,
});
botIncoming = createBotIncomingMainService({
  runtime,
  createSession: createDesktopSession,
  botRegistry,
  getDefaultConnectionSlug: () => connectionStore.getDefault(),
  getReadyConnection,
  readSessionHeader: async (sessionId) => {
    try {
      return await store.readHeader(sessionId);
    } catch (error) {
      throw sessionLifecycleErrorFromReadFailure(error) ?? error;
    }
  },
  ensureSessionCanSend,
  emitSessionsChanged,
  runAgentTurn: ({ sessionId, iterator, turnId, onEvent }) => streamEvents(sessionId, iterator, {
    turnId,
    goalBoundary: 'external',
    observeEvent: onEvent,
  }),
});

// PR110b: onboarding service composes existing stores + runtime to
// derive `OnboardingState` and manage `OnboardingMilestone[]`.
// Constructed AFTER `runtime` so `listSessions()` is bindable. The
// service checks credential presence through `hasConnectionSecret`
// (read-only — recognizes OAuth-subscription connections like the
// send-path's `resolveConnectionSecret` does, but never refreshes),
// so simply opening onboarding can't hit the network or mutate token
// state.
const onboardingService = createOnboardingService(
  bindOnboardingDeps({
    settingsStore,
    connectionStore,
    hasCredential: hasConnectionSecret,
    listSessions: () => runtime.listSessions(),
  }),
);

function registerIpc(): void {
  const currentProjectRoot = resolveCurrentProjectRoot;
  ipcMain.handle('deepResearch:get', (_event, sessionId: string) =>
    deepResearchStore.read(sessionId));
  registerMcpIpcMain({
    ipcMain,
    store: mcpConfigStore,
    manager: mcpManager,
    ensureReady: ensureMcpReady,
    refreshIdleBackends: () => runtime.refreshIdleBackends(),
    emitChanged: (statuses) => safeSendToRenderer('mcp:changed', statuses),
  });

  registerAppIpc({
    mainWindowController,
    projectRoot: projectRootController,
    getSessionProjectRoot: async (sessionId) => (await store.readHeader(sessionId)).cwd,
    getProjectRoot: resolveProjectRootForContext,
    workspaceRoot,
    buildInfo,
    e2eFixture,
    projectManagement,
  });
  registerMemoryIpc({ localMemory });
  registerConfigIpc({ connectionStore, settingsStore, credentialStore, workspaceRoot });
  registerNotificationsIpc({ settingsStore, mainWindowController, e2e: isE2e });
  registerWorkspaceInstructionsIpc({ getCurrentProjectRoot: currentProjectRoot });
  registerWorkspaceResourcesIpc({
    workspaceRoot,
    artifactStore,
    mainWindowController,
    sendToRenderer: safeSendToRenderer,
    listInvocableSkills: listDesktopInvocableSkills,
    skillHost: desktopProductToolSurface.hostCapabilities,
    getCurrentProjectRoot: currentProjectRoot,
    getSkillSelectionReport: systemPromptService.getLastSkillSelectionReport,
    invalidateSkillSelectionReport: systemPromptService.invalidateSkillSelectionReport,
  });
  registerWorkspaceSearchIpc({ getProjectRoot: resolveProjectRootForContext });
  registerGitIpc({ getProjectRoot: resolveProjectRootForContext });
  registerPlanReminderIpc({ planReminders, getWorkspacePrivacyContext });
  registerAgentGraphIpc({
    coordinator: agentGraphCoordinator,
    sendToRenderer: safeSendToRenderer,
  });
  registerSessionsIpc({
    runtime,
    store,
    taskLedgerStore,
    goalWiring,
    automationManager: automationWiring.manager,
    computerUseOverlay,
    computerUseTools,
    artifactStore,
    attachmentApprovals,
    settingsStore,
    connectionStore,
    mainWindowController,
    e2eFixture,
    emitSessionsChanged,
    ensureSessionCanSend,
    prepareSkillInvocation: prepareDesktopSkillInvocation,
    invalidateSessionBindings: (sessionId) => botIncoming.invalidateSessionBindings(sessionId),
    clearSkillHost: (sessionId) => desktopSessionSkillHosts.delete(sessionId),
    stopAgentGraph: async (sessionId) => {
      const header = await store.readHeader(sessionId);
      if (!header.subagentParent) await agentGraphCoordinator.stop(sessionId);
    },
    notifyAgentGraphPermissionResponse: (sessionId) => {
      agentGraphSupervisorWakeCoordinator.notifyPermissionResponse(sessionId);
    },
    ensureSessionWorkspaceAvailable,
    createSession: createDesktopSession,
    getReadyConnection,
    streamEvents,
    getWorkspacePrivacyContext,
    canCreateFakeSession: canCreateFakeSessionFromRenderer,
  });
  registerSubscriptionIpc({
    connectionStore,
    claudeSubscription,
    openAiCodex,
    githubCopilotSubscription,
    xaiOAuth,
    cursorSubscription,
    antigravitySubscription,
    isClaudeSubscriptionAuthenticatedState,
    syncClaudeSubscriptionConnection,
    activateOpenAiCodexConnection,
    syncOpenAiCodexConnection,
    syncGitHubCopilotConnection,
    activateXaiOAuthConnection,
    syncXaiOAuthConnection,
    emitConnectionListChanged,
  });
  registerWebSearchIpc({ settingsStore, getWorkspacePrivacyContext });
  registerBrowserIpc({ mainWindowController });
  registerConnectionsIpc({
    connectionStore,
    credentialStore,
    syncOAuthModelConnections,
    resolveConnectionSecret,
    hasConnectionSecret,
    emitConnectionListChanged,
    // Same seam as the fake-backend override above, for the other IPC that can
    // leave the machine: adding a catalog provider runs remote model discovery
    // against the provider's real endpoint. In E2E the key is a placeholder, so
    // discovery can only fail — but it fails at whatever speed the network
    // answers, and the add dialog stays open for the whole round trip. The
    // provider-side budget (10s) is exactly the suite's expect timeout (10s),
    // so a slow answer flips `await expect(dialog).toBeHidden()` from pass to
    // fail with no code change. Fail deterministically and offline instead,
    // which is the outcome a placeholder key produces anyway.
    ...(isE2e
      ? {
          fetchModels: async () => {
            throw new Error('E2E: remote model discovery is disabled');
          },
        }
      : {}),
  });
  registerOnboardingIpc({ onboardingService });
  registerSessionEntryIpc({
    runtime,
    getReadyConnection,
    getOnboardingState: async () => (await onboardingService.getSnapshot()).state,
    emitSessionsChanged,
    ensureSessionCanSend,
    createSession: createDesktopSession,
    streamEvents,
  });
  registerPermissionsIpc({
    settingsStore,
    connectionStore,
    telemetryRepo,
    ensureUsageReady,
    botRegistry,
    getComputerUseCapabilityInput: computerUseCapabilityInput,
  });
  // Drag-to-grant onboarding for the two TCC permissions macOS offers no
  // programmatic consent dialog for. See docs/permission-onboarding-plan.md.
  const permissionOverlay = createPermissionOverlayMain({
    resolveLocale: async () => {
      const settings = await settingsStore.get();
      return resolveUiLocale(
        settings.personalization.uiLocale,
        resolveSystemUiLocale(app.getPreferredSystemLanguages()),
      );
    },
  });
  registerPermissionOverlayIpc({ controller: permissionOverlay });
  // A screen-saver-level panel pinned to every Space is visible to the
  // user if it outlives a slow quit; close it explicitly rather than
  // relying on process teardown to race it away.
  app.on('before-quit', () => permissionOverlay.dismiss());
  settingsIpc = registerSettingsIpc({
    settingsStore,
    botRegistry,
    normalizeSettingsPatch,
    applySettingsRuntimeEffects,
    ...(e2eFixture?.scenario === 'settings-bots'
      ? {
          botOnboardingAdapters: createE2eFixtureBotOnboardingAdapters(),
          botOnboardingApplySettingsRuntimeEffects: async () => undefined,
          // The fixture no-ops runtime effects, so no real bridge starts.
          // Report the onboarded channel as running to demonstrate the
          // successful "connected" path (the P0-3 warning path is covered by
          // bot-onboarding-main.test.ts).
          botOnboardingReadChannelStatus: () => ({ running: true }),
        }
      : {}),
  });
  registerGatewayIpc({ openGateway });
  registerDailyReviewIpc({ dailyReview, dailyReviewArchiveStore, mainWindowController });
  registerUsageIpc({
    ipcMain,
    settingsStore,
    telemetryRepo,
    ensureUsageReady,
    refreshPricingLookup: () => {
      lookupPricing = buildPricingLookup(telemetryRepo.listPricingOverrides());
    },
    sendToRenderer: safeSendToRenderer,
  });
}

function canCreateFakeSessionFromRenderer(): boolean {
  return !app.isPackaged && (
    Boolean(e2eFixture) ||
    Boolean(process.env.VITE_DEV_SERVER_URL) ||
    process.env.NODE_ENV === 'development'
  );
}

const { normalizeSettingsPatch, applySettingsRuntimeEffects, handleExternalSettingsChange } =
  createSettingsRuntimeEffects({
    settingsStore,
    botRegistry,
    openGateway,
    keepSystemAwake,
    safeSendToRenderer,
  });

const streamEvents = createSessionStreamer({
  sessionActivities,
  goalWiring,
  openGateway,
  computerUseOverlay,
  computerUseTools,
  safeSendToRenderer,
  emitSessionsChanged,
  interruptActivePlanExecution: (sessionId, reason) =>
    runtime.interruptActivePlanExecution(sessionId, reason),
});

async function ensureSessionCanSend(sessionId: string): Promise<void> {
  const boundary = await runtime.readExecutionBoundary(sessionId);
  assertDesktopExecutionBoundary(sessionId, boundary);
  const header = await readAvailableSessionHeader(sessionId);
  let result: Awaited<ReturnType<typeof ensureSessionCanSendOrRebind>>;
  try {
    result = await ensureSessionCanSendOrRebind(sessionId, header, {
      readyConnectionDeps,
      getDefaultSlug: () => connectionStore.getDefault(),
      listConnectionSlugs: async () => (await connectionStore.list()).map((connection) => connection.slug),
      updateSession: (_sessionId, patch) => runtime.updateSession(_sessionId, {
        ...patch,
        status: 'active',
        blockedReason: undefined,
        statusUpdatedAt: Date.now(),
      }),
    });
  } catch (error) {
    if (isSessionLifecycleError(error)) throw error;
    await runtime.setSessionStatus(sessionId, 'blocked', 'NO_REAL_CONNECTION').catch(() => {});
    emitSessionsChanged('status-change', sessionId);
    throw error;
  }
  if (result.rebound) {
    emitSessionsChanged('rebound', sessionId, {
      connectionSlug: result.connectionSlug,
      modelId: result.modelId,
    });
  }
}

async function readAvailableSessionHeader(sessionId: string) {
  let header;
  try {
    header = await store.readHeader(sessionId);
  } catch (error) {
    const lifecycleError = sessionLifecycleErrorFromReadFailure(error);
    if (lifecycleError) throw lifecycleError;
    throw error;
  }
  assertSessionCanSendFromHeader(header);
  await assertSessionWorkspaceAvailable(header.cwd);
  return header;
}

async function ensureSessionWorkspaceAvailable(sessionId: string): Promise<void> {
  await readAvailableSessionHeader(sessionId);
}

async function createDesktopSession(input: DesktopCreateSessionInput) {
  const selected = await resolveDesktopSessionSelection(input, projectManagement);
  await assertSessionWorkspaceAvailable(selected.cwd);
  return runtime.createSession(await resolveNewSessionProjectInput(selected, projectCatalog));
}

const readyConnectionDeps = {
  getConnection: (slug: string) => connectionStore.get(slug),
  getApiKey: (slug: string) => resolveConnectionSecret(slug),
};

function getReadyConnection(slug: string | null | undefined, model?: string) {
  return requireReadyConnection(slug, readyConnectionDeps, model);
}

async function resolveDesktopSkillHostForSession(
  sessionId: string,
): Promise<HostCapabilities> {
  const header = await store.readHeader(sessionId);
  return resolveDesktopSessionSkillHost(desktopBackendToolSurfaceDeps, {
    sessionId,
    header,
    childTools: childAgentTools,
  });
}

async function resolveDesktopSkillHostForNewSession(
  projectRoot: string,
  context?: NewSessionSkillContext,
): Promise<HostCapabilities> {
  const ready = await getReadyConnection(
    context?.llmConnectionSlug ?? (await connectionStore.getDefault()),
    context?.model,
  );
  return resolveDesktopNewSessionSkillHost(desktopBackendToolSurfaceDeps, {
    projectRoot,
    workspaceRoot,
    readyConnection: ready,
    context,
  });
}

async function prepareDesktopSkillInvocation(
  sessionId: string,
  text: string,
  skillIds?: readonly string[],
) {
  const [projectRoot, host] = await Promise.all([
    resolveProjectRootForContext(sessionId),
    resolveDesktopSkillHostForSession(sessionId),
  ]);
  return prepareSkillInvocationMessage({
    text,
    ...(skillIds ? { skillIds } : {}),
    source: resolveSkillDiscoveryPaths(projectRoot, workspaceRoot),
    host,
  });
}

async function listDesktopInvocableSkills(
  sessionId?: string,
  newSessionContext?: NewSessionSkillContext,
) {
  try {
    const projectRoot = await resolveProjectRootForContext(sessionId);
    const host = sessionId
      ? await resolveDesktopSkillHostForSession(sessionId)
      : await resolveDesktopSkillHostForNewSession(projectRoot, newSessionContext);
    return await listInvocableSkills(
      resolveSkillDiscoveryPaths(projectRoot, workspaceRoot),
      host,
    );
  } catch (error) {
    // Stale sessions with a removed working directory remain browseable, but
    // cannot offer project-aware Skill suggestions. Treat that expected state
    // as an empty projection instead of generating a rejected IPC/log entry.
    if (sessionId && isSessionWorkspaceUnavailableError(error)) return [];
    throw error;
  }
}

function emitConnectionListChanged(): void {
  const event: ConnectionEvent = {
    type: 'connection_list_changed',
    id: randomUUID(),
    ts: Date.now(),
  };
  safeSendToRenderer('connections:event', event);
}

function emitSessionsChanged(
  reason: SessionChangedReason,
  sessionId?: string,
  extra?: Pick<SessionChangedEvent, 'connectionSlug' | 'modelId'>,
): void {
  const event: SessionChangedEvent = {
    type: 'sessions_changed',
    reason,
    ts: Date.now(),
  };
  if (sessionId) event.sessionId = sessionId;
  if (extra?.connectionSlug) event.connectionSlug = extra.connectionSlug;
  if (extra?.modelId) event.modelId = extra.modelId;
  safeSendToRenderer('sessions:changed', event);
}

registerIpc();

wireAppLifecycle({
  isIsolatedE2e,
  e2eFixture,
  workspaceRoot,
  sessionStore: store,
  projectCatalog,
  credentialStore,
  connectionStore,
  settingsStore,
  telemetryRepo,
  ensureUsageReady,
  keepSystemAwake,
  botRegistry,
  openGateway,
  planReminders,
  dailyReview,
  automationWiring,
  goalWiring,
  computerUse,
  computerUseOverlay,
  shellRuns,
  mcpManager,
  runtimePersistence,
  mainWindowController,
  runtime,
  agentGraphCoordinator,
  agentGraphSupervisorWakeCoordinator,
  agentGraphControlStore,
  streamEvents,
  focusOrCreateMainWindow,
  emitConnectionListChanged,
  emitSessionsChanged,
  handleExternalSettingsChange,
  getSettingsIpc: () => settingsIpc,
});

function computerUseCapabilityInput() {
  const serviceState = computerUse.backend?.serviceState?.();
  return {
    backendId: computerUse.backendId,
    health: computerUseServiceHealth(computerUse.backendId, serviceState),
  };
}
