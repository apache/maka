import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { stat } from 'node:fs/promises';
import { ipcMain as electronIpcMain } from 'electron';
import {
  isCollaborationMode,
  isOrchestrationMode,
  isPermissionMode,
  revisionFamilySessionIds,
  isThinkingLevel,
  sanitizeTaskLedgerTask,
  thinkingVariantsForModel,
} from '@maka/core';
import type {
  CreateSessionRequestInput,
  SandboxBoundaryExpansion,
  SessionEvent,
  SessionChangedEvent,
  SessionChangedReason,
  SessionListFilter,
  StoredMessage,
  ThinkingLevel,
} from '@maka/core';
import type { ProviderType } from '@maka/core/llm-connections';
import type { WorkspacePrivacyContext } from '@maka/core/incognito';
import type { PreparedSkillInvocationMessage, SessionManager } from '@maka/runtime';
import type { createArtifactStore, createSessionStore } from '@maka/storage';
import type { ConnectionStore, SettingsStore } from '@maka/storage';
import { runThreadSearch } from './search/thread-search.js';
import { resolveSessionSend } from './session-send-resolve.js';
import { resizeImageForAttachment } from './attachment-resize-native.js';
import { releaseBrowserSession } from './browser/session.js';
import { sessionReadMessagesFailureMessage } from './session-read-error-copy.js';
import { resolveCreateSessionInput } from './create-session-input.js';
import {
  normalizeSandboxBoundaryResponse,
  normalizeSessionSendCommand,
  normalizeStopSessionInput,
  normalizeUserQuestionResponse,
} from './permission-response-guard.js';
import {
  getE2eFixtureState,
  retireE2eFixtureSandboxBoundaryRequest,
  type resolveE2eFixture,
} from './e2e-fixture.js';
import type { requireReadyConnection } from './chat-readiness.js';
import type { MainTaskLedgerWiring } from './task-ledger-wiring.js';
import type { MainGoalWiring } from './goal-wiring.js';
import type { MainAutomationWiring } from './automation-wiring.js';
import type { AttachmentApprovalRegistry } from './attachment-approval.js';
import type { createMainWindowController } from './main-window.js';
import { handleBranchFromTurn } from './session-branch.js';
import { handleReviseBeforeTurn } from './session-revision.js';
import { prepareSessionSendSkillPlan } from './session-send-skill-plan.js';
import type { DesktopCreateSessionInput } from './new-session-project.js';
import { registerSessionExecutionIpc } from './session-execution-ipc-main.js';

type SessionStore = ReturnType<typeof createSessionStore>;
type ArtifactStore = ReturnType<typeof createArtifactStore>;
type MainWindowController = ReturnType<typeof createMainWindowController>;
type E2eFixture = ReturnType<typeof resolveE2eFixture>;

/** The per-session cleanup subset of the cursor-overlay controller. */
interface SessionOverlayCleanup {
  clearForSession(sessionId: string): void;
}
/** The per-session cleanup subset of the computer-use tool group. */
interface SessionToolCleanup {
  clearSession(sessionId: string): void;
}

export interface SessionsIpcDeps {
  runtime: SessionManager;
  store: SessionStore;
  taskLedgerStore: MainTaskLedgerWiring['store'];
  goalWiring: MainGoalWiring;
  automationManager: MainAutomationWiring['manager'];
  computerUseOverlay: SessionOverlayCleanup;
  computerUseTools: SessionToolCleanup;
  artifactStore: ArtifactStore;
  attachmentApprovals: AttachmentApprovalRegistry;
  settingsStore: SettingsStore;
  connectionStore: ConnectionStore;
  mainWindowController: MainWindowController;
  e2eFixture: E2eFixture;
  emitSessionsChanged: (
    reason: SessionChangedReason,
    sessionId?: string,
    extra?: Pick<SessionChangedEvent, 'connectionSlug' | 'modelId'>,
  ) => void;
  ensureSessionCanSend: (sessionId: string) => Promise<void>;
  prepareSkillInvocation?: (
    sessionId: string,
    text: string,
    skillIds?: readonly string[],
  ) => Promise<PreparedSkillInvocationMessage>;
  invalidateSessionBindings?: (sessionId: string) => void;
  clearSkillHost?: (sessionId: string) => void;
  stopAgentGraph?: (sessionId: string) => Promise<void>;
  notifyAgentGraphPermissionResponse?: (sessionId: string) => void;
  ensureSessionWorkspaceAvailable: (sessionId: string) => Promise<void>;
  createSession: (input: DesktopCreateSessionInput) => ReturnType<SessionManager['createSession']>;
  getReadyConnection: (
    slug: string | null | undefined,
    model?: string,
  ) => ReturnType<typeof requireReadyConnection>;
  streamEvents: (
    sessionId: string,
    iterator: AsyncIterable<SessionEvent>,
    options: {
      turnId: string;
      goalBoundary: 'external' | 'none';
    },
  ) => Promise<{ turnId: string; ok: boolean; error?: string }>;
  getWorkspacePrivacyContext: () => Promise<WorkspacePrivacyContext>;
  canCreateFakeSession: () => boolean;
}

function latestStoredMessageTs(messages: readonly StoredMessage[]): number | undefined {
  let latest: number | undefined;
  for (const message of messages) {
    if (Number.isFinite(message.ts)) latest = latest === undefined ? message.ts : Math.max(latest, message.ts);
  }
  return latest;
}

function normalizeSessionModelSelection(input: unknown): { llmConnectionSlug: string; model: string } {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid model selection');
  }
  const record = input as Record<string, unknown>;
  const llmConnectionSlug = typeof record.llmConnectionSlug === 'string' ? record.llmConnectionSlug.trim() : '';
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  if (!llmConnectionSlug) {
    throw new Error('Missing model connection');
  }
  if (!model) {
    throw new Error('Missing model');
  }
  return { llmConnectionSlug, model };
}

function normalizeSupportedSessionThinkingLevel(
  input: unknown,
  providerType: ProviderType,
  model: string,
): ThinkingLevel | undefined {
  const thinkingLevel = input === undefined || input === null ? undefined : input;
  if (thinkingLevel === undefined) return undefined;
  if (!isThinkingLevel(thinkingLevel)) {
    throw new Error(`Invalid thinking level: ${String(input)}`);
  }
  if (!thinkingVariantsForModel(providerType, model).includes(thinkingLevel)) {
    throw new Error(`当前模型不支持思考级别：${thinkingLevel}`);
  }
  return thinkingLevel;
}

function requestsRevisionFamily(options: unknown): boolean {
  if (options === undefined) return false;
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Invalid session family action options');
  }
  const value = (options as { revisionFamily?: unknown }).revisionFamily;
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error('Invalid revisionFamily option');
  return value;
}

async function resolveSessionActionIds(
  runtime: SessionManager,
  sessionId: string,
  options: unknown,
): Promise<string[]> {
  if (!requestsRevisionFamily(options)) return [sessionId];
  return revisionFamilySessionIds(await runtime.listSessions(), sessionId);
}

export function registerSessionsIpc(
  deps: SessionsIpcDeps,
  ipcMain: Pick<typeof electronIpcMain, 'handle'> = electronIpcMain,
): void {
  const {
    runtime,
    store,
    taskLedgerStore,
    goalWiring,
    automationManager,
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
    prepareSkillInvocation,
    invalidateSessionBindings,
    clearSkillHost,
    stopAgentGraph,
    notifyAgentGraphPermissionResponse,
    ensureSessionWorkspaceAvailable,
    createSession,
    getReadyConnection,
    streamEvents,
    getWorkspacePrivacyContext,
    canCreateFakeSession,
  } = deps;
  registerSessionExecutionIpc({
    ipcMain,
    runtime,
    ensureSessionCanSend,
    ensureSessionWorkspaceAvailable,
    streamEvents,
    emitModeChanged: (sessionId) => emitSessionsChanged('mode-change', sessionId),
  });
  ipcMain.handle('shell-runs:list', (_event, sessionId: string) => runtime.listShellRunUpdates(sessionId));
  ipcMain.handle('tasks:list', async (_event, sessionId: string) => {
    const tasks = await taskLedgerStore.list(sessionId, {
      includeTerminal: true,
      includeArchived: false,
      classifyResumeTrust: true,
      ...(e2eFixture ? { now: getE2eFixtureState(e2eFixture)?.now ?? Date.now() } : {}),
    });
    return tasks.map(sanitizeTaskLedgerTask);
  });
  ipcMain.handle('sessions:list', (_event, filter?: SessionListFilter) => runtime.listSessions(filter));
  ipcMain.handle('sessions:create', async (_event, input?: CreateSessionRequestInput) => {
    // #1433: `mode` is a product intent, not a session field. What it implies,
    // what the renderer may ask for directly, and what the configured default
    // fills in are all resolved in one pure place (create-session-input.ts),
    // which is also the only place any of it can be tested.
    const { permissionMode, collaborationMode, orchestrationMode, name, labels } =
      await resolveCreateSessionInput(input, { readSettings: () => settingsStore.get() });
    if (input?.backend === 'fake') {
      if (!canCreateFakeSession()) {
        throw new Error('FakeBackend sessions are only available in development.');
      }
      const session = await createSession({
        ...(input?.cwd ? { cwd: input.cwd } : {}),
        projectId: input?.projectId,
        backend: 'fake',
        llmConnectionSlug: input.llmConnectionSlug ?? 'fake',
        model: input.model ?? 'fake-model',
        permissionMode,
        collaborationMode,
        orchestrationMode,
        name,
        labels,
      });
      emitSessionsChanged('created', session.id);
      return session;
    }

    const requestedSlug = input?.llmConnectionSlug ?? (await connectionStore.getDefault());
    const { connection, model } = await getReadyConnection(requestedSlug, input?.model);
    const thinkingLevel = normalizeSupportedSessionThinkingLevel(input?.thinkingLevel, connection.providerType, model);

    const session = await createSession({
      ...(input?.cwd ? { cwd: input.cwd } : {}),
      projectId: input?.projectId,
      backend: 'ai-sdk',
      llmConnectionSlug: connection.slug,
      model,
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      permissionMode,
      collaborationMode,
      orchestrationMode,
      name,
      labels,
    });
    emitSessionsChanged('created', session.id);
    return session;
  });
  ipcMain.handle('sessions:readMessages', async (_event, sessionId: string) => {
    if (e2eFixture) return store.readMessages(sessionId);
    let messages: StoredMessage[];
    try {
      messages = await runtime.getMessages(sessionId);
    } catch (error) {
      throw new Error(sessionReadMessagesFailureMessage(error));
    }
    try {
      await runtime.markSessionRead(sessionId, latestStoredMessageTs(messages));
    } catch {
      // Reading the content already succeeded. Leave the persisted unread
      // state for a later refresh instead of turning this into a load error.
    }
    return messages;
  });
  ipcMain.handle('sessions:listTurns', (_event, sessionId: string) => runtime.listTurns(sessionId));
  // Goal kill-switch surface: the renderer reads the active goal to badge a
  // session running an autonomous loop, and clears it to stop the loop. `get`
  // returns null when no goal is set; `clear` settles it (continuation stops
  // after the current turn). Both are pure local state, so no permission gate.
  ipcMain.handle('goal:get', (_event, sessionId: string) => goalWiring.manager.get(sessionId) ?? null);
  ipcMain.handle('goal:clear', (_event, sessionId: string) => {
    goalWiring.clearGoal(sessionId);
  });
  // PR-SEARCH-2: local thread search. Renderer-facing channel; the pure
  // helper in `./search/thread-search.ts` enforces all gates (G1 snippet
  // redaction, G2 fake-backend exclude, G4 caps, G5 case-fold + NFC,
  // G9 tool_result scan cap, G10 system/meta exclusion). The helper
  // receives the runtime via DI so unit tests stay Electron-agnostic.
  // We deliberately do NOT log the request body — query text never enters
  // telemetry.
  ipcMain.handle('search:thread', async (_event, request: unknown) => {
    // PR-SEARCH-2 review fixup (@xuan `2f1aba55`): pass `unknown`
    // through to the helper, which runs an object-shape guard and
    // returns an `invalid_query` error envelope for null / non-object
    // / missing-field payloads. Never throws across the IPC boundary.
    //
    // PR-SEARCH-2.5 (@xuan `2c55b975`): wire `getPrivacyContext` to
    // the main-authority workspace privacy state.
    //
    // This is the main-owned workspace privacy source, not a renderer
    // self-attestation. The helper validates whatever shape is returned
    // via `validateWorkspacePrivacyContext`, so a future drift in
    // authority source is automatically fail-closed.
    return runThreadSearch(request, {
      listSessions: () => runtime.listSessions(),
      readMessages: (sessionId: string) => runtime.getMessages(sessionId),
      getPrivacyContext: getWorkspacePrivacyContext,
    });
  });
  ipcMain.handle('sessions:stop', async (_event, sessionId: string, input?: { source?: 'stop_button' }) => {
    computerUseOverlay.clearForSession(sessionId);
    computerUseTools.clearSession(sessionId);
    await stopAgentGraph?.(sessionId);
    await runtime.stopSession(sessionId, normalizeStopSessionInput(input));
    await runtime.interruptActivePlanExecution(sessionId, 'user_stopped_execution').catch(() => null);
    emitSessionsChanged('status-change', sessionId);
    emitSessionsChanged('turn-status-change', sessionId);
    emitSessionsChanged('message-appended', sessionId);
  });
  ipcMain.handle('sessions:readExecutionBoundary', (_event, sessionId: string) =>
    runtime.readExecutionBoundary(sessionId),
  );
  ipcMain.handle('sessions:listActiveSandboxBoundaryRequests', (_event, sessionId: string) => {
    // Already filtered by retirement: `getE2eFixtureState` is the one owner of
    // which fixture requests are still unanswered.
    const fixtureRequest = getE2eFixtureState(e2eFixture)?.sandboxBoundaryBySession?.[sessionId];
    return fixtureRequest
      ? [fixtureRequest]
      : runtime.listActiveSandboxBoundaryRequests(sessionId);
  });
  ipcMain.handle('sessions:respondToSandboxBoundary', async (_event, sessionId: string, response) => {
    const normalized = normalizeSandboxBoundaryResponse(response);
    const fixtureRequest = getE2eFixtureState(e2eFixture)?.sandboxBoundaryBySession?.[sessionId];
    if (fixtureRequest?.requestId === normalized.requestId) {
      // The fixture request is synthetic — no runtime turn is waiting on it —
      // but allowing it must still move the real boundary, or the fixture
      // would model an "allow" that grants nothing and no surface built on the
      // boundary could be exercised against it (#1611).
      if (normalized.decision === 'allow') {
        // Retired only once the grant has landed. The runtime drops an active
        // request when the decision is acknowledged, not when it is received;
        // hiding this one before the write succeeds would let the fixture
        // swallow a settlement failure the renderer is about to be told about.
        await applyFixtureSandboxBoundaryExpansion(store, sessionId, fixtureRequest.expansion);
      }
      retireE2eFixtureSandboxBoundaryRequest(normalized.requestId);
      return;
    }
    if (normalized.decision === 'allow') {
      await ensureSessionWorkspaceAvailable(sessionId);
    }
    await runtime.respondToSandboxBoundary(sessionId, normalized);
    notifyAgentGraphPermissionResponse?.(sessionId);
  });
  ipcMain.handle('sessions:respondToUserQuestion', async (_event, sessionId: string, response) => {
    const normalized = normalizeUserQuestionResponse(response);
    await ensureSessionWorkspaceAvailable(sessionId);
    return runtime.respondToUserQuestion(sessionId, normalized);
  });
  ipcMain.handle('sessions:send', async (event, sessionId: string, command: unknown) => {
    const sendCommand = normalizeSessionSendCommand(command);
    if (!sendCommand) return;
    const sendPlan = await prepareSessionSendSkillPlan({
      prepare: () =>
        prepareSkillInvocation
          ? prepareSkillInvocation(sessionId, sendCommand.text, sendCommand.skillIds)
          : Promise.resolve({
              disposition: 'passthrough' as const,
              sendText: sendCommand.text,
              skillInvocation: { loaded: [], failed: [], receipts: [] },
            }),
      resolveSend: () =>
        resolveSessionSend({
          sessionId,
          senderId: event.sender.id,
          command: sendCommand,
          ensureCanSend: ensureSessionCanSend,
          readHeader: (id) => store.readHeader(id),
          approvals: attachmentApprovals,
          stat: async (path) => ({ size: (await stat(path)).size }),
          artifactStore,
          resizeImage: resizeImageForAttachment,
        }),
    });
    if (!sendPlan.ok) return sendPlan;
    const skillInvocation = sendPlan.preparation;
    const { turnId, attachments } = sendPlan.resolved;
    const displayText =
      sendCommand.text.trim().length > 0
        ? sendCommand.text
        : skillInvocation.skillInvocation.loaded
            .map((skill) => `/skill:${skill.id}`)
            .join(' ');
    const iterator = runtime.sendMessage(
      sessionId,
      {
        turnId,
        text: skillInvocation.sendText,
        ...(skillInvocation.disposition === 'ready' ? { displayText } : {}),
        ...(sendCommand.turnOrchestration
          ? { turnOrchestration: sendCommand.turnOrchestration }
          : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(sendCommand.quotes ? { quotes: sendCommand.quotes } : {}),
      },
      {
        onRunStarted: async (_runId, header) => {
          if (header.revisionState === 'preparing') {
            await runtime.commitRevisionVersion(sessionId);
          }
        },
      },
    );
    void streamEvents(sessionId, iterator, { turnId, goalBoundary: 'external' });
    return {
      ok: true as const,
      turnId,
      attachments,
      skillInvocation: skillInvocation.skillInvocation,
    };
  });
  ipcMain.handle(
    'attachments:pickFiles',
    async (event): Promise<
      | { ok: true; files: { approvalId: string; name: string; mimeType?: string; size: number }[] }
      | { ok: false; reason: 'cancelled' }
    > => {
      const result = await mainWindowController.showOpenDialog({
        title: '添加附件',
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, reason: 'cancelled' };
      const chosen = await Promise.all(
        result.filePaths.map(async (path) => ({ path, name: basename(path), size: (await stat(path)).size })),
      );
      // Paths stay in main; the renderer only gets one-shot opaque tokens.
      return { ok: true, files: attachmentApprovals.issueApprovals(event.sender.id, chosen) };
    },
  );
  ipcMain.handle(
    'attachments:readBytes',
    async (_event, sessionId: string, relativePath: string): Promise<
      | { ok: true; base64: string; mimeType: string }
      | { ok: false; reason: string }
    > => {
      // Session-scoped read: only attachments filed under this session.
      const record = await artifactStore.get(relativePath).catch(() => null);
      if (!record || record.sessionId !== sessionId) return { ok: false, reason: 'not_found' };
      const result = await artifactStore.readBinary(relativePath);
      if (!result.ok) return result;
      return { ok: true, base64: result.base64, mimeType: result.mimeType };
    },
  );
  ipcMain.handle('sessions:branchFromTurn', async (_event, sessionId: string, input: unknown) => {
    return handleBranchFromTurn(sessionId, input, {
      ensureSessionWorkspaceAvailable,
      branchFromTurn: (id, normalized) => runtime.branchFromTurn(id, normalized),
      emitCreated: (id) => emitSessionsChanged('created', id),
    });
  });
  ipcMain.handle('sessions:reviseBeforeTurn', async (_event, sessionId: string, input: unknown) => {
    return handleReviseBeforeTurn(sessionId, input, {
      ensureSessionWorkspaceAvailable,
      reviseBeforeTurn: (id, normalized) => runtime.reviseBeforeTurn(id, normalized),
      emitCreated: (id) => emitSessionsChanged('created', id),
    });
  });
  ipcMain.handle('sessions:archive', async (_event, sessionId: string, options?: unknown) => {
    for (const id of await resolveSessionActionIds(runtime, sessionId, options)) {
      computerUseOverlay.clearForSession(id);
      computerUseTools.clearSession(id);
      await stopAgentGraph?.(id);
      await goalWiring.archiveSession(id, () => runtime.archive(id));
      invalidateSessionBindings?.(id);
      clearSkillHost?.(id);
      await releaseBrowserSession(id);
      automationManager.removeAllForSession(id);
      emitSessionsChanged('archived', id);
    }
  });
  ipcMain.handle('sessions:unarchive', async (_event, sessionId: string, options?: unknown) => {
    for (const id of await resolveSessionActionIds(runtime, sessionId, options)) {
      await goalWiring.unarchiveSession(id, () => runtime.unarchive(id));
      emitSessionsChanged('updated', id);
    }
  });
  ipcMain.handle('sessions:setFlagged', async (
    _event,
    sessionId: string,
    isFlagged: boolean,
    options?: unknown,
  ) => {
    for (const id of await resolveSessionActionIds(runtime, sessionId, options)) {
      await runtime.setFlagged(id, isFlagged);
      emitSessionsChanged('pinned', id);
    }
  });
  ipcMain.handle('sessions:rename', async (
    _event,
    sessionId: string,
    name: string,
    options?: unknown,
  ) => {
    for (const id of await resolveSessionActionIds(runtime, sessionId, options)) {
      await runtime.renameSession(id, name);
      emitSessionsChanged('renamed', id);
    }
  });
  ipcMain.handle('sessions:setPermissionMode', (_event, sessionId: string, mode: unknown) => {
    if (!isPermissionMode(mode)) {
      throw new Error(`Invalid permission mode: ${String(mode)}`);
    }
    return runtime.setPermissionMode(sessionId, mode).then((session) => {
      emitSessionsChanged('mode-change', sessionId);
      return session;
    });
  });
  ipcMain.handle('sessions:setCollaborationMode', (_event, sessionId: string, mode: unknown) => {
    if (!isCollaborationMode(mode)) {
      throw new Error(`Invalid collaboration mode: ${String(mode)}`);
    }
    return runtime.setCollaborationMode(sessionId, mode).then((session) => {
      emitSessionsChanged('mode-change', sessionId);
      return session;
    });
  });
  ipcMain.handle('sessions:setOrchestrationMode', (_event, sessionId: string, mode: unknown) => {
    if (!isOrchestrationMode(mode)) {
      throw new Error(`Invalid orchestration mode: ${String(mode)}`);
    }
    return runtime.setOrchestrationMode(sessionId, mode).then((session) => {
      emitSessionsChanged('mode-change', sessionId);
      return session;
    });
  });
  ipcMain.handle('plan-mode:getState', (_event, sessionId: string) =>
    runtime.getPlanState(sessionId));
  ipcMain.handle('plan-mode:requestRevision', async (_event, sessionId: string, proposalId: unknown) => {
    if (typeof proposalId !== 'string' || !proposalId) throw new Error('Invalid proposal id');
    const result = await runtime.requestPlanRevision(sessionId, proposalId);
    emitSessionsChanged('mode-change', sessionId);
    return result.state;
  });
  ipcMain.handle('plan-mode:abandon', async (
    _event,
    sessionId: string,
    proposalId: unknown,
  ) => {
    if (typeof proposalId !== 'string' || !proposalId) throw new Error('Invalid proposal id');
    const result = await runtime.abandonPlanProposal(sessionId, proposalId);
    emitSessionsChanged('mode-change', sessionId);
    return result.state;
  });
  ipcMain.handle('plan-mode:abandonExecution', async (
    _event,
    sessionId: string,
    executionId: unknown,
  ) => {
    if (typeof executionId !== 'string' || !executionId) throw new Error('Invalid execution id');
    const result = await runtime.cancelPlanExecution(sessionId, executionId);
    emitSessionsChanged('mode-change', sessionId);
    return result.state;
  });
  ipcMain.handle('sessions:setModel', async (_event, sessionId: string, input: unknown) => {
    const { llmConnectionSlug, model } = normalizeSessionModelSelection(input);
    const header = await store.readHeader(sessionId);
    if (header.status === 'running') {
      throw new Error('当前对话正在运行，等结束后再切换模型。');
    }
    if (header.status === 'waiting_for_user') {
      throw new Error('当前有工具调用正在等待确认，处理后再切换模型。');
    }
    const ready = await getReadyConnection(llmConnectionSlug, model);
    const next = await runtime.updateSession(sessionId, {
      backend: 'ai-sdk',
      llmConnectionSlug: ready.connection.slug,
      model: ready.model,
      // Switching model clears the per-model thinking variant (see model-thinking.ts).
      thinkingLevel: undefined,
      connectionLocked: true,
      status: 'active',
      blockedReason: undefined,
      statusUpdatedAt: Date.now(),
    });
    emitSessionsChanged('updated', sessionId, {
      connectionSlug: ready.connection.slug,
      modelId: ready.model,
    });
    return next;
  });
  ipcMain.handle('sessions:setThinkingLevel', async (_event, sessionId: string, input: unknown) => {
    const header = await store.readHeader(sessionId);
    if (header.status === 'running') {
      throw new Error('当前对话正在运行，等结束后再切换思考级别。');
    }
    if (header.status === 'waiting_for_user') {
      throw new Error('当前有工具调用正在等待确认，处理后再切换思考级别。');
    }
    const connection = await connectionStore.get(header.llmConnectionSlug);
    if (!connection) {
      throw new Error(`Unknown connection: ${header.llmConnectionSlug}`);
    }
    const nextThinkingLevel = normalizeSupportedSessionThinkingLevel(input, connection.providerType, header.model);
    const next = await runtime.updateSession(sessionId, nextThinkingLevel === undefined ? { thinkingLevel: undefined } : { thinkingLevel: nextThinkingLevel });
    emitSessionsChanged('updated', sessionId);
    return next;
  });
  ipcMain.handle('sessions:remove', async (_event, sessionId: string, options?: unknown) => {
    for (const id of await resolveSessionActionIds(runtime, sessionId, options)) {
      computerUseOverlay.clearForSession(id);
      computerUseTools.clearSession(id);
      await goalWiring.removeSession(id, () => runtime.remove(id));
      invalidateSessionBindings?.(id);
      clearSkillHost?.(id);
      await releaseBrowserSession(id);
      automationManager.removeAllForSession(id);
      emitSessionsChanged('deleted', id);
    }
  });
}

/**
 * Apply an e2e-fixture boundary expansion through the real storage authority.
 *
 * The fixture's pending request is a synthetic event with no runtime turn
 * behind it, so it cannot be settled the normal way. Creating and settling a
 * genuine request with the same expansion keeps the boundary — which every
 * permission surface reads — honest about what the user just granted, instead
 * of leaving "allow" as a no-op the UI can silently contradict.
 */
async function applyFixtureSandboxBoundaryExpansion(
  store: SessionStore,
  sessionId: string,
  expansion: SandboxBoundaryExpansion,
): Promise<void> {
  const created = await store.createSandboxBoundaryRequest?.({
    sessionId,
    requestId: randomUUID(),
    // Provenance is required so a real producer cannot drop it (#1612). This
    // request has no turn to point at, so it names itself rather than
    // borrowing an id that restart recovery could later attribute a closure to.
    turnId: 'e2e-fixture-expansion',
    expansion,
    justification: 'e2e fixture expansion',
  });
  if (!created) return;
  await store.settleSandboxBoundaryRequest?.({
    sessionId,
    requestId: created.requestId,
    decision: 'allow',
  });
}
