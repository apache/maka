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
import { basename } from 'node:path';
import {
  Key,
  ProcessTerminal,
  SelectList,
  TUI,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  type Component,
  type OverlayHandle,
  type SelectItem,
  type Terminal,
} from '@earendil-works/pi-tui';
import type { PermissionMode } from '@maka/core/permission';
import {
  isThinkingLevel,
  thinkingVariantsForModel,
  type ThinkingLevel,
} from '@maka/core/model-thinking';
import { type ModelInfo, type ProviderType } from '@maka/core/llm-connections';
import type { OrchestrationMode } from '@maka/core/orchestration';
import type { SkillInvocationResult } from '@maka/core/skill-invocation';
import { projectRevisionLinkedSessionTree } from '@maka/core/session-revisions';
import {
  slashCommandsForSurface,
  type SlashCommandIdForSurface,
} from '@maka/core/slash-command-catalog';
import { type QueueEnqueueOutcome, type ShellRunUpdate } from '@maka/core/events';
import {
  deriveModelSwitchTranscript,
  type SessionSummary,
  type StoredMessage,
} from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  buildForeignSessionHandoffMessage,
  foreignSessionHandoffDisplayText,
  foreignSourceLabel,
  type ForeignSessionSummary,
} from '@maka/core/foreign-session';
import type { ContextDiagnostics } from '@maka/runtime/context-diagnostics';
import type { GoalTurnOutcome } from '@maka/runtime/goal-continuation';
import type { SessionActivityLease } from '@maka/runtime/goal-turn-lifecycle';
import { listApiKeyOnboardableProviders } from './onboarding-catalog.js';
import type {
  MakaForeignSessionReader,
  MakaOnboardingSurface,
  MakaPiTuiTurnActivitySurface,
  ModelChoice,
  OnboardingProviderEntry,
  SessionRecapGenerator,
} from './pi-tui-contracts.js';
import { AUTO_RECAP_DISPLAY_LIMIT_BYTES, shouldAutoRecap } from './session-recap.js';
import type { InvocableSkillEntry } from '@maka/runtime/skill-invocation';
import type { AgentGraphClientSnapshot, AgentGraphEpochSummary } from '@maka/runtime-host/protocol';
import type { AgentGraphEpochDirectory } from '@maka/runtime-host/client';
import { MakaSkillHighlightEditor } from './skill-highlight-editor.js';
import { parseGraphCommand, type ParsedGraphCommand } from '@maka/core/graph-command';
import { parseSwarmCommand, type ParsedSwarmCommand } from '@maka/core/swarm-command';
import {
  inspectSessionResumeAvailability,
  type MakaAttachedSessionTurn,
  type MakaPreparedSessionTurn,
  type MakaSessionDriver,
  type MakaSessionSwitchResult,
} from './session-driver.js';
import {
  appendTurnFailureToTranscript,
  appendUserPrompt,
  applyMakaSessionEventToTranscript,
  createMakaPiTranscriptState,
  activeSandboxBoundaryRequest,
  activeUserQuestionRequest,
  completePendingInteraction,
  applyShellRunViewUpdateToTranscript,
  permissionModeLabel,
  replaceTranscriptWithStoredMessages,
  reconcileToolsWithStoredMessages,
  submitCompactToTranscript,
  toggleAllThinkingExpansion,
  toggleAllToolExpansion,
  type MakaPiTranscriptMetadata,
} from './pi-transcript.js';
import { runMakaPiTuiTurn, type MakaPiTuiTurnRequest } from './pi-tui-turn.js';
import { editorTheme, selectListTheme } from './tui-ansi.js';
import { MakaAutocompleteAboveEditorComponent } from './tui-autocomplete-layout.js';
import { TranscriptViewerOverlay } from './pi-tui-transcript-viewer.js';
import { createShellRunElapsedTicker } from './shell-run-elapsed-ticker.js';
import { createShellRunHydrationController } from './shell-run-hydration.js';
import { sessionStatusBadge } from './tui-session-status.js';
import {
  AttentionController,
  DISABLE_FOCUS_REPORTING,
  ENABLE_FOCUS_REPORTING,
  FOCUS_IN_SEQUENCE,
  FOCUS_OUT_SEQUENCE,
} from './tui-attention.js';
import {
  MakaActivityStripComponent,
  MakaPendingQueueComponent,
  MakaPiLayoutComponent,
  MakaStatusLineComponent,
  MakaTranscriptComponent,
} from './pi-tui-layout.js';
import {
  MakaAutocompleteProvider,
  DirectoryPickerOverlay,
  MODEL_SWITCH_CACHE_WARNING,
  ModelSearchOverlay,
  OnboardingWizard,
  PickerOverlay,
  UserQuestionOverlay,
  modelPickerItems,
  permissionModePickerItems,
  skillPickerItems,
  thinkingLevelPickerItems,
  type MakaSlashCommand,
} from './pi-tui-pickers.js';
import { formatMakaResumeCommand } from './cli-invocation.js';
import {
  goalAttachedNoticeText,
  goalPausedNoticeText,
  goalStatusLabel,
  goalSummaryLines,
  isLiveGoalStatus,
} from './pi-goal.js';
import { getTuiPrimaryGuidance } from './tui-primary-guidance.js';
import type { GoalControlAction, GoalProjection } from '@maka/runtime-host/protocol';

export interface MakaPiTuiInput {
  /** Launcher command used in resume and recovery instructions. */
  cliCommand?: string;
  title: string;
  /** Resolved locale for human-facing TUI guidance. Direct embeddings default to English. */
  locale?: UiLocale;
  driver: MakaSessionDriver;
  cwd: string;
  model: string;
  models?: readonly string[];
  /**
   * Every selectable model across all ready connections. When present, `/model`
   * lists these (grouped by connection) and selecting one rebinds the session to
   * that connection + model. Falls back to `models` (current connection only)
   * when absent.
   */
  modelChoices?: readonly ModelChoice[];
  connectionSlug: string;
  providerType?: ProviderType;
  permissionMode: PermissionMode;
  /** Maximum context tokens for the active model, for the statusline ctx segment. */
  modelContextWindow?: number;
  terminal?: Terminal;
  /**
   * Whether turns and control actions publish terminal taskbar progress.
   * Defaults off on native Windows and Windows Terminal sessions because its
   * OSC 9;4 keepalive can make Explorer's taskbar unresponsive. Injectable so
   * tests cross the same policy seam without depending on their host platform.
   */
  taskbarProgress?: boolean;
  /** Starts the CLI process-exit deadline after terminal restore, before outer cleanup. */
  onProcessExit?: (exitCode: number, error?: Error) => void;
  /**
   * How long a prompt turn must run before its completion rings the terminal
   * BEL when unfocused. Injectable so tests exercise the long / short split
   * without waiting real seconds; defaults to the attention layer's own value.
   */
  attentionLongTurnThresholdMs?: number;
  /**
   * Clock + interval scheduling for the running shell-run elapsed ticker
   * (1s cadence). Injectable so tests drive ticks deterministically instead
   * of waiting wall-clock seconds; defaults to Date.now + a real unref'd
   * setInterval.
   */
  shellRunTicker?: {
    now?: () => number;
    schedule?: (callback: () => void, intervalMs: number) => () => void;
  };
  subscribeSessionTitleChanges?: (listener: (sessionId: string) => void) => () => void;
  subscribeShellRunUpdates?: (listener: (update: ShellRunUpdate) => void) => () => void;
  listShellRunUpdates?: (sessionId: string) => Promise<ShellRunUpdate[]>;
  /** Host-owned invocable Skill catalog used for picker, completion, and token highlighting. */
  listSkills?: (cwd: string) => Promise<readonly InvocableSkillEntry[]>;
  /** Read-only Runtime Host projection for inspecting current and historical Graph epochs. */
  agentGraphHistory?: {
    listEpochs(rootSessionId: string): Promise<AgentGraphEpochDirectory>;
    getSnapshot(rootSessionId: string, graphId: string): Promise<AgentGraphClientSnapshot>;
  };
  /** Serializes TUI turn and control activity for the attached Session. */
  turnActivity: MakaPiTuiTurnActivitySurface;
  /** API-key onboarding surface (#1098). When present, /setup runs the wizard,
   *  whose listProviders/verify/save calls persist the connection + curated models
   *  via the host-owned stores. */
  onboarding?: MakaOnboardingSurface;
  /** First-run mode: auto-open the onboarding wizard on launch instead of
   *  waiting for /setup (used when the CLI starts with no configured connection). */
  firstRun?: boolean;
  /**
   * One-sentence session recap generator (issue #1055). Powers `/recap` and
   * the idle-return auto-recap. Omitting it disables both — `/recap` reports
   * unavailability and no auto-recap is ever scheduled.
   */
  recap?: SessionRecapGenerator;
  /**
   * When present, the runner switches onto this session as its first action
   * (before entering the interactive loop), reusing the same `switchSession`
   * path as `/session <id>`. A failed switch (missing session, stale cwd)
   * surfaces as a transcript notice and the runner falls back to the fresh
   * session the driver was created with.
   */
  resumeSessionId?: string;
  /**
   * Explicit replacement cwd used only while attaching `resumeSessionId`.
   * The Session driver owns validation and durable relocation.
   */
  resumeCwd?: string;
  /** Whether a failed startup resume may continue with a fresh Session. */
  resumeFailure?: 'start_fresh' | 'exit';
  /**
   * Read-only store of sessions from other coding agents (Claude Code,
   * Codex). When present, the session picker lists foreign sessions for the
   * current cwd; selecting one distills it into a handoff digest and opens a
   * fresh Maka session seeded with it. Omitting it hides the feature.
   */
  foreignSessions?: MakaForeignSessionReader;
  /** Initial Session picker scope when Session paths are not Client-local. */
  sessionListScope?: 'current' | 'all';
  /** Whether editor path completion may inspect the Client filesystem. */
  clientPathAuthority?: 'local' | 'none';
}

interface TaskbarProgressEnvironment {
  readonly platform: NodeJS.Platform;
  readonly override?: string;
  readonly windowsTerminalSession?: string;
}

export function resolveTaskbarProgress(
  setting: boolean | undefined,
  environment: TaskbarProgressEnvironment = {
    platform: process.platform,
    override: process.env.MAKA_TASKBAR_PROGRESS,
    windowsTerminalSession: process.env.WT_SESSION,
  },
): boolean {
  if (setting !== undefined) return setting;
  const forced = environment.override?.trim().toLowerCase();
  if (forced === '1' || forced === 'true') return true;
  if (forced === '0' || forced === 'false') return false;
  return environment.platform !== 'win32' && environment.windowsTerminalSession === undefined;
}

export async function runMakaPiTui(input: MakaPiTuiInput): Promise<void> {
  const locale = input.locale ?? 'en';
  const primaryGuidance = getTuiPrimaryGuidance(locale);
  const terminal = input.terminal ?? new ProcessTerminal();
  const taskbarProgress = resolveTaskbarProgress(input.taskbarProgress);
  const setTaskbarProgress = (active: boolean): void => {
    if (taskbarProgress) terminal.setProgress(active);
  };
  const tui = new TUI(terminal);
  const state = createMakaPiTranscriptState();
  let transcriptMessages: readonly StoredMessage[] = [];
  const replaceTranscript = (messages: readonly StoredMessage[]): void => {
    transcriptMessages = messages;
    replaceTranscriptWithStoredMessages(state, messages);
  };
  let cwd = input.cwd;
  let model = input.model;
  let connectionSlug = input.connectionSlug;
  // Mutable: a cross-connection /model switch rebinds the provider, which changes
  // both the connection and the thinking variants the new model supports.
  let providerType = input.providerType;
  let modelContextWindow = input.modelContextWindow;
  let permissionMode = input.permissionMode;
  let orchestrationMode = input.driver.getOrchestrationMode?.() ?? 'default';
  let thinkingLevel: ThinkingLevel | undefined = undefined;
  // The boot connection's declared capabilities win (an openai-compatible
  // relay can declare relayModelProfiles[model].thinkingLevels). The
  // providerType+model metadata variant is the fallback for modelChoices-free
  // embeddings of the runner.
  let thinkingLevels: readonly ThinkingLevel[] =
    input.modelChoices?.find(
      (choice) => choice.connectionSlug === connectionSlug && choice.model === model,
    )?.thinkingLevels ?? (providerType ? thinkingVariantsForModel(providerType, model) : []);
  let sessionListScope: 'current' | 'all' = input.sessionListScope ?? 'current';
  let busy = false;
  let closed = false;
  let currentActivityCompletion: Promise<void> | undefined;
  let permissionResponseInFlightRequestId: string | null = null;
  // Session recap (issue #1055): an in-flight lock shared by manual and
  // automatic recap calls, an activity clock for idle-return detection, a
  // watermark so auto-recap fires at most once per newly reached main turn,
  // and a sequence counter bumped once per submitted prompt so an idle recap
  // can detect it was superseded by a later prompt while it was generating.
  let recapInFlight = false;
  let lastActivityAt = Date.now();
  // Session-scoped watermark: null (or a stale sessionId) is equivalent to a
  // fresh session that has never had a recap (count 0). Prevents a recap
  // triggered in session A from suppressing the first eligible recap in a
  // later session B that happens to reach the same main-turn count.
  let recapWatermark: { sessionId: string; mainTurnCount: number } | null = null;
  let promptSeq = 0;
  const beginActivity = () => {
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    currentActivityCompletion = completion;
    let finished = false;
    return {
      finish: () => {
        if (finished) return;
        finished = true;
        if (currentActivityCompletion === completion) currentActivityCompletion = undefined;
        finish();
      },
    };
  };
  let userQuestionInFlight = false;
  let userQuestionOverlay: OverlayHandle | undefined;
  let userQuestionProgress:
    | {
        requestId: string;
        index: number;
        answers: Array<string | null>;
      }
    | undefined;
  let turnRunning = false;
  // Monotonic generation for visible agent turns. A mid-turn `/session`
  // switch-away (#3380) bumps it to orphan the in-flight drain: every callback
  // of that runAgentTurn (events, failures, queue flushes) captured the epoch
  // at start and becomes a no-op once superseded, so nothing from the
  // abandoned Session reaches the adopted one's transcript.
  let turnEpoch = 0;
  let turnStartedAt: number | undefined;
  let interruptRequested = false;
  // True while a mid-turn detach-switch is in flight: an interrupt issued in
  // that window would target the freshly attached Session instead of the Turn
  // being left behind.
  let detaching = false;
  // True while the /session picker is open mid-turn: Escape must close the
  // overlay, not arm the double-Escape interrupt for the running Turn (#3380).
  let sessionPickerOverlayOpen = false;
  let lastTurnEscapeAt = 0;
  let lastIdleEscapeAt = 0;
  let lastIdleCtrlCAt = 0;
  // Mirrors the editor's bracketed-paste buffering at the input seam: between a
  // paste start marker and its end marker the editor holds incoming bytes in an
  // internal buffer and getText() stays empty, so "editor is empty" must not
  // treat that in-flight paste as absent user input (#3475 review). The marker
  // matching deliberately mirrors the editor's own per-chunk includes() checks,
  // so this flag agrees with what the editor will buffer.
  let editorPastePending = false;
  type AttachedTurnContext =
    | { readonly kind: 'adopted'; readonly turn: MakaPreparedSessionTurn }
    | { readonly kind: 'external'; readonly turn: MakaAttachedSessionTurn };
  let pendingAttachedTurn: AttachedTurnContext | undefined;
  const resolvedInteractionIds = new Set<string>();
  let startAttachedTurn: ((attached: AttachedTurnContext) => void) | undefined;
  const startPendingAttachedTurn = () => {
    if (busy || turnRunning) return;
    const attached = pendingAttachedTurn;
    pendingAttachedTurn = undefined;
    if (attached) startAttachedTurn?.(attached);
  };
  let resolveClosed: () => void;
  let rejectClosed: (error: Error) => void;
  const closedPromise = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });

  // Rendering reads the driver's live projection directly (metadata()); this
  // cache exists only to detect transitions on the push stream — notably the
  // abort auto-pause — and to suppress the notice for a pause we initiated.
  let currentGoal: GoalProjection | null = input.driver.getGoal?.() ?? null;
  // goalId of a `/goal pause` we initiated: its paused projection must not
  // re-announce itself — the command prints its own confirmation.
  let selfInitiatedPauseGoalId: string | null = null;
  const unsubscribeGoalChanges = input.driver.subscribeGoalChanges?.((goal) => {
    const previous = currentGoal;
    currentGoal = goal;
    if (
      goal !== null &&
      goal.status === 'paused' &&
      previous?.goalId === goal.goalId &&
      previous.status !== 'paused'
    ) {
      if (selfInitiatedPauseGoalId === goal.goalId) {
        selfInitiatedPauseGoalId = null;
      } else {
        // Typically the runtime's abort auto-pause (Ctrl+C on a goal
        // continuation turn): the loop still exists and can be resumed.
        state.entries.push({
          kind: 'notice',
          level: 'info',
          text: goalPausedNoticeText(goal),
        });
      }
    }
    requestRender();
  });
  // Attaching to a session whose durable goal auto-continues after recovery
  // must never resume a token-burning loop silently. This covers a driver
  // that is already attached at startup; a resumeSessionId attach happens
  // later, so switchSession repeats the check after adopting the session.
  if (
    currentGoal !== null &&
    (currentGoal.status === 'active' || currentGoal.status === 'waiting')
  ) {
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: goalAttachedNoticeText(currentGoal),
    });
  }

  const metadata = (): MakaPiTranscriptMetadata => ({
    title: input.title,
    cwd,
    model,
    connectionSlug,
    permissionMode,
    orchestrationMode,
    thinkingLevel,
    thinkingLevels,
    sessionId: input.driver.getSessionId(),
    busy,
    usage: state.usage,
    modelContextWindow,
    turnElapsedMs: turnStartedAt !== undefined ? Date.now() - turnStartedAt : undefined,
    providerRetry: state.providerRetry,
    uiLocale: locale,
    goal: input.driver.getGoal?.() ?? null,
  });

  const transcript = new MakaTranscriptComponent(state, metadata);
  const activityStrip = new MakaActivityStripComponent(metadata);
  const pendingQueue = new MakaPendingQueueComponent(state);
  const statusLine = new MakaStatusLineComponent(metadata);
  // Show the whole slash-command set at once — discoverability is the point of
  // the menu. Keep a little headroom above the current command count.
  const editor = new MakaSkillHighlightEditor(tui, editorTheme(), {
    paddingX: 0,
    autocompleteMaxVisible: EDITOR_AUTOCOMPLETE_MAX_VISIBLE,
  });
  let refreshEditorCwd: ((cwd: string) => void) | undefined;
  const editorSurface = new MakaAutocompleteAboveEditorComponent(editor);
  const layout = new MakaPiLayoutComponent(
    state,
    transcript,
    activityStrip,
    pendingQueue,
    editorSurface,
    statusLine,
    terminal,
  );
  const attention = new AttentionController(terminal, {
    baseTitle: input.title,
    ...(input.attentionLongTurnThresholdMs !== undefined
      ? { longTurnThresholdMs: input.attentionLongTurnThresholdMs }
      : {}),
  });
  let sessionTitleVersion = 0;
  const setSessionTitle = (title: string) => {
    sessionTitleVersion += 1;
    attention.setBaseTitle(`${title} (${input.title})`);
  };

  const requestRender = () => {
    transcript.invalidate();
    tui.requestRender();
  };
  const unsubscribeSessionTitleChanges =
    input.subscribeSessionTitleChanges?.((sessionId) => {
      const refreshVersion = ++sessionTitleVersion;
      void input.driver
        .listSessions()
        .then((sessions) => {
          if (
            closed ||
            input.driver.getSessionId() !== sessionId ||
            sessionTitleVersion !== refreshVersion
          )
            return;
          const session = sessions.find((candidate) => candidate.id === sessionId);
          if (!session) return;
          setSessionTitle(session.name);
        })
        .catch(() => {});
    }) ?? (() => {});
  const unsubscribeStartedTurns =
    input.driver.subscribeStartedTurns?.((turn) => {
      if (closed) return;
      const attached = { kind: 'external', turn } as const;
      if (busy || turnRunning || !startAttachedTurn) pendingAttachedTurn = attached;
      else startAttachedTurn(attached);
    }) ?? (() => {});
  const unsubscribeResolvedInteractions =
    input.driver.subscribeResolvedInteractions?.((sessionId, requestId) => {
      if (closed || input.driver.getSessionId() !== sessionId) return;
      if (!completePendingInteraction(state, requestId)) {
        resolvedInteractionIds.add(requestId);
        return;
      }
      permissionResponseInFlightRequestId = null;
      syncUserQuestionOverlay();
      requestRender();
    }) ?? (() => {});
  const unsubscribeTranscriptReplacements =
    input.driver.subscribeTranscriptReplacements?.((sessionId, turnId, messages, reason) => {
      if (closed || input.driver.getSessionId() !== sessionId) return;
      if (reason === 'reconnect') {
        replaceTranscript(messages);
        shellRunElapsedTicker.sync();
        requestRender();
        return;
      }
      transcriptMessages = messages;
      if (reconcileToolsWithStoredMessages(state, turnId, messages)) {
        shellRunElapsedTicker.sync();
        requestRender();
      }
    }) ?? (() => {});
  const shellRunElapsedTicker = createShellRunElapsedTicker({
    state,
    onTick: requestRender,
    now: input.shellRunTicker?.now,
    schedule: input.shellRunTicker?.schedule,
  });

  // ── Explicit skill invocation (#1148) ────────────────────────────────────
  // One cached list feeds autocomplete, the `/skill` picker, and the editor's
  // sync highlight validator. The cache is keyed by cwd (project-level skill
  // paths move with it) and short-lived; submit-time injection never uses it —
  // it does an authoritative scan via prepareSkillInvocation.
  const SKILL_LIST_CACHE_MS = 5_000;
  let skillListCache: { cacheCwd: string; at: number; entries: InvocableSkillEntry[] } | undefined;
  const listSkillsCached = async (
    forceRefresh = false,
  ): Promise<readonly InvocableSkillEntry[]> => {
    if (!input.listSkills) return [];
    if (
      !forceRefresh &&
      skillListCache &&
      skillListCache.cacheCwd === cwd &&
      Date.now() - skillListCache.at < SKILL_LIST_CACHE_MS
    ) {
      return skillListCache.entries;
    }
    try {
      const entries = [...(await input.listSkills(cwd))];
      skillListCache = { cacheCwd: cwd, at: Date.now(), entries };
      // The highlight validator must be sync and cheap (one lookup per token
      // per render): a flat Set over lowercase ids AND display names, since a
      // token resolves by either.
      const invocable = new Set<string>();
      for (const entry of entries) {
        invocable.add(entry.id.toLowerCase());
        invocable.add(entry.name.toLowerCase());
      }
      editor.setSkillTokenValidator((name) => invocable.has(name.toLowerCase()));
      requestRender();
      return entries;
    } catch {
      // Listing is best-effort: autocomplete/picker/highlight degrade to
      // nothing, and submit-time resolution does its own authoritative scan.
      return skillListCache?.cacheCwd === cwd ? skillListCache.entries : [];
    }
  };
  // Warm the highlight validator so tokens light up before the first
  // autocomplete or picker open.
  void listSkillsCached(true);

  const SKILL_INVOCATION_FAILURE_REASON_LABEL: Record<string, string> = {
    not_found: '未找到',
    disabled: '已禁用',
    host_incompatible: '当前主机缺少其依赖的工具',
    invalid_name: '名称无效',
    too_many_requests: '调用请求过多',
  };

  const showSkillInvocation = (skillInvocation: SkillInvocationResult): void => {
    const failed = skillInvocation.failed;
    const failedLabels = failed.map((entry) =>
      entry.reason === 'too_many_requests'
        ? `请求超过 ${entry.requestLimit} 个上限（${SKILL_INVOCATION_FAILURE_REASON_LABEL[entry.reason]}）`
        : `/skill:${entry.request}（${SKILL_INVOCATION_FAILURE_REASON_LABEL[entry.reason] ?? entry.reason}）`,
    );
    if (failed.length > 0) {
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: `未能加载技能 ${failedLabels.join('、')}；${
          skillInvocation.loaded.length === 0 ? '未发起模型请求。' : '失败的调用标记未发送给模型。'
        }`,
      });
    }
    if (skillInvocation.loaded.length > 0) {
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: `已加载技能：${skillInvocation.loaded.map((skill) => skill.name).join('、')}`,
      });
    }
    requestRender();
  };

  // 1-second heartbeat that re-renders the activity strip's elapsed counter
  // while a turn runs. Stopped on turn end and disposed on teardown.
  let turnElapsedInterval: ReturnType<typeof setInterval> | undefined;
  const startTurnElapsedTicker = () => {
    if (turnElapsedInterval) return;
    turnElapsedInterval = setInterval(() => requestRender(), 1_000);
    turnElapsedInterval.unref();
  };
  const stopTurnElapsedTicker = () => {
    if (turnElapsedInterval) {
      clearInterval(turnElapsedInterval);
      turnElapsedInterval = undefined;
    }
  };
  const shellRunHydration = createShellRunHydrationController({
    driver: input.driver,
    applyToTranscript: (update, options) =>
      applyShellRunViewUpdateToTranscript(state, update, options),
    listShellRunUpdates: input.listShellRunUpdates,
    subscribeShellRunUpdates: input.subscribeShellRunUpdates,
    onViewChanged: () => {
      shellRunElapsedTicker.sync();
      requestRender();
    },
    isClosed: () => closed,
  });

  const reportError = (error: unknown) => {
    state.entries.push({
      kind: 'notice',
      level: 'error',
      text: error instanceof Error ? error.message : String(error),
    });
    // An error is worth pulling the user back to a background tab.
    attention.attentionNeeded();
    requestRender();
  };

  // Control commands (model/session/permission switches) mutate session state.
  // Run them through a single serial lock so a prompt submitted mid-switch can
  // not race the switch and land on the old session/model/permission mode.
  const runControl = async (action: () => Promise<void>): Promise<void> => {
    // Refuse nested control actions: an overlay onSelect bypasses editor.onSubmit,
    // so without this guard a switch could start while a prompt is still running.
    if (busy) return;
    busy = true;
    const activity = beginActivity();
    editor.disableSubmit = true;
    setTaskbarProgress(true);
    attention.controlStarted();
    requestRender();
    let sessionActivity: SessionActivityLease | undefined;
    try {
      const sessionId = input.driver.getSessionId();
      if (sessionId) sessionActivity = await input.turnActivity.activities.acquire(sessionId);
      if (closed) return;
      await action();
    } catch (error) {
      reportError(error);
    } finally {
      sessionActivity?.release();
      busy = false;
      activity.finish();
      editor.disableSubmit = false;
      setTaskbarProgress(false);
      attention.controlEnded();
      requestRender();
      startPendingAttachedTurn();
    }
  };

  const removeProcessHandlers = () => {
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
    process.off('SIGHUP', handleSighup);
    process.off('uncaughtException', handleUncaughtException);
    process.off('unhandledRejection', handleUnhandledRejection);
  };

  const restoreTerminal = () => {
    removeProcessHandlers();
    unsubscribeSessionTitleChanges();
    unsubscribeGoalChanges?.();
    unsubscribeStartedTurns();
    unsubscribeResolvedInteractions();
    unsubscribeTranscriptReplacements();
    shellRunHydration.dispose();
    shellRunElapsedTicker.dispose();
    stopTurnElapsedTicker();
    stopFallbackRetry();
    setTaskbarProgress(false);
    // Drop the busy / attention title marker so the tab is not handed back to
    // the shell still marked busy when the session exits.
    attention.reset();
    // Stop asking the terminal for focus reports before handing it back.
    terminal.write(DISABLE_FOCUS_REPORTING);
    tui.stop();
  };

  const beginClose = (error?: Error) => {
    if (closed) return;
    closed = true;
    restoreTerminal();
    if (error) rejectClosed(error);
    else resolveClosed();
    // Runtime stop is best-effort after the shell has its terminal back. A
    // double-Escape/Ctrl-C interrupt may already have one in flight; reuse it.
    if (!interruptRequested) void input.driver.stop().catch(() => {});
  };

  const handleProcessExit = (exitCode: number, error?: Error): void => {
    process.exitCode = exitCode;
    beginClose(input.onProcessExit ? undefined : error);
    input.onProcessExit?.(exitCode, error);
  };

  const beginGracefulClose = () => beginClose();

  function handleSigint(): void {
    handleProcessExit(128 + 2);
  }

  function handleSigterm(): void {
    handleProcessExit(128 + 15);
  }

  function handleSighup(): void {
    handleProcessExit(128 + 1);
  }

  function handleUncaughtException(error: Error): void {
    handleProcessExit(1, error);
  }

  function handleUnhandledRejection(reason: unknown): void {
    handleProcessExit(1, reason instanceof Error ? reason : new Error(String(reason)));
  }

  process.once('SIGINT', handleSigint);
  process.once('SIGTERM', handleSigterm);
  process.once('SIGHUP', handleSighup);
  process.once('uncaughtException', handleUncaughtException);
  process.once('unhandledRejection', handleUnhandledRejection);

  const respondToPendingSandboxBoundary = (decision: 'allow' | 'deny'): boolean => {
    const request = activeSandboxBoundaryRequest(state);
    if (!request || permissionResponseInFlightRequestId !== null) return false;
    permissionResponseInFlightRequestId = request.requestId;
    // Keep the prompt visible until the driver accepts the response. If it
    // rejects, the user can retry with y/n instead of being stuck. A resolved
    // call only means the response was submitted; the event stream owns dequeue.
    void input.driver
      .respondToSandboxBoundary({
        requestId: request.requestId,
        decision,
      })
      .catch((error) => {
        if (permissionResponseInFlightRequestId === request.requestId) {
          permissionResponseInFlightRequestId = null;
        }
        reportError(error);
      });
    return true;
  };

  // Refill the editor from a retract result, prepended to any current draft.
  // Shared by the interrupt path and the alt+↑ path. The text always comes
  // from `driver.retractQueued()` — an authoritative queue mutation — never
  // from the render mirror, which can
  // lag a step-boundary consumption and would resurrect an already-consumed
  // steering message for a double execution. Clears the local mirror.
  const refillEditorFromQueues = (joined: string) => {
    state.steering = [];
    state.followup = [];
    if (!joined) return;
    const draft = editor.getText();
    editor.setText(draft ? `${joined}\n\n${draft}` : joined);
  };

  const pendingEnqueueTasks = new Set<Promise<void>>();
  const trackEnqueue = (task: Promise<void>): void => {
    pendingEnqueueTasks.add(task);
    void task.finally(() => pendingEnqueueTasks.delete(task));
  };
  const settlePendingEnqueues = async (): Promise<void> => {
    while (pendingEnqueueTasks.size > 0) {
      await Promise.allSettled([...pendingEnqueueTasks]);
    }
  };

  const requestTurnInterrupt = () => {
    // A detach in flight is not the running Turn's owner acting on it — the
    // driver already points at the next Session, so a stop here would abort
    // whatever that Session has attached. Swallow until the handoff settles.
    if (interruptRequested || detaching) return;
    interruptRequested = true;
    // The convergence window (stop issued, turn not yet terminal) accepts no
    // new input: submits would race the abort and could open work the user
    // just cancelled. The normal turn finally restores submit; a rejected
    // stop restores it here.
    editor.disableSubmit = true;
    requestRender();
    // The authority retracts before stop: only messages still queued come back
    // for re-editing, while anything already consumed stays in the transcript.
    // Serializing these operations also preserves that ordering over a Host
    // connection where both calls are asynchronous.
    void (async () => {
      await settlePendingEnqueues();
      const retracted = (await input.driver.retractQueued?.()) ?? '';
      const fallback = await takePendingFallbackSettled();
      refillEditorFromQueues([fallback, retracted].filter(Boolean).join('\n\n'));
      requestRender();
      await input.driver.stop();
    })().catch((error) => {
      interruptRequested = false;
      editor.disableSubmit = false;
      reportError(error);
    });
  };

  // Open a fresh turn from a submitted prompt (idle path). Control actions hold
  // `busy`, so a prompt typed mid-switch is ignored rather than racing it.
  const submitPrompt = (prompt: string) => {
    if (busy || !prompt.trim()) {
      requestRender();
      return;
    }
    if (isExitPrompt(prompt)) {
      beginGracefulClose();
      return;
    }
    // Captured BEFORE lastActivityAt is refreshed, so the idle gap measures up
    // to (not including) this very submission.
    const idleMs = Date.now() - lastActivityAt;
    editor.addToHistory(prompt);
    if (handleSlashCommand(prompt, idleMs)) return;
    // First-run has no connection, so the wizard is the only surface. This is
    // the single choke point for idle submits (Enter, Alt+Enter, steer
    // fallback): reopen the wizard instead of opening a turn against a
    // connection-less driver. Slash commands above already routed to the
    // command layer (/exit still exits, /help still shows help).
    if (input.firstRun) {
      void showSetupWizard();
      return;
    }
    // Refreshed only for a prompt that actually opens a turn: a slash command
    // (e.g. /help) typed on the way back from idle must not consume the idle
    // gap the next real prompt is measuring.
    lastActivityAt = Date.now();
    // This prompt is about to open a turn, so it counts toward the sequence
    // an in-flight idle recap is watching — including when this very prompt
    // is the idle-return submission that triggers the recap below.
    promptSeq += 1;
    maybeTriggerAutoRecap(idleMs);
    void runAgentTurn({
      kind: 'external',
      prompt,
      sessionId: input.driver.getSessionId(),
    });
  };

  // Fallback handoff owner. A `fallback` outcome while the turn is running
  // means the runtime has no live steering owner YET (the begin window) or
  // just lost it; the runtime keeps no record of the text, so the CLI owns
  // delivery: retry the SAME enqueue until the owner appears, and flush any
  // remainder into the next turn at the turn boundary. Never a bounded wait —
  // a normal turn outlives any fixed budget and the text must not vanish.
  const FALLBACK_RETRY_MS = 100;
  let fallbackRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackRetryInFlight = false;
  let fallbackRetryTask: Promise<void> | null = null;
  let fallbackRetryGeneration = 0;

  const stopFallbackRetry = () => {
    fallbackRetryGeneration += 1;
    if (fallbackRetryTimer !== null) clearTimeout(fallbackRetryTimer);
    fallbackRetryTimer = null;
  };

  const scheduleFallbackRetry = () => {
    if (fallbackRetryTimer !== null || fallbackRetryInFlight) return;
    fallbackRetryTimer = setTimeout(() => {
      fallbackRetryTimer = null;
      const task = retryPendingFallback();
      fallbackRetryTask = task;
      void task.finally(() => {
        if (fallbackRetryTask === task) fallbackRetryTask = null;
      });
    }, FALLBACK_RETRY_MS);
  };

  const retryPendingFallback = async () => {
    if (closed || !turnRunning || state.pendingFallback.length === 0) {
      stopFallbackRetry();
      return;
    }
    const generation = fallbackRetryGeneration;
    const attempted = [...state.pendingFallback];
    fallbackRetryInFlight = true;
    const remaining: typeof state.pendingFallback = [];
    let failed = false;
    try {
      for (const entry of attempted) {
        const enqueue = entry.enqueue === 'steer' ? input.driver.steer : input.driver.queueMessage;
        let outcome: QueueEnqueueOutcome | undefined;
        try {
          outcome = enqueue ? await enqueue.call(input.driver, entry.text) : undefined;
        } catch (error) {
          failed = true;
          reportError(error);
        }
        if (outcome?.kind !== 'queued') remaining.push(entry);
      }
    } finally {
      fallbackRetryInFlight = false;
    }
    if (generation !== fallbackRetryGeneration) return;
    const attemptedEntries = new Set(attempted);
    const appended = state.pendingFallback.filter((entry) => !attemptedEntries.has(entry));
    const changed = remaining.length !== attempted.length;
    state.pendingFallback = [...remaining, ...appended];
    if (remaining.length === 0) stopFallbackRetry();
    else if (!failed) scheduleFallbackRetry();
    if (!changed) return;
    // The queue mirror updates only from `queue_update` events (single path);
    // this render just drops the delivered entries from the fallback list.
    requestRender();
  };

  const deferFallback = (text: string, enqueue: 'steer' | 'queue') => {
    state.pendingFallback.push({ text, enqueue });
    scheduleFallbackRetry();
    requestRender();
  };

  /** Drain the CLI-held fallback texts (delivery order), stopping the retry loop. */
  const takePendingFallbackEntries = (): Array<{ text: string; enqueue: 'steer' | 'queue' }> => {
    stopFallbackRetry();
    const entries = state.pendingFallback;
    state.pendingFallback = [];
    return entries;
  };

  const takePendingFallbackEntriesSettled = async (): Promise<
    Array<{ text: string; enqueue: 'steer' | 'queue' }>
  > => {
    if (fallbackRetryTimer !== null) {
      clearTimeout(fallbackRetryTimer);
      fallbackRetryTimer = null;
    }
    await fallbackRetryTask;
    return takePendingFallbackEntries();
  };

  const takePendingFallbackSettled = async (): Promise<string> =>
    (await takePendingFallbackEntriesSettled()).map((entry) => entry.text).join('\n\n');

  // Enter during a turn steers it (inject at the next step boundary); the
  // runtime falls back to a fresh turn if the run already ended.
  const steerRunningTurn = (text: string) => {
    if (!text.trim()) {
      requestRender();
      return;
    }
    editor.addToHistory(text);
    const enqueue = input.driver.steer;
    if (!enqueue) {
      deferFallback(text, 'steer');
      return;
    }
    const task = enqueue
      .call(input.driver, text)
      .then((outcome) => {
        if (outcome.kind === 'fallback') {
          if (turnRunning || busy) deferFallback(text, 'steer');
          else submitPrompt(text);
          return;
        }
        // Queued: the runtime's `queue_update` event refreshes the mirror.
        requestRender();
      })
      .catch((error) => {
        refillEditorFromQueues(text);
        reportError(error);
      });
    trackEnqueue(task);
  };

  // Alt+Enter: during a turn, queue the text to open the next turn; when idle,
  // it submits like Enter.
  const handleAltEnter = () => {
    // Mirror Enter's control-busy guard BEFORE touching the editor: during a
    // control action (busy without a running turn) submitPrompt would drop the
    // prompt, so keep the draft in place instead of clearing it into the void.
    if (busy && !turnRunning) return;
    // Interrupt convergence window: the turn is being stopped, so nothing may
    // be queued onto it and no fresh turn may open — keep the draft.
    if (interruptRequested) return;
    const text = editor.getExpandedText().trim();
    if (!text) return;
    editor.setText('');
    if (!turnRunning) {
      submitPrompt(text);
      return;
    }
    editor.addToHistory(text);
    const enqueue = input.driver.queueMessage;
    if (!enqueue) {
      deferFallback(text, 'queue');
      return;
    }
    const task = enqueue
      .call(input.driver, text)
      .then((outcome) => {
        if (outcome.kind === 'fallback') {
          if (turnRunning || busy) deferFallback(text, 'queue');
          else submitPrompt(text);
          return;
        }
        // Queued: the runtime's `queue_update` event refreshes the mirror.
        requestRender();
      })
      .catch((error) => {
        refillEditorFromQueues(text);
        reportError(error);
      });
    trackEnqueue(task);
  };

  // Alt+↑: take back every queued message (both queues plus CLI-held fallback
  // texts), joined and prepended to the current draft for re-editing.
  const retractQueuedMessages = () => {
    void (async () => {
      await settlePendingEnqueues();
      const retracted = (await input.driver.retractQueued?.()) ?? '';
      const fallback = await takePendingFallbackSettled();
      refillEditorFromQueues([fallback, retracted].filter(Boolean).join('\n\n'));
      requestRender();
    })().catch(reportError);
  };

  // Onboarding wizard (#1098 UX redesign): one overlay spans provider search
  // → API key → model curation, keeping every prompt/verifying/failure/saving/
  // success notice beside the input field instead of the transcript entry flow.
  let wizardOverlay: OverlayHandle | undefined;
  let wizard: OnboardingWizard | undefined;
  let wizardProviderType: ProviderType | undefined;
  // The user's supplied key from the key step ('' reuses the stored secret for an
  // existing connection) and the models from the last verify (cached on save).
  // The runner holds them so the wizard stays UI-only; the secret never crosses
  // back into the wizard.
  let wizardApiKey = '';
  let wizardModels: readonly ModelInfo[] = [];
  // Authoritative ready model choices for `/model`. A startup snapshot refreshed
  // in place after `/setup` saves so newly configured models are immediately
  // available — the single source the picker and connection/model lookups read.
  let modelChoices = input.modelChoices;
  // Monotonic attempt id: each setup submit captures one, and any transition
  // that abandons the in-flight attempt (back, re-pick, close) increments it so
  // a late verify/save settlement cannot clobber a newer attempt.
  let wizardAttempt = 0;

  editor.onSubmit = (prompt) => {
    if (turnRunning) {
      // A quit/exit form typed while a turn is running must close the TUI, not
      // steer it into the model as prompt text (review finding on turnRunning
      // input routing): check it before handing off to steering.
      if (isExitPrompt(prompt)) {
        beginGracefulClose();
        return;
      }
      if (prompt.trim().split(/\s+/, 1)[0] === '/transcript') {
        editor.addToHistory(prompt);
        handleSlashCommand(prompt, 0);
        return;
      }
      const swarmCommand = parseSwarmCommand(prompt);
      if (swarmCommand) {
        editor.addToHistory(prompt);
        if (swarmCommand.kind === 'status') {
          showSwarmStatus();
        } else {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: 'Cannot change or start Swarm Mode while a turn is running.',
          });
          requestRender();
        }
        return;
      }
      const graphCommand = parseGraphCommand(prompt);
      if (graphCommand) {
        editor.addToHistory(prompt);
        if (graphCommand.kind === 'status') {
          showGraphStatus();
        } else {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: 'Cannot change or start Graph Mode while a turn is running.',
          });
          requestRender();
        }
        return;
      }
      // Known slash commands typed mid-turn follow the disposition declared on
      // the command itself (`midTurn`, review finding on turnRunning routing):
      // 'local' commands answer immediately because their handler is
      // independent of the running turn; 'switch' commands detach this
      // client's view from the running Turn and adopt another Session (#3380);
      // every other known command is refused with a clear message, since it
      // would either mutate session state behind the turn's back, open a
      // picker the turn would race, or silently no-op on the runControl busy
      // gate. ('intercepted' commands — /exit, /swarm, /graph — were claimed
      // by their dedicated checks above and reaching the refusal here only
      // means an unrecognized form.) Unknown slash-prefixed text still
      // steers: it may be intended prompt text (a skill invocation such as
      // `/skill:<name>`, or a path).
      const commandToken = prompt.trim().split(/\s+/, 1)[0] ?? '';
      const knownCommand = slashCommands.find(
        (candidate) =>
          `/${candidate.name}` === commandToken ||
          candidate.aliases?.some((alias) => `/${alias}` === commandToken),
      );
      if (knownCommand) {
        editor.addToHistory(prompt);
        // 'switch' dispositions route through like 'local': their handlers are
        // busy-aware and detach from the running Turn instead of touching it
        // (#3380).
        if (knownCommand.midTurn === 'local' || knownCommand.midTurn === 'switch') {
          handleSlashCommand(prompt, 0);
        } else {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: `Cannot run /${knownCommand.name} while a turn is running — interrupt it (Esc) or wait for it to finish.`,
          });
          requestRender();
        }
        return;
      }
      steerRunningTurn(prompt);
      return;
    }
    submitPrompt(prompt);
  };

  // Runs one visible agent turn through the shared activity/drain lifecycle.
  function runAgentTurn(
    request: MakaPiTuiTurnRequest,
    authoritativeAttachedTurn?: MakaAttachedSessionTurn,
  ): Promise<GoalTurnOutcome> {
    busy = true;
    const epoch = ++turnEpoch;
    // A mid-turn /session switch-away (#3380) bumps turnEpoch and orphans this
    // drain: from that point every callback below must stop touching shared
    // runner state — the adopted Session owns it now.
    const superseded = () => epoch !== turnEpoch;
    const activity = beginActivity();
    turnRunning = true;
    turnStartedAt = Date.now();
    startTurnElapsedTicker();
    interruptRequested = false;
    lastTurnEscapeAt = 0;
    editor.disableSubmit = false;
    setTaskbarProgress(true);
    attention.promptTurnStarted();
    requestRender();

    let permissionAlerted = false;
    let optimisticUserEntry: (typeof state.entries)[number] | undefined;
    const finishTurnUi = () => {
      turnRunning = false;
      turnStartedAt = undefined;
      stopTurnElapsedTicker();
      interruptRequested = false;
      editor.disableSubmit = false;
      setTaskbarProgress(false);
      attention.promptTurnEnded();
      // A turn ending is activity too — resets the idle clock the next
      // submission's auto-recap check measures against.
      lastActivityAt = Date.now();
    };

    return runMakaPiTuiTurn({
      driver: input.driver,
      turnActivity: input.turnActivity,
      request,
      // A requested stop converges through the authoritative event stream.
      // Cutting the iterator short here would make the UI appear idle before
      // the runtime has emitted its terminal event and accepted the stop.
      shouldAbort: () => closed,
      onStart: () => {
        if (request.kind !== 'attached') {
          appendUserPrompt(state, request.prompt);
          optimisticUserEntry = state.entries.at(-1);
        }
        requestRender();
      },
      onPrepared: async (turn) => {
        // Orphaned by a mid-turn detach: this can still fire after the
        // switch resolved (preparePrompt was in flight), and the abandoned
        // Turn's metadata must not overwrite the adopted Session's view.
        if (superseded()) return;
        if (authoritativeAttachedTurn) {
          adoptSessionMetadata(authoritativeAttachedTurn.summary);
          replaceTranscript(authoritativeAttachedTurn.messages);
          shellRunHydration.reset();
          if (input.listShellRunUpdates) {
            await shellRunHydration.hydrate(authoritativeAttachedTurn.sessionId);
          }
          shellRunElapsedTicker.sync();
          requestRender();
          return;
        }
        if (turn.summary) adoptSessionMetadata(turn.summary);
      },
      onSkillInvocation: (skillInvocation) => {
        // Same mid-turn detach fence as onPrepared/onEvent: a skill card
        // belonging to the abandoned Session must not land on the adopted
        // viewport (covers the blocked-invocation path too).
        if (superseded()) return;
        if (
          skillInvocation.loaded.length === 0 &&
          skillInvocation.failed.length > 0 &&
          optimisticUserEntry
        ) {
          const index = state.entries.indexOf(optimisticUserEntry);
          if (index >= 0) state.entries.splice(index, 1);
          optimisticUserEntry = undefined;
        }
        showSkillInvocation(skillInvocation);
      },
      onEvent: (event) => {
        // Orphaned by a mid-turn detach: the abandoned Session's stream must
        // not reach the adopted Session's transcript or overlays.
        if (superseded()) return;
        if (
          (event.type === 'sandbox_boundary_request' || event.type === 'user_question_request') &&
          resolvedInteractionIds.delete(event.requestId)
        ) {
          return;
        }
        applyMakaSessionEventToTranscript(state, event);
        if (event.type === 'error') attention.attentionNeeded();
        if (
          permissionResponseInFlightRequestId !== null &&
          activeSandboxBoundaryRequest(state)?.requestId !== permissionResponseInFlightRequestId
        ) {
          permissionResponseInFlightRequestId = null;
        }
        // A pending decision blocks the turn; ring an unfocused terminal once when
        // the prompt first appears (not on every render) so the user is not left
        // waiting on a prompt they cannot see.
        if (state.pendingInteraction) {
          if (!permissionAlerted) {
            permissionAlerted = true;
            attention.attentionNeeded();
          }
        } else {
          permissionAlerted = false;
        }
        shellRunElapsedTicker.sync();
        syncUserQuestionOverlay();
        requestRender();
      },
      // A turn failing is worth pulling the user back, regardless of how long it
      // ran — a quick failure in a background tab would otherwise stay silent.
      onFailure: (error) => {
        // Orphaned by a mid-turn detach: the abandoned drain ends without a
        // terminal event (channel close finishes its queue), which surfaces
        // here as "ended without completion" — never report that against the
        // adopted Session.
        if (superseded()) return;
        appendTurnFailureToTranscript(state, error);
        attention.attentionNeeded();
        shellRunElapsedTicker.sync();
        syncUserQuestionOverlay();
        requestRender();
      },
    }).then(
      async (outcome) => {
        finishTurnUi();
        if (closed) {
          busy = false;
          activity.finish();
          return outcome;
        }
        if (superseded()) {
          // Orphaned by a mid-turn detach (#3380): the Session this turn ran
          // on is no longer adopted. Skip every continuation that belongs to
          // it — queue flushes would steer the NEW Session, fallback texts
          // would refill the editor with abandoned-session context, and a
          // failure notice would misreport the still-running Host Turn. Only
          // release the slot and hand the freshly attached Turn its start;
          // startPendingAttachedTurn no-ops until applySwitchResult has
          // installed it and we are idle, and the detach path re-arms it, so
          // exactly one side starts it whichever unwinds first.
          busy = false;
          activity.finish();
          requestRender();
          startPendingAttachedTurn();
          return outcome;
        }

        // Turn boundary flush: CLI-held fallback texts that never reached the
        // runtime (the enqueue retry never found a live owner) are delivered
        // FIRST, then queued followups (alt+Enter) — both open the next turn
        // before any goal auto-continuation. Consumed here outside the turn
        // stream, so clear the local mirror explicitly.
        await settlePendingEnqueues();
        const fallbackEntries = await takePendingFallbackEntriesSettled();
        const followup = await input.driver.takePendingFollowup?.();
        if (outcome.kind === 'completed' && pendingAttachedTurn) {
          const attached = pendingAttachedTurn;
          pendingAttachedTurn = undefined;
          const undelivered: string[] = [];
          for (const entry of fallbackEntries) {
            const enqueue =
              entry.enqueue === 'steer' ? input.driver.steer : input.driver.queueMessage;
            try {
              if (!enqueue || (await enqueue.call(input.driver, entry.text)).kind === 'fallback') {
                undelivered.push(entry.text);
              }
            } catch {
              undelivered.push(entry.text);
            }
          }
          if (followup) {
            try {
              if (
                !input.driver.queueMessage ||
                (await input.driver.queueMessage(followup)).kind === 'fallback'
              ) {
                undelivered.push(followup);
              }
            } catch {
              undelivered.push(followup);
            }
          }
          busy = false;
          activity.finish();
          startAttachedTurn?.(attached);
          if (undelivered.length > 0) refillEditorFromQueues(undelivered.join('\n\n'));
          return outcome;
        }
        const fallbackText = fallbackEntries.map((entry) => entry.text).join('\n\n');
        const nextPrompt = [fallbackText, followup ?? ''].filter(Boolean).join('\n\n');
        if (nextPrompt) {
          state.steering = [];
          state.followup = [];
          if (outcome.kind !== 'completed') {
            // The turn was aborted or errored: auto-opening a turn would defeat
            // the interrupt (or hammer a failure). Keep the undelivered text as
            // an editable draft instead, merged ahead of any current draft.
            refillEditorFromQueues(nextPrompt);
          } else {
            // Install the next local activity before resolving the previous one.
            // A Goal admission woken by the old activity therefore observes the
            // user follow-up as busy instead of racing it for the session.
            void runAgentTurn({
              kind: 'external',
              prompt: nextPrompt,
              sessionId: input.driver.getSessionId(),
            });
            activity.finish();
            return outcome;
          }
        }

        busy = false;
        activity.finish();
        requestRender();
        startPendingAttachedTurn();
        return outcome;
      },
      (error) => {
        finishTurnUi();
        busy = false;
        activity.finish();
        requestRender();
        startPendingAttachedTurn();
        throw error;
      },
    );
  }

  const adoptSessionMetadata = (summary: SessionSummary) => {
    cwd = summary.cwd ?? cwd;
    setSessionTitle(summary.name);
    const previousModel = model;
    const previousConnectionSlug = connectionSlug;
    model = summary.model;
    connectionSlug = summary.llmConnectionSlug;
    const matchingChoice = modelChoices?.find(
      (choice) => choice.connectionSlug === summary.llmConnectionSlug,
    );
    providerType =
      matchingChoice?.providerType ??
      (previousConnectionSlug === summary.llmConnectionSlug ? providerType : undefined);
    const contextWindowMatch = modelChoices?.find(
      (choice) =>
        choice.connectionSlug === summary.llmConnectionSlug && choice.model === summary.model,
    );
    if (contextWindowMatch) {
      modelContextWindow = contextWindowMatch.contextWindow;
    } else if (
      previousConnectionSlug !== summary.llmConnectionSlug ||
      previousModel !== summary.model
    ) {
      modelContextWindow = undefined;
    }
    permissionMode = input.driver.getPermissionMode?.() ?? summary.permissionMode;
    orchestrationMode = summary.orchestrationMode ?? 'default';
    thinkingLevel = summary.thinkingLevel;
    // Choice-first: a relay model's user-declared levels live on the ModelChoice;
    // the metadata fallback serves providers whose variants derive from the
    // model id alone.
    thinkingLevels =
      contextWindowMatch?.thinkingLevels ??
      (providerType ? thinkingVariantsForModel(providerType, summary.model) : []);
    refreshEditorCwd?.(cwd);
  };

  startAttachedTurn = (attached) => {
    if (closed || turnRunning) return;
    void runAgentTurn(
      { kind: 'attached', turn: attached.turn },
      attached.kind === 'external' ? attached.turn : undefined,
    );
  };

  const setModel = async (nextModel: string) => {
    if (nextModel === model) return;
    const previousModel = deriveModelSwitchTranscript(transcriptMessages).lastUsedModel ?? model;
    await input.driver.setModel(nextModel);
    model = nextModel;
    // Same-connection switch: scope the choice lookup to the live connection
    // (another connection may expose the same model id with different
    // declared thinking levels).
    const match = modelChoices?.find(
      (choice) => choice.connectionSlug === connectionSlug && choice.model === nextModel,
    );
    if (match) modelContextWindow = match.contextWindow;
    thinkingLevel = undefined;
    thinkingLevels =
      match?.thinkingLevels ??
      (providerType ? thinkingVariantsForModel(providerType, nextModel) : []);
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: `Model changed: ${previousModel} → ${nextModel}`,
    });
    requestRender();
  };

  // Cross-connection /model: rebind the session to the chosen connection + model.
  // Updates the provider (and thus the thinking variants) and the status line.
  const setModelChoice = async (choice: ModelChoice) => {
    if (choice.model === model && choice.connectionSlug === connectionSlug) return;
    const previousModel = deriveModelSwitchTranscript(transcriptMessages).lastUsedModel ?? model;
    const previousConnectionSlug = connectionSlug;
    const previousChoice = modelChoices?.find(
      (candidate) =>
        candidate.model === previousModel && candidate.connectionSlug === previousConnectionSlug,
    );
    await input.driver.setModel(choice.model, choice.connectionSlug);
    model = choice.model;
    connectionSlug = choice.connectionSlug;
    providerType = choice.providerType;
    modelContextWindow = choice.contextWindow;
    thinkingLevel = undefined;
    thinkingLevels =
      choice.thinkingLevels ?? thinkingVariantsForModel(choice.providerType, choice.model);
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text:
        previousConnectionSlug === choice.connectionSlug
          ? `Model changed: ${previousModel} → ${choice.model}`
          : `Model changed: ${previousModel} (${previousChoice?.connectionName || previousConnectionSlug}) → ${choice.model} (${choice.connectionName || choice.connectionSlug})`,
    });
    requestRender();
  };

  const setThinkingLevel = async (nextLevel: ThinkingLevel | undefined) => {
    await input.driver.setThinkingLevel(nextLevel);
    thinkingLevel = nextLevel;
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: nextLevel ? `Thinking: ${nextLevel}` : 'Thinking: default',
    });
    requestRender();
  };

  // Adopt a switch/rewind result: the active session is now `summary` with
  // `messages`. Shared by switchSession and rewindToTurn so both land the same
  // runner state (model/connection/thinking/transcript/scroll).
  const applySwitchResult = async ({
    summary,
    messages,
    activeTurn,
  }: MakaSessionSwitchResult): Promise<void> => {
    adoptSessionMetadata(summary);
    replaceTranscript(messages);
    shellRunHydration.reset();
    if (input.listShellRunUpdates) {
      await shellRunHydration.hydrate(summary.id);
    }
    shellRunElapsedTicker.sync();
    pendingAttachedTurn = activeTurn ? { kind: 'adopted', turn: activeTurn } : undefined;
  };

  // The driver validates the durable cwd before adopting the resumed session.
  // A failure leaves the active session untouched and the next prompt still
  // lands on the old one.
  const switchSession = async (sessionId: string, relocateCwd?: string) => {
    resolvedInteractionIds.clear();
    const result = await input.driver.switchSession(
      sessionId,
      relocateCwd === undefined ? undefined : { relocateCwd },
    );
    await applySwitchResult(result);
    // Sync the transition cache to the adopted session's goal, then announce a
    // live durable goal: the init-time check ran before the driver attached
    // the resumed session, and the goal subscription only announces pause
    // transitions. Emitting here — after the transcript replacement that
    // would erase a notice from adoption time — keeps an auto-continuing
    // token-burning loop from resuming silently.
    currentGoal = input.driver.getGoal?.() ?? null;
    if (
      currentGoal !== null &&
      (currentGoal.status === 'active' || currentGoal.status === 'waiting')
    ) {
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: goalAttachedNoticeText(currentGoal),
      });
    }
    if (result.relocation?.changed) {
      const warning =
        result.relocation.oldCwdDirty === true
          ? ` Warning: the old directory "${result.relocation.previousCwd}" has uncommitted changes.`
          : '';
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: `Session moved to "${result.relocation.cwd}".${warning}`,
      });
    }
    if (result.messages.length === 0) {
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: `Resumed session "${result.summary.name}"`,
      });
    }
    requestRender();
  };

  // Mid-turn `/session` switch-away (#3380): adopt another Session while a
  // Turn is still running on the current one. In Runtime Host mode the Turn is
  // Host-owned — this TUI was only its viewport — so detaching the view must
  // not stop it (unlike the interrupt path, driver.stop() is never called
  // here). Bumping turnEpoch orphans the in-flight drain; its runAgentTurn
  // tail unwinds through the superseded branch and releases busy/activity,
  // then either that tail or the startPendingAttachedTurn below starts the
  // freshly attached Turn, whichever observes an idle runner first.
  const switchAwayMidTurn = async (sessionId: string) => {
    resolvedInteractionIds.clear();
    detaching = true;
    try {
      // Fence only after the driver confirms the switch: a failed switch must
      // leave the in-flight drain fully live. Events the abandoned queue
      // yields between the channel closing inside switchSession and
      // replaceTranscript below are wiped by that replacement; everything
      // after it hits the superseded fence.
      const result = await input.driver.switchSession(sessionId);
      turnEpoch += 1;
      await applySwitchResult(result);
      // Same adoption-time announcement as the idle path: applySwitchResult
      // replaced the transcript, so a live durable Goal on the adopted Session
      // must be re-announced here rather than silently auto-continuing.
      currentGoal = input.driver.getGoal?.() ?? null;
      if (
        currentGoal !== null &&
        (currentGoal.status === 'active' || currentGoal.status === 'waiting')
      ) {
        state.entries.push({
          kind: 'notice',
          level: 'info',
          text: goalAttachedNoticeText(currentGoal),
        });
      }
      if (result.messages.length === 0) {
        state.entries.push({
          kind: 'notice',
          level: 'info',
          text: `Resumed session "${result.summary.name}"`,
        });
      }
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: 'Detached from the running Turn — it keeps running. /session back to reattach.',
      });
      requestRender();
    } finally {
      detaching = false;
      startPendingAttachedTurn();
    }
  };

  // `/session` is view navigation (#3380). Idle, it runs under runControl's
  // serial lock like any control action; mid-turn that lock is held by the
  // running Turn, so the switch goes through the detach path instead of
  // silently no-oping on the busy gate.
  const goToSession = async (sessionId: string): Promise<void> => {
    if (!turnRunning) {
      await runControl(() => switchSession(sessionId));
      return;
    }
    // One detach at a time (#3380): a second mid-turn switch while the first
    // is still handing the view over would clear `detaching` early, reopen
    // the interrupt window, and double-apply the adoption.
    if (detaching) return;
    await switchAwayMidTurn(sessionId).catch(reportError);
  };
  const openSessionPicker = (): Promise<void> => {
    if (!turnRunning) return runControl(showSessionList);
    // The picker itself is a passive overlay; only its selection detaches.
    return showSessionList().catch(reportError);
  };

  // Rewind branches the active session to just before the chosen turn and
  // switches onto the branch (driver.rewindToTurn), then refills the editor with
  // that turn's prompt. The original session is left intact, so this is
  // non-destructive and inherits the branch's resume guarantees.
  const rewindToTurn = async (turnId: string) => {
    resolvedInteractionIds.clear();
    // Synchronous feedback before the first await: branching + switching takes
    // several serialized runtime-host round trips, and control-busy renders
    // nothing in the TUI body, so without this notice the picker's Enter looks
    // dead until the branch lands (#3383). replaceTranscript wipes it on
    // success; the catch removes it on failure so only the error stays.
    const pendingNotice: (typeof state.entries)[number] = {
      kind: 'notice',
      level: 'info',
      text: '正在回退到该轮之前…',
    };
    state.entries.push(pendingNotice);
    requestRender();
    try {
      const result = await input.driver.rewindToTurn(turnId);
      await applySwitchResult(result);
      // Record the discarded turn's prompt in the editor history before
      // deciding on the refill: prompts submitted in this TUI process are
      // already there (addToHistory dedupes consecutive duplicates), but a
      // session entered via startup resume or /resume has no entry yet, and
      // the notice below promises ↑ recovery (#3475 review).
      editor.addToHistory(result.prompt);
      // Refill the editor with that prompt so the user can edit and resend it
      // — unless newer user input arrived while the switch was in flight. The
      // picker's neutral-editor guarantee only holds at open time, so this
      // covers both a typed draft and a bracketed paste still being buffered
      // (getText() stays empty until its end marker); either wins over the
      // refill.
      const refill = editor.getText().trim().length === 0 && !editorPastePending;
      if (refill) editor.setText(result.prompt);
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: refill
          ? '已回退到该轮之前（分支为新任务，原任务保留），该轮 prompt 已回填输入框，可修改后重新发送。'
          : '已回退到该轮之前（分支为新任务，原任务保留）。输入框已有未发送内容，未覆盖；该轮 prompt 已存入输入历史，可按 ↑ 找回。',
      });
      requestRender();
    } catch (error) {
      const index = state.entries.indexOf(pendingNotice);
      if (index >= 0) state.entries.splice(index, 1);
      throw error;
    }
  };

  const showBottomPicker = (picker: Component): OverlayHandle =>
    tui.showOverlay(picker, {
      anchor: 'bottom-left',
      width: '100%',
      maxHeight: Math.max(1, terminal.rows - BOTTOM_PICKER_MARGIN_ROWS),
      margin: { bottom: BOTTOM_PICKER_MARGIN_ROWS },
    });

  const closeUserQuestionOverlay = (): void => {
    userQuestionOverlay?.hide();
    userQuestionOverlay = undefined;
  };

  const finishUserQuestion = (requestId: string, answers: Array<string | null>): void => {
    if (userQuestionInFlight) return;
    const respond = input.driver.respondToUserQuestion;
    if (!respond) {
      reportError(new Error('User questions are unavailable on this driver.'));
      return;
    }
    userQuestionInFlight = true;
    closeUserQuestionOverlay();
    void respond
      .call(input.driver, { requestId, answers })
      .then(() => {
        userQuestionInFlight = false;
        if (activeUserQuestionRequest(state)?.requestId === requestId) {
          completePendingInteraction(state, requestId);
        }
        userQuestionProgress = undefined;
        syncUserQuestionOverlay();
        requestRender();
      })
      .catch((error) => {
        userQuestionInFlight = false;
        reportError(error);
        syncUserQuestionOverlay();
      });
  };

  const showUserQuestion = (): void => {
    const request = activeUserQuestionRequest(state);
    const progress = userQuestionProgress;
    if (!request || !progress || progress.requestId !== request.requestId) return;
    const question = request.questions[progress.index];
    if (!question) {
      finishUserQuestion(request.requestId, progress.answers);
      return;
    }
    closeUserQuestionOverlay();
    const advance = (answer: string | null): void => {
      progress.answers[progress.index] = answer;
      progress.index += 1;
      showUserQuestion();
    };
    userQuestionOverlay = showBottomPicker(
      new UserQuestionOverlay(tui, {
        title: question.question,
        rightLabel: `${progress.index + 1} / ${request.questions.length}`,
        hint: '↑↓ move · type to answer · Enter select · Esc unanswered · Ctrl+C stop',
        placeholder: 'Other: type your answer…',
        options: question.options,
        onSelectOption: (index) => advance(question.options[index]?.label ?? null),
        onSubmitText: (value) => advance(value),
        onSkip: () => advance(null),
      }),
    );
  };

  const syncUserQuestionOverlay = (): void => {
    const request = activeUserQuestionRequest(state);
    if (!request) {
      closeUserQuestionOverlay();
      userQuestionProgress = undefined;
      return;
    }
    if (userQuestionInFlight) return;
    if (userQuestionProgress?.requestId !== request.requestId) {
      userQuestionProgress = {
        requestId: request.requestId,
        index: 0,
        answers: Array.from({ length: request.questions.length }, () => null),
      };
      showUserQuestion();
    }
  };

  const showSelectPicker = (
    title: string,
    rightLabel: string,
    items: SelectItem[],
    onSelect: (item: SelectItem) => void,
    options: {
      minPrimaryColumnWidth: number;
      maxPrimaryColumnWidth: number;
      selectedIndex?: number;
      hint?: string;
      notice?: string;
      onCancel?: () => void;
    },
  ): void => {
    const list = new SelectList(items, 10, selectListTheme(), {
      minPrimaryColumnWidth: options.minPrimaryColumnWidth,
      maxPrimaryColumnWidth: options.maxPrimaryColumnWidth,
    });
    if (options.selectedIndex !== undefined) list.setSelectedIndex(options.selectedIndex);
    const picker = new PickerOverlay(list, {
      title,
      rightLabel,
      hint: options.hint,
      notice: options.notice,
    });
    let overlay: OverlayHandle | undefined;
    list.onSelect = (item) => {
      overlay?.hide();
      onSelect(item);
    };
    list.onCancel = () => {
      overlay?.hide();
      options.onCancel?.();
    };
    overlay = showBottomPicker(picker);
  };

  const closeWizard = (): void => {
    wizardAttempt += 1; // drop any in-flight verify/save before clearing the slots
    wizardOverlay?.hide();
    wizardOverlay = undefined;
    wizard = undefined;
    wizardProviderType = undefined;
    wizardApiKey = '';
    wizardModels = [];
  };

  // Key submit from the wizard. Slash commands route as commands (so /exit
  // still escapes the wizard) instead of being stored as an API key; every
  // in-flight state stays inside the wizard overlay, never the transcript.
  const submitWizardKey = (apiKey: string): void => {
    const providerType = wizardProviderType;
    if (!providerType || !wizard) return;
    if (apiKey.startsWith('/')) {
      closeWizard();
      handleSlashCommand(apiKey, 0);
      return;
    }
    if (!input.onboarding) {
      wizard.setKeyError('Onboarding 不可用：当前运行环境未提供配置入口。');
      requestRender();
      return;
    }
    wizardApiKey = apiKey;
    const targetWizard = wizard;
    const attempt = ++wizardAttempt;
    targetWizard.setVerifying();
    requestRender();
    void input.onboarding.verify({ providerType, apiKey }).then(
      (result) => {
        if (closed || wizard !== targetWizard || attempt !== wizardAttempt) return;
        if (result.kind === 'error') {
          // Probe failed: re-arm the key field in place. The host stores nothing
          // during verify, so retrying with a corrected key is clean.
          wizard.setKeyError(`API key 验证失败：${result.text}。请检查后重新输入。`);
          requestRender();
          return;
        }
        wizardModels = result.models;
        wizard.setModels(result.models); // advance to the models step
        requestRender();
      },
      (error) => {
        if (closed || wizard !== targetWizard || attempt !== wizardAttempt) return;
        wizard.setKeyError(`配置失败：${error instanceof Error ? error.message : String(error)}`);
        requestRender();
      },
    );
  };

  // Models submit from the wizard: persist the curated enabled set, refresh the
  // running TUI's authoritative ready model choices, and show an in-frame
  // success (first-run closes the TUI so the host re-resolves the new default).
  // Setup never appends a transcript Note and never switches the active session.
  const submitWizardModels = (enabledModelIds: readonly string[]): void => {
    const providerType = wizardProviderType;
    if (!providerType || !wizard) return;
    if (!input.onboarding) {
      wizard.setModelError('Onboarding 不可用：当前运行环境未提供配置入口。');
      requestRender();
      return;
    }
    const targetWizard = wizard;
    const attempt = ++wizardAttempt;
    targetWizard.setSaving();
    requestRender();
    void input.onboarding
      .save({ providerType, apiKey: wizardApiKey, enabledModelIds, models: wizardModels })
      .then(
        (result) => {
          if (result.kind === 'error') {
            if (closed || wizard !== targetWizard || attempt !== wizardAttempt) return;
            wizard.setModelError(result.text);
            requestRender();
            return;
          }
          // Authoritatively refresh the running TUI's ready model choices so the
          // newly configured models are immediately available from /model — even
          // if the user abandoned the wizard mid-save. Abandonment only drops the
          // in-frame success UI, not the background state sync. The active
          // session is not switched.
          modelChoices = result.modelChoices;
          if (closed || wizard !== targetWizard || attempt !== wizardAttempt) return;
          if (input.firstRun) {
            beginClose();
            return;
          }
          wizard.setSuccess(enabledModelIds.length);
          requestRender();
        },
        (error) => {
          if (closed || wizard !== targetWizard || attempt !== wizardAttempt) return;
          wizard.setModelError(
            `保存失败：${error instanceof Error ? error.message : String(error)}`,
          );
          requestRender();
        },
      );
  };

  const showSetupWizard = async (): Promise<void> => {
    let providers: OnboardingProviderEntry[];
    if (input.onboarding) {
      try {
        providers = await input.onboarding.listProviders();
      } catch (error) {
        state.entries.push({
          kind: 'notice',
          level: 'info',
          text: `无法读取已配置的连接：${error instanceof Error ? error.message : String(error)}`,
        });
        requestRender();
        return;
      }
    } else {
      // No surface (a minimal test host): open with the bare catalog so the
      // wizard can report unavailability in-frame at submit instead of throwing.
      providers = listApiKeyOnboardableProviders().map((provider) => ({
        ...provider,
        hasConnection: false,
        enabledModelIds: [],
      }));
    }
    if (providers.length === 0) {
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: '没有可配置的 API key 类供应商。',
      });
      requestRender();
      return;
    }
    wizardOverlay?.hide();
    wizard = new OnboardingWizard(tui, {
      providers,
      onPickProvider: (providerType) => {
        wizardProviderType = providerType;
        wizardApiKey = '';
        wizardModels = [];
        wizardAttempt += 1; // a new pick supersedes any in-flight attempt
        requestRender();
      },
      onSubmitKey: submitWizardKey,
      onSubmitModels: submitWizardModels,
      onCancel: () => {
        closeWizard();
        // First-run has no connection to fall back to: cancelling the wizard
        // closes the TUI so the host surfaces its missing-default guidance.
        if (input.firstRun) beginClose();
      },
      onBack: () => {
        wizardAttempt += 1; // back one level invalidates any in-flight verify/save
        requestRender();
      },
      onClose: () => {
        closeWizard();
      },
    });
    wizardOverlay = showBottomPicker(wizard);
  };

  // One-sentence session recap (issue #1055). Shared by the manual /recap
  // command and idle-return auto-recap; both paths route through the same
  // in-flight lock so at most one recap call runs at a time.
  const runRecap = async (reason: 'manual' | 'idle'): Promise<void> => {
    // Captured synchronously on entry, so for the idle path this already
    // includes the seq bump from the very prompt that triggered this call
    // (submitPrompt bumps promptSeq before invoking maybeTriggerAutoRecap).
    // Only a prompt submitted *after* this point — i.e. later than the one
    // that triggered the recap — should make the result stale.
    const seqAtStart = promptSeq;
    // Captured synchronously on entry, before any await: /session, /new, and
    // rewind never bump promptSeq, so a session switch mid-generate must be
    // caught by comparing sessionIds directly rather than relying on seq.
    const sessionIdAtStart = input.driver.getSessionId();
    if (!input.recap) {
      if (reason === 'manual') {
        state.entries.push({
          kind: 'notice',
          level: 'error',
          text: 'Recap is not available in this environment.',
        });
        requestRender();
      }
      return;
    }
    if (recapInFlight) {
      if (reason === 'manual') {
        state.entries.push({
          kind: 'notice',
          level: 'error',
          text: 'Recap already running.',
        });
        requestRender();
      }
      return;
    }
    // Locked synchronously, before any await: two /recap invocations
    // submitted back-to-back must not both pass the recapInFlight check above
    // before either sets it. The rest of the body is one try/finally so every
    // early return (including "Nothing to recap yet" and a null session)
    // releases the lock.
    recapInFlight = true;
    try {
      const mainTurnCount = (await input.driver.listRewindTargets()).length;
      if (reason === 'manual' && mainTurnCount < 1) {
        state.entries.push({
          kind: 'notice',
          level: 'info',
          text: 'Nothing to recap yet.',
        });
        requestRender();
        return;
      }
      if (!sessionIdAtStart) return;

      const result = await input.recap.generate(sessionIdAtStart, reason);

      // The active session must still be the one this recap started for —
      // checked before ANY display (success notice or manual failure notice).
      // /session, /new, or a rewind switched the active session while
      // generate() was in flight: the session this result belongs to is gone
      // from view, so surfacing it (success or error) would land on the wrong
      // session. Drop it silently regardless of manual/idle.
      if (input.driver.getSessionId() !== sessionIdAtStart) return;

      if (!result.ok) {
        if (reason === 'manual') {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: `Recap failed: ${result.error}`,
          });
          requestRender();
        }
        return;
      }

      if (reason === 'idle') {
        // Below the display threshold suppresses the notice (still persisted by
        // the generator); a prompt submitted after seqAtStart while the call
        // was in flight means a later prompt has superseded this recap — drop
        // it silently either way.
        if (Buffer.byteLength(result.raw, 'utf8') > AUTO_RECAP_DISPLAY_LIMIT_BYTES) return;
        if (promptSeq !== seqAtStart) return;
      }

      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: `Recap: ${result.text}`,
      });
      requestRender();
    } finally {
      recapInFlight = false;
    }
  };

  // Fire-and-forget idle-return check: a normal prompt submitted after a long
  // enough gap auto-triggers a recap, without blocking the turn it opens.
  const maybeTriggerAutoRecap = (idleMs: number): void => {
    if (!input.recap) return;
    void (async () => {
      try {
        const sessionId = input.driver.getSessionId();
        const mainTurnCount = (await input.driver.listRewindTargets()).length;
        const lastRecapMainTurnCount =
          sessionId && recapWatermark?.sessionId === sessionId ? recapWatermark.mainTurnCount : 0;
        if (!shouldAutoRecap({ idleMs, mainTurnCount, lastRecapMainTurnCount })) return;
        if (sessionId) recapWatermark = { sessionId, mainTurnCount };
        void runRecap('idle');
      } catch {
        // Best-effort: auto-recap must never surface an error to the user.
      }
    })();
  };

  const compactSession = async () => {
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: 'Compacting context…',
    });
    requestRender();
    await submitCompactToTranscript({
      state,
      driver: input.driver,
      onChange: requestRender,
    });
  };

  const resumeSession = async () => {
    if (!input.driver.resumeLatest) {
      throw new Error('Safe-boundary resume is unavailable on this runtime.');
    }
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: 'Resuming from the latest safe boundary…',
    });
    requestRender();
    for await (const event of input.driver.resumeLatest()) {
      applyMakaSessionEventToTranscript(state, event);
      shellRunElapsedTicker.sync();
      syncUserQuestionOverlay();
      requestRender();
    }
  };

  const showSessionList = async () => {
    const sessions = await input.driver.listSessions();
    const sessionTree = projectRevisionLinkedSessionTree(
      sessions,
      input.driver.getSessionId() ?? undefined,
    );
    const projectedSessions = flattenLinkedSessionTree(
      sessionTree.roots,
      sessionTree.childrenByParentId,
    );
    // Maka-session availability and the foreign scan are independent I/O; run
    // them concurrently so the picker's open latency is the slower of the two,
    // not their sum.
    const [availabilityEntries, foreignScan] = await Promise.all([
      Promise.all(
        sessions.map(async (session) => {
          return [
            session.id,
            (await input.driver.getSessionResumeAvailability?.(session)) ??
              (await inspectSessionResumeAvailability(session)),
          ] as const;
        }),
      ),
      // Foreign (Claude Code / Codex) rows are an import flow: it starts a NEW
      // Session and hands off a turn, which cannot detach from the running
      // one (#3380). Skip the scan mid-turn instead of offering rows whose
      // selection would silently no-op on importForeignSession's busy guard.
      input.foreignSessions && !turnRunning
        ? input.foreignSessions.listSessions({ cwd }).then(
            (summaries) => ({ summaries }),
            (error: unknown) => ({ error }),
          )
        : Promise.resolve({ summaries: [] as ForeignSessionSummary[] }),
    ]);
    const availability = new Map(availabilityEntries);
    // Foreign (Claude Code / Codex) sessions for the current cwd, keyed by a
    // prefixed select value so they never collide with Maka session ids. A scan
    // error is surfaced (not silently swallowed): degrade to no rows but tell
    // the user why, so a real store bug isn't mistaken for "no sessions".
    const foreignByValue = new Map<string, ForeignSessionSummary>();
    if ('error' in foreignScan) {
      const detail =
        foreignScan.error instanceof Error ? foreignScan.error.message : String(foreignScan.error);
      state.entries.push({
        kind: 'notice',
        level: 'error',
        text: `读取外部对话失败：${detail}`,
      });
    } else {
      for (const summary of foreignScan.summaries) {
        foreignByValue.set(`foreign:${summary.source}:${summary.id}`, summary);
      }
    }
    const renderScope = (): void => {
      const visibleSessions =
        sessionListScope === 'current'
          ? projectedSessions.filter(({ session }) => session.cwd === cwd)
          : projectedSessions;
      const items: SelectItem[] = visibleSessions.map(({ session, depth }) => {
        const state = availability.get(session.id);
        const statusBadge = sessionStatusBadge(session, locale);
        const statusDetail = statusBadge ? ` · ${statusBadge}` : '';
        const location =
          sessionListScope === 'all' && session.cwd ? ` ${basename(session.cwd)}` : '';
        const childDetail = session.subagentRuntime
          ? ` subagent:${session.subagentRuntime.profile}`
          : '';
        return {
          value: session.id,
          label: `${depth > 0 ? `${'  '.repeat(depth - 1)}↳ ` : ''}${session.name || session.id}`,
          description:
            state?.available === false
              ? `${shortSessionId(session.id)}${statusDetail} ${state.reason}`
              : `${shortSessionId(session.id)}${statusDetail}${location}${childDetail} ${session.llmConnectionSlug} ${session.model}`,
        };
      });
      // Foreign sessions are cwd-scoped; show them in both scope views (they
      // belong to this project) so a Tab toggle never makes them vanish.
      for (const [value, summary] of foreignByValue) {
        items.push({
          value,
          label: summary.title,
          description: `↩ resume from ${foreignSourceLabel(summary.source)}`,
        });
      }
      const list = new SelectList(items, 10, selectListTheme(), {
        minPrimaryColumnWidth: 20,
        maxPrimaryColumnWidth: Math.max(20, terminal.columns - 30),
      });
      let overlay: OverlayHandle | undefined;
      const closeOverlay = () => {
        sessionPickerOverlayOpen = false;
        overlay?.hide();
      };
      list.onSelect = (item) => {
        const foreign = foreignByValue.get(item.value);
        if (foreign) {
          closeOverlay();
          void importForeignSession(foreign);
          return;
        }
        if (availability.get(item.value)?.available === false) return;
        closeOverlay();
        void goToSession(item.value);
      };
      list.onCancel = () => closeOverlay();
      sessionPickerOverlayOpen = true;
      overlay = showBottomPicker(
        new PickerOverlay(list, {
          title: 'Resume Session',
          rightLabel: sessionListScope === 'current' ? 'Current' : 'All',
          hint: 'Tab scope · ↑↓ move · Enter select · Esc close',
          onInput: (data) => {
            if (!matchesKey(data, Key.tab) || isKeyRelease(data) || isKeyRepeat(data)) return false;
            sessionListScope = sessionListScope === 'current' ? 'all' : 'current';
            overlay?.hide();
            renderScope();
            return true;
          },
        }),
      );
    };
    renderScope();
  };

  const showRewindPicker = async () => {
    const targets = await input.driver.listRewindTargets();
    if (targets.length === 0) {
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: '没有可回退的轮次。',
      });
      requestRender();
      return;
    }
    const items: SelectItem[] = targets.map((target) => ({
      value: target.turnId,
      label: target.label,
    }));
    showSelectPicker(
      'Rewind',
      'Rewind',
      items,
      (item) => {
        // runControl drops the action silently when busy is already held (e.g.
        // a Goal auto-continuation started while the picker was open). The
        // overlay is already closed at this point, so say so instead of
        // leaving a dead Enter — same contract as /goal's busy guard.
        if (busy) {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: '无法回退：当前有正在进行的操作 — 请等待其完成，或中断（Esc）后重试。',
          });
          requestRender();
          return;
        }
        void runControl(() => rewindToTurn(item.value));
      },
      {
        minPrimaryColumnWidth: 24,
        maxPrimaryColumnWidth: 48,
        hint: '回到选定轮次之前（丢弃该轮及之后，prompt 回填输入框） · enter 选择 / esc 取消',
      },
    );
  };

  const newSession = () => {
    input.driver.startNewSession();
    // A fresh session is not bound by the previous one's boundary. Falling back
    // to the *current* label would keep the previous Session's mode, including
    // Auto while a changed Host default creates with full access; the launch
    // reading is the Host's value, so it is the safe floor when the driver has
    // nothing newer.
    permissionMode = input.driver.getPermissionMode?.() ?? input.permissionMode;
    attention.setBaseTitle(input.title);
    shellRunHydration.reset();
    // Fresh transcript for the fresh session; the next prompt creates it on disk.
    // Leave the transcript empty (no confirmation notice) so /new opens on the
    // same welcome block as a cold start — the welcome block is the "fresh
    // session, send a prompt to begin" cue. A notice here would make entries
    // non-empty and suppress it.
    replaceTranscript([]);
    shellRunElapsedTicker.sync();
    requestRender();
  };

  // Import a foreign (Claude Code / Codex) session: read its digest, open a
  // fresh Maka session, and seed the first turn with an untrusted handoff
  // envelope. Mirrors submitPreparedUserPrompt: claim `busy` + an activity lease
  // SYNCHRONOUSLY before the async read so no other turn (a Goal auto-
  // continuation, or a user Enter) can start during it and make the import a
  // silent no-op. runAgentTurn re-asserts busy for the turn; on any failure the
  // finally releases the lease. The handoff is the model-facing `sendText`; a
  // short line shows in the transcript.
  const importForeignSession = async (summary: ForeignSessionSummary): Promise<void> => {
    if (busy || input.foreignSessions === undefined) return;
    busy = true;
    const activity = beginActivity();
    editor.disableSubmit = true;
    let handedOff = false;
    try {
      const digest = await input.foreignSessions.readDigest(summary);
      if (closed) return;
      newSession();
      void runAgentTurn({
        kind: 'external',
        prompt: foreignSessionHandoffDisplayText(digest),
        sessionId: input.driver.getSessionId(),
        sendText: buildForeignSessionHandoffMessage(digest),
      });
      handedOff = true;
    } catch (error) {
      if (closed) return;
      reportError(error);
    } finally {
      if (!handedOff) {
        busy = false;
        editor.disableSubmit = false;
        requestRender();
      }
      activity.finish();
    }
  };

  const showHelp = () => {
    // Derive the command list from the registry so /help never drifts from the
    // real commands. Keybindings are not commands, so they are listed by hand.
    const commands = slashCommands
      .map((command) => {
        const aliasSuffix =
          command.aliases && command.aliases.length > 0
            ? ` (${command.aliases.map((alias) => `/${alias}`).join(', ')})`
            : '';
        return `  /${command.name}${aliasSuffix} — ${command.description}`;
      })
      .join('\n');
    const keybindings = primaryGuidance.help.keybindings.join('\n');
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: `${primaryGuidance.help.commandsHeading}\n${commands}\n\n${primaryGuidance.help.keybindingsHeading}\n${keybindings}`,
    });
    requestRender();
  };

  const showTranscriptViewer = (): void => {
    let overlay: OverlayHandle | undefined;
    const renderTranscript = transcript.createDocumentRenderer();
    const viewer = new TranscriptViewerOverlay({
      renderTranscript,
      viewportRows: () => terminal.rows,
      onClose: () => overlay?.hide(),
      onChange: () => tui.requestRender(),
    });
    overlay = tui.showOverlay(viewer, {
      anchor: 'top-left',
      width: '100%',
      maxHeight: '100%',
    });
  };

  const showModelList = () => {
    const choices = modelChoices;
    const hasConversationHistory = state.entries.some(
      (entry) => entry.kind === 'user' || entry.kind === 'assistant',
    );
    // Cross-connection picker when the caller supplied choices across all ready
    // connections; otherwise the single-connection list (typed /model, tests).
    if (choices && choices.length > 0) {
      let overlay: OverlayHandle | undefined;
      const picker = new ModelSearchOverlay(tui, {
        choices,
        current: { model, connectionSlug },
        showCacheWarning: hasConversationHistory,
        onSelect: (choice) => {
          overlay?.hide();
          void runControl(() => setModelChoice(choice));
        },
        onCancel: () => overlay?.hide(),
      });
      overlay = showBottomPicker(picker);
      return;
    }
    showSelectPicker(
      'Select Model',
      connectionSlug,
      modelPickerItems(model, input.models),
      (item) => {
        void runControl(() => setModel(item.value));
      },
      {
        minPrimaryColumnWidth: 24,
        maxPrimaryColumnWidth: 48,
        notice: hasConversationHistory ? MODEL_SWITCH_CACHE_WARNING : undefined,
      },
    );
  };

  // `/skill` with no arguments: pick from everything the host can invoke right
  // now. Picking only inserts the token into the draft — never sends — so the
  // user keeps composing (and can add more tokens) before submitting.
  const showSkillList = async () => {
    const entries = await listSkillsCached(true);
    if (closed) return;
    if (entries.length === 0) {
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: '当前没有可调用的技能。',
      });
      requestRender();
      return;
    }
    showSelectPicker(
      'Invoke Skill',
      String(entries.length),
      skillPickerItems(entries),
      (item) => {
        editor.insertTextAtCursor(`/skill:${item.value} `);
        requestRender();
      },
      { minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 40 },
    );
  };

  const showThinkingLevelList = () => {
    const items = thinkingLevelPickerItems(thinkingLevels, thinkingLevel);
    showSelectPicker(
      'Select Thinking Level',
      thinkingLevel ?? 'default',
      items,
      (item) => {
        const level = item.value === 'default' ? undefined : (item.value as ThinkingLevel);
        if (level !== undefined && !isThinkingLevel(level)) return;
        void runControl(() => setThinkingLevel(level));
      },
      {
        minPrimaryColumnWidth: 16,
        maxPrimaryColumnWidth: 24,
        selectedIndex: items.findIndex((item) => item.value === (thinkingLevel ?? 'default')),
      },
    );
  };

  const setPermissionMode = async (mode: PermissionMode) => {
    await input.driver.setPermissionMode(mode);
    // Report the boundary that resulted, not the one that was requested.
    permissionMode = input.driver.getPermissionMode?.() ?? mode;
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: `Permissions: ${permissionModeLabel(permissionMode)}`,
    });
    requestRender();
  };

  const requestSandboxBoundaryMode = (mode: 'auto' | 'bypass') => {
    if (mode === 'auto' || permissionMode === 'bypass') {
      void runControl(() => setPermissionMode(mode === 'auto' ? 'ask' : 'bypass'));
      return;
    }
    const confirmation = [
      {
        value: 'keep',
        label: 'Keep Auto',
        description: 'Stay inside the protected environment',
      },
      {
        value: 'bypass',
        label: 'Turn on full access',
        description:
          'Reach your files and your network directly; use only for trusted or externally isolated tasks',
      },
    ];
    showSelectPicker(
      'Switch to full access?',
      'keep',
      confirmation,
      (choice) => {
        if (choice.value === 'bypass') {
          void runControl(() => setPermissionMode('bypass'));
        }
      },
      {
        minPrimaryColumnWidth: 18,
        maxPrimaryColumnWidth: 28,
        selectedIndex: 0,
      },
    );
  };

  const showSwarmStatus = () => {
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text:
        orchestrationMode === 'swarm'
          ? 'Swarm Mode is on for this session.'
          : 'Swarm Mode is off for this session.',
    });
    requestRender();
  };

  const setSwarmMode = async (mode: OrchestrationMode) => {
    if (!input.driver.setOrchestrationMode) {
      throw new Error('Swarm Mode is unavailable on this session driver.');
    }
    await input.driver.setOrchestrationMode(mode);
    orchestrationMode = mode;
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: mode === 'swarm' ? 'Swarm Mode enabled for this session.' : 'Swarm Mode disabled.',
    });
    requestRender();
  };

  const runSwarmCommand = (command: ParsedSwarmCommand, idleMs: number) => {
    if (command.kind === 'status') {
      showSwarmStatus();
      return;
    }
    if (command.kind === 'set_mode') {
      void runControl(() => setSwarmMode(command.mode));
      return;
    }
    if (input.firstRun) {
      void showSetupWizard();
      return;
    }
    lastActivityAt = Date.now();
    promptSeq += 1;
    maybeTriggerAutoRecap(idleMs);
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: 'Using Swarm Mode for this turn only.',
    });
    void runAgentTurn({
      kind: 'external',
      prompt: command.task,
      sessionId: input.driver.getSessionId(),
      turnOrchestration: { mode: 'swarm', source: 'slash_command' },
    });
  };

  const showGraphStatus = () => {
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text:
        orchestrationMode === 'graph' ? 'Graph Mode is on for this session.' : 'Graph Mode is off.',
    });
    requestRender();
  };

  const showGraphHistory = async (): Promise<void> => {
    const rootSessionId = input.driver.getSessionId();
    if (!rootSessionId || !input.agentGraphHistory) {
      throw new Error('Agent Graph history is unavailable on this session driver.');
    }
    const directory = await input.agentGraphHistory.listEpochs(rootSessionId);
    // The TUI may have shut down while the page reads were in flight.
    if (closed) return;
    const { epochs, truncated } = directory;
    const items: SelectItem[] = epochs.map((entry) => ({
      value: entry.graphId,
      label: `Run #${entry.epoch}${entry.current ? ' · Current' : ''}`,
      description: entry.current ? 'Current graph' : 'History · read-only',
    }));
    if (items.length === 0) {
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: 'This session has no Agent Graph runs.',
      });
      requestRender();
      return;
    }
    const epochsByGraphId = new Map(epochs.map((entry) => [entry.graphId, entry]));
    showSelectPicker(
      'Agent Graph History',
      truncated
        ? `newest ${items.length} runs (history capped)`
        : `${items.length} run${items.length === 1 ? '' : 's'}`,
      items,
      (item) => {
        const epoch = epochsByGraphId.get(item.value);
        if (!epoch) return;
        void runControl(async () => {
          const graph = await input.agentGraphHistory!.getSnapshot(rootSessionId, epoch.graphId);
          if (closed) return;
          state.entries.push({
            kind: 'notice',
            level: 'info',
            text: formatAgentGraphHistory(graph, epoch),
          });
          requestRender();
        });
      },
      {
        minPrimaryColumnWidth: 16,
        maxPrimaryColumnWidth: 28,
        selectedIndex: Math.max(
          0,
          epochs.findIndex((entry) => entry.current),
        ),
        hint: '↑↓ move · Enter inspect · Esc close',
      },
    );
  };

  const setGraphMode = async (mode: OrchestrationMode) => {
    if (!input.driver.setOrchestrationMode) {
      throw new Error('Graph Mode is unavailable on this session driver.');
    }
    await input.driver.setOrchestrationMode(mode);
    orchestrationMode = mode;
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: mode === 'graph' ? 'Graph Mode enabled for this session.' : 'Graph Mode disabled.',
    });
    requestRender();
  };

  const runGraphCommand = (command: ParsedGraphCommand, idleMs: number) => {
    if (command.kind === 'status') {
      showGraphStatus();
      return;
    }
    if (command.kind === 'history') {
      void runControl(showGraphHistory);
      return;
    }
    if (command.kind === 'set_mode') {
      void runControl(() => setGraphMode(command.mode));
      return;
    }
    if (input.firstRun) {
      void showSetupWizard();
      return;
    }
    lastActivityAt = Date.now();
    promptSeq += 1;
    maybeTriggerAutoRecap(idleMs);
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: 'Using Graph Mode for this turn only.',
    });
    void runAgentTurn({
      kind: 'external',
      prompt: command.task,
      sessionId: input.driver.getSessionId(),
      turnOrchestration: { mode: 'graph', source: 'slash_command' },
    });
  };

  const moveSession = async (targetCwd: string): Promise<void> => {
    if (!input.driver.moveSession) {
      state.entries.push({
        kind: 'notice',
        level: 'error',
        text: 'Moving sessions is not available in this environment.',
      });
      requestRender();
      return;
    }
    const result = await input.driver.moveSession(targetCwd);
    if (!result.changed) {
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: `Session is already at "${result.cwd}".`,
      });
      requestRender();
      return;
    }
    cwd = result.cwd;
    refreshEditorCwd?.(cwd);
    const warning =
      result.oldCwdDirty === true
        ? ` Warning: the old directory "${result.previousCwd}" has uncommitted changes.`
        : '';
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: `Session moved to "${result.cwd}".${warning}`,
    });
    requestRender();
  };

  const showMovePicker = (): void => {
    if (!input.driver.moveSession) {
      state.entries.push({
        kind: 'notice',
        level: 'error',
        text: 'Moving sessions is not available in this environment.',
      });
      requestRender();
      return;
    }
    let overlay: OverlayHandle | undefined;
    const picker = new DirectoryPickerOverlay(tui, {
      currentCwd: cwd,
      basePath: cwd,
      onSubmit: (targetCwd) => {
        overlay?.hide();
        void runControl(() => moveSession(targetCwd));
      },
      onCancel: () => overlay?.hide(),
    });
    overlay = showBottomPicker(picker);
  };

  const showPermissionModeList = () => {
    const items = permissionModePickerItems(permissionMode);
    // Where the cursor opens. It is NOT a claim about the current state —
    // `permissionModePickerItems` marks `current` only on an option that is
    // genuinely in force, so a read-only session marks neither and choosing
    // Auto reads as the permission change it is.
    const cursorValue = permissionMode === 'bypass' ? 'bypass' : 'auto';
    showSelectPicker(
      'Permissions',
      permissionModeLabel(permissionMode),
      items,
      (item) => {
        if (item.value === 'auto' || item.value === 'bypass') {
          requestSandboxBoundaryMode(item.value);
        }
      },
      {
        minPrimaryColumnWidth: 16,
        maxPrimaryColumnWidth: 24,
        selectedIndex: items.findIndex((item) => item.value === cursorValue),
      },
    );
  };

  type TuiSlashCommandId = SlashCommandIdForSurface<'tui'>;
  type TuiSlashCommandHandler = Omit<MakaSlashCommand, 'name' | 'aliases'>;

  const showGoalSummary = () => {
    // Read the live projection at request time: /goal is the one place the
    // user asks for the state *right now*.
    if (!input.driver.getGoal) {
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: 'Goal status is unavailable on this runtime.',
      });
      requestRender();
      return;
    }
    const goal = input.driver.getGoal();
    state.entries.push({
      kind: 'notice',
      level: 'info',
      text: goal ? goalSummaryLines(goal, Date.now()).join('\n') : 'No goal set.',
    });
    requestRender();
  };

  const controlGoalCommand = async (action: GoalControlAction): Promise<void> => {
    const notice = (text: string): void => {
      state.entries.push({ kind: 'notice', level: 'info', text });
      requestRender();
    };
    const goal = input.driver.getGoal?.() ?? null;
    if (!goal) {
      notice('No goal set.');
      return;
    }
    if (!input.driver.controlGoal) {
      notice('Goal control is unavailable on this runtime.');
      return;
    }
    // Pre-validate against the live projection so an invalid transition gets
    // a plain message instead of the host's operation error. These mirror the
    // host's rules exactly: pause requires active|waiting, resume requires
    // paused, clear rejects a terminal record.
    if (action === 'pause' && goal.status !== 'active' && goal.status !== 'waiting') {
      notice(`Cannot pause: the goal is ${goalStatusLabel(goal.status)}.`);
      return;
    }
    if (action === 'resume' && goal.status !== 'paused') {
      notice(`Cannot resume: the goal is ${goalStatusLabel(goal.status)}.`);
      return;
    }
    if (action === 'clear' && !isLiveGoalStatus(goal.status)) {
      notice(`Cannot clear: the goal is ${goalStatusLabel(goal.status)}.`);
      return;
    }
    if (action === 'pause') selfInitiatedPauseGoalId = goal.goalId;
    let result: GoalProjection | null;
    try {
      result = await input.driver.controlGoal(action);
    } catch (error) {
      selfInitiatedPauseGoalId = null;
      throw error; // runControl's reportError surfaces it
    }
    if (result === null) {
      // The goal disappeared to a concurrent controller mid-flight.
      selfInitiatedPauseGoalId = null;
      notice(action === 'clear' ? 'Goal cleared.' : 'The goal no longer exists.');
      return;
    }
    // Keep the transition cache on the authoritative response: a trailing push
    // of this same transition then folds onto an identical previous state and
    // is not mistaken for a fresh one.
    currentGoal = result;
    if (action === 'pause') {
      // Settle the suppression flag: the command's own confirmation has told
      // the user, and a lingering flag would suppress a later host-initiated
      // pause of this goal (e.g. the Ctrl+C auto-pause).
      selfInitiatedPauseGoalId = null;
      notice('Goal paused. /goal resume continues it, /goal clear stops it.');
    } else if (action === 'resume') {
      notice('Goal resumed.');
    } else {
      notice('Goal cleared.');
    }
  };

  const slashCommandHandlers = {
    context: {
      description: primaryGuidance.commands.context,
      // Read-only diagnostics, but runControl-gated: mid-turn it would
      // silently no-op on the busy gate, so refuse loudly instead.
      midTurn: 'refuse',
      run: (parts: string[]) => {
        if (parts.length !== 1) {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: 'Usage: /context',
          });
          requestRender();
          return;
        }
        void runControl(async () => {
          const diagnostics: ContextDiagnostics = input.driver.getContextDiagnostics
            ? await input.driver.getContextDiagnostics()
            : { status: 'unavailable', reason: 'trace_unavailable' };
          state.entries.push({
            kind: 'notice',
            level: 'info',
            text: formatContextDiagnostics(diagnostics),
          });
          requestRender();
        });
      },
    },
    compact: {
      description: primaryGuidance.commands.compact,
      midTurn: 'refuse',
      run: (parts: string[]) => {
        if (parts.length !== 1) {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: 'Usage: /compact',
          });
          requestRender();
          return;
        }
        void runControl(compactSession);
      },
    },
    exit: {
      description: primaryGuidance.commands.exit,
      // isExitPrompt (which also matches bare "quit"/"exit" without a slash)
      // closes the TUI ahead of generic slash routing.
      midTurn: 'intercepted',
      run: () => {
        beginGracefulClose();
      },
    },
    goal: {
      description: primaryGuidance.commands.goal,
      // Read-only status answers locally; control actions carry their own
      // busy notice inside the handler, so neither path no-ops silently.
      midTurn: 'local',
      run: (parts: string[]) => {
        if (parts.length === 1) {
          // Read-only, so no runControl busy gate: an autonomous loop keeps
          // the session busy almost by definition, and that is exactly when
          // the user wants to inspect it.
          showGoalSummary();
          return;
        }
        const action = parts[1];
        if (
          parts.length !== 2 ||
          (action !== 'pause' && action !== 'resume' && action !== 'clear')
        ) {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: 'Usage: /goal [pause|resume|clear]',
          });
          requestRender();
          return;
        }
        // Goal control mutates the durable loop, so it takes the runControl
        // write gate — but say so instead of silently swallowing the command
        // when a turn or another control action owns the session.
        if (busy) {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: 'Cannot control the goal while a turn or another action is running — interrupt it (Esc) or wait for it to finish.',
          });
          requestRender();
          return;
        }
        void runControl(() => controlGoalCommand(action));
      },
    },
    help: {
      description: primaryGuidance.commands.help,
      midTurn: 'refuse',
      run: () => {
        void runControl(async () => showHelp());
      },
    },
    new: {
      description: primaryGuidance.commands.new,
      midTurn: 'refuse',
      run: () => {
        void runControl(async () => newSession());
      },
    },
    skill: {
      description: primaryGuidance.commands.skill,
      midTurn: 'refuse',
      run: (parts: string[]) => {
        if (parts.length !== 1) {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: 'Usage: /skill，或直接在消息中输入 /skill:<name>',
          });
          requestRender();
          return;
        }
        void showSkillList();
      },
    },
    setup: {
      description: primaryGuidance.commands.setup,
      midTurn: 'refuse',
      run: (parts: string[]) => {
        if (parts.length !== 1) {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: 'Usage: /setup',
          });
          requestRender();
          return;
        }
        void showSetupWizard();
      },
    },
    model: {
      description: primaryGuidance.commands.model,
      midTurn: 'refuse',
      run: (parts: string[]) => {
        if (parts.length === 1) {
          showModelList();
          return;
        }
        const nextModel = parts.length === 2 ? parts[1] : undefined;
        if (!nextModel) {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: 'Usage: /model <model-id>',
          });
          requestRender();
          return;
        }
        void runControl(() => setModel(nextModel));
      },
    },
    move: {
      description: primaryGuidance.commands.move,
      midTurn: 'refuse',
      run: (parts: string[], rawTail?: string) => {
        const targetCwd = (rawTail ?? parts.slice(1).join(' ')).trim();
        if (targetCwd) {
          void runControl(() => moveSession(targetCwd));
          return;
        }
        showMovePicker();
      },
    },
    thinking: {
      description: primaryGuidance.commands.thinking,
      midTurn: 'refuse',
      run: (parts: string[]) => {
        if (parts.length === 1) {
          if (thinkingLevels.length === 0) {
            state.entries.push({
              kind: 'notice',
              level: 'info',
              text: '当前模型不支持思考级别切换。',
            });
            requestRender();
            return;
          }
          showThinkingLevelList();
          return;
        }
        const token = parts.length === 2 ? parts[1] : undefined;
        // `off` is a real level now (maps to reasoningEffort:'none' / thinking
        // disabled), not a synonym for 默认. Only `default` clears the override.
        const level = token === 'default' ? undefined : token;
        // Reject levels the current model does not support (P2-1): the picker
        // already restricts to `thinkingLevels`, but the typed command path
        // must too so the statusbar never advertises a level the runtime drops.
        if (level !== undefined && (!isThinkingLevel(level) || !thinkingLevels.includes(level))) {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text:
              thinkingLevels.length === 0
                ? '当前模型不支持思考级别切换。'
                : `Usage: /thinking ${['default', ...thinkingLevels].join('|')}`,
          });
          requestRender();
          return;
        }
        void runControl(() => setThinkingLevel(level));
      },
    },
    transcript: {
      description: primaryGuidance.commands.transcript,
      midTurn: 'local',
      run: (parts: string[]) => {
        if (parts.length !== 1) {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: 'Usage: /transcript',
          });
          requestRender();
          return;
        }
        showTranscriptViewer();
      },
    },
    permissions: {
      description: primaryGuidance.commands.permissions,
      midTurn: 'refuse',
      run: (parts: string[]) => {
        if (parts.length === 1) {
          showPermissionModeList();
          return;
        }
        const mode = parts.length === 2 ? parts[1] : undefined;
        if (mode !== 'auto' && mode !== 'bypass') {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: 'Usage: /permissions auto|bypass',
          });
          requestRender();
          return;
        }
        requestSandboxBoundaryMode(mode);
      },
    },
    recap: {
      description: primaryGuidance.commands.recap,
      // Independent of the running turn: runRecap goes straight to the
      // separate session.recap.generate call behind its own in-flight lock
      // and never enters runControl.
      midTurn: 'local',
      run: () => {
        void runRecap('manual');
      },
    },
    rename: {
      description: primaryGuidance.commands.rename,
      midTurn: 'refuse',
      run: (parts: string[]) => {
        const name = parts.slice(1).join(' ').trim();
        if (!name) {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: 'Usage: /rename <new name>',
          });
          requestRender();
          return;
        }
        void runControl(async () => {
          const renamedName = (await input.driver.renameSession(name)) ?? name;
          setSessionTitle(renamedName);
          state.entries.push({
            kind: 'notice',
            level: 'info',
            text: `Session renamed to "${renamedName}"`,
          });
          requestRender();
        });
      },
    },
    resume: {
      description: primaryGuidance.commands.resume,
      midTurn: 'refuse',
      run: (parts: string[]) => {
        if (parts.length !== 1) {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: 'Usage: /resume',
          });
          requestRender();
          return;
        }
        void runControl(resumeSession);
      },
    },
    rewind: {
      description: primaryGuidance.commands.rewind,
      midTurn: 'refuse',
      run: () => {
        void runControl(showRewindPicker);
      },
    },
    session: {
      description: primaryGuidance.commands.session,
      // View navigation, not a session mutation: mid-turn it detaches from the
      // running Turn instead of touching it (#3380), so it is allowed through
      // where mutating commands are refused.
      midTurn: 'switch',
      run: (parts: string[]) => {
        if (parts.length === 1) {
          void openSessionPicker();
          return;
        }
        const sessionId = parts.length === 2 ? parts[1] : undefined;
        if (!sessionId) {
          state.entries.push({
            kind: 'notice',
            level: 'error',
            text: 'Usage: /session <session-id>',
          });
          requestRender();
          return;
        }
        void goToSession(sessionId);
      },
    },
    graph: {
      description: primaryGuidance.commands.graph,
      // parseGraphCommand answers status and refuses changes ahead of generic
      // slash routing.
      midTurn: 'intercepted',
      run: (_parts: string[], rawTail: string | undefined, context: { idleMs: number }) => {
        const parsed = parseGraphCommand(`/graph${rawTail ? ` ${rawTail}` : ''}`);
        if (parsed) runGraphCommand(parsed, context.idleMs);
      },
    },
    swarm: {
      description: primaryGuidance.commands.swarm,
      // parseSwarmCommand answers status and refuses changes ahead of generic
      // slash routing.
      midTurn: 'intercepted',
      run: (_parts: string[], rawTail: string | undefined, context: { idleMs: number }) => {
        const parsed = parseSwarmCommand(`/swarm${rawTail ? ` ${rawTail}` : ''}`);
        if (parsed) runSwarmCommand(parsed, context.idleMs);
      },
    },
  } satisfies Record<TuiSlashCommandId, TuiSlashCommandHandler>;

  const slashCommands: MakaSlashCommand[] = slashCommandsForSurface('tui').map((spec) => ({
    name: spec.id,
    ...('aliases' in spec ? { aliases: spec.aliases } : {}),
    ...slashCommandHandlers[spec.id],
  }));

  const handleSlashCommand = (prompt: string, idleMs: number): boolean => {
    const trimmed = prompt.trim();
    const commandToken = trimmed.split(/\s+/, 1)[0] ?? '';
    const command = slashCommands.find(
      (candidate) =>
        `/${candidate.name}` === commandToken ||
        candidate.aliases?.some((alias) => `/${alias}` === commandToken),
    );
    if (!command) return false;
    const rawTail = trimmed.slice(commandToken.length).trimStart();
    command.run(trimmed.split(/\s+/), rawTail, { idleMs });
    return true;
  };

  refreshEditorCwd = (nextCwd) => {
    editor.setAutocompleteProvider(
      new MakaAutocompleteProvider(
        input.clientPathAuthority === 'none' ? undefined : nextCwd,
        slashCommands,
        () => listSkillsCached(),
      ),
    );
  };
  refreshEditorCwd(cwd);

  tui.addInputListener((data) => {
    // Track bracketed pastes before any consuming branch: this must observe
    // every chunk the editor could buffer, regardless of what the rest of the
    // listener decides (#3475 review).
    if (data.includes('\x1b[200~')) {
      // A paste begins; it is only complete when the end marker follows, here
      // or in a later chunk.
      editorPastePending = !data.slice(data.indexOf('\x1b[200~') + 6).includes('\x1b[201~');
    } else if (editorPastePending && data.includes('\x1b[201~')) {
      // The paste ends; bytes after the end marker may start another paste.
      const remainder = data.slice(data.indexOf('\x1b[201~') + 6);
      editorPastePending = remainder.includes('\x1b[200~');
    }
    // Once closing has begun, swallow any buffered input that reaches the
    // listener while the terminal is being torn down.
    if (closed) return { consume: true };
    // DEC 1004 focus reports drive the attention layer. Consume them so they
    // never reach the editor as stray input; they are not user keystrokes.
    if (data === FOCUS_IN_SEQUENCE) {
      attention.focusChanged(true);
      return { consume: true };
    }
    if (data === FOCUS_OUT_SEQUENCE) {
      attention.focusChanged(false);
      return { consume: true };
    }
    // Kitty keyboard protocol terminals (Ghostty/Kitty) emit separate press and
    // release events. pi-tui only filters releases on the focused-component
    // path, but this raw listener runs before that, so a release would
    // immediately undo a Ctrl+O/Ctrl+T toggle and a single Escape's
    // press+release pair could count as a double Escape. We never act on
    // releases here; returning undefined lets the TUI apply its own filtering.
    if (isKeyRelease(data)) return undefined;
    if (
      activeUserQuestionRequest(state) &&
      turnRunning &&
      matchesKey(data, Key.ctrl('c')) &&
      !isKeyRepeat(data)
    ) {
      if (interruptRequested) handleProcessExit(0);
      else requestTurnInterrupt();
      return { consume: true };
    }
    if (tui.hasOverlay()) return undefined;
    const pendingSandboxBoundary = activeSandboxBoundaryRequest(state);
    if (pendingSandboxBoundary && !matchesKey(data, Key.ctrl('c'))) {
      if (
        !isKeyRepeat(data) &&
        (matchesKey(data, 'y') || matchesKey(data, Key.enter) || matchesKey(data, Key.return))
      ) {
        respondToPendingSandboxBoundary('allow');
      } else if (!isKeyRepeat(data) && (matchesKey(data, 'n') || matchesKey(data, Key.escape))) {
        respondToPendingSandboxBoundary('deny');
      }
      return { consume: true };
    }
    // Alt+Enter: queue a followup (during a turn) or submit (when idle). Alt+↑:
    // take back the queued messages to re-edit. Neither is an editor binding
    // (newline is shift+enter/ctrl+j; history is plain up), so intercepting
    // here does not collide with the editor's own keys.
    if (matchesKey(data, Key.alt('enter')) && !isKeyRepeat(data)) {
      handleAltEnter();
      return { consume: true };
    }
    if (matchesKey(data, Key.alt('up')) && !isKeyRepeat(data)) {
      // Always retract from the authority: the render mirror lags the
      // queue_update event, so an enqueue followed by Alt+Up in the same
      // tick would see an empty mirror while the runtime holds the message.
      // Alt+Up is not an editor binding, and an empty retract refill is a
      // no-op, so consuming unconditionally loses nothing.
      retractQueuedMessages();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl('c')) && isKeyRepeat(data)) return { consume: true };
    if (!matchesKey(data, Key.ctrl('c'))) lastIdleCtrlCAt = 0;
    // The idle rewind gesture requires two *consecutive* Escapes. Any other key
    // in between breaks it, so a stale first Escape never pairs with a much later
    // one (e.g. `Esc`, type, `Esc`).
    if (!matchesKey(data, Key.escape)) lastIdleEscapeAt = 0;
    if (matchesKey(data, Key.ctrl('o')) && !isKeyRepeat(data)) {
      if (toggleAllToolExpansion(state)) {
        requestRender();
        return { consume: true };
      }
    }
    if (matchesKey(data, Key.ctrl('t')) && !isKeyRepeat(data)) {
      if (toggleAllThinkingExpansion(state)) {
        requestRender();
        return { consume: true };
      }
    }
    if (turnRunning && matchesKey(data, Key.ctrl('c'))) {
      if (interruptRequested) handleProcessExit(0);
      else requestTurnInterrupt();
      return { consume: true };
    }
    // Double Escape interrupts the running turn. This must sit below the
    // boundary branch so Escape keeps meaning "deny" while a prompt is
    // pending, and it only arms while a prompt turn is actually running.
    if (turnRunning && matchesKey(data, Key.escape)) {
      // The mid-turn /session picker owns Escape while it is open — closing
      // it must never arm an interrupt for the Turn being left running.
      if (sessionPickerOverlayOpen) return undefined;
      // Once an interrupt is issued, swallow further Escapes until the turn
      // ends so a still-settling stop is not requested twice. A rejected stop
      // re-arms interruption so the user can retry within the same turn.
      if (interruptRequested) return { consume: true };
      const now = Date.now();
      if (now - lastTurnEscapeAt <= DOUBLE_ESCAPE_INTERRUPT_WINDOW_MS) {
        lastTurnEscapeAt = 0;
        requestTurnInterrupt();
      } else {
        lastTurnEscapeAt = now;
      }
      return { consume: true };
    }
    // Idle double Escape opens the rewind picker (the same gesture that
    // interrupts a running turn). This sits below the turnRunning branch, so it
    // only arms when nothing is running. It engages only when the editor has no
    // Escape work of its own — empty draft, no autocomplete popup — so the
    // editor keeps owning Escape for clearing input and closing autocomplete.
    // The first Escape falls through to the editor; only the second, within the
    // window, consumes and opens the picker.
    if (!busy && !turnRunning && matchesKey(data, Key.escape)) {
      const editorNeutral = editor.getText().length === 0 && !editor.isShowingAutocomplete();
      if (!editorNeutral) {
        lastIdleEscapeAt = 0;
        return undefined;
      }
      const now = Date.now();
      if (lastIdleEscapeAt && now - lastIdleEscapeAt <= DOUBLE_ESCAPE_INTERRUPT_WINDOW_MS) {
        lastIdleEscapeAt = 0;
        void runControl(showRewindPicker);
        return { consume: true };
      }
      lastIdleEscapeAt = now;
      return undefined;
    }
    if (!turnRunning && matchesKey(data, Key.ctrl('c')) && editor.getText().length > 0) {
      lastIdleCtrlCAt = 0;
      editor.setText('');
      requestRender();
      return { consume: true };
    }
    if (!turnRunning && matchesKey(data, Key.ctrl('c'))) {
      const now = Date.now();
      if (lastIdleCtrlCAt && now - lastIdleCtrlCAt <= DOUBLE_CTRL_C_EXIT_WINDOW_MS) {
        lastIdleCtrlCAt = 0;
        handleProcessExit(0);
      } else {
        lastIdleCtrlCAt = now;
        state.entries.push({ kind: 'notice', level: 'info', text: 'Press Ctrl+C again to exit.' });
        requestRender();
      }
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl('d'))) {
      if (busy || turnRunning) return { consume: true };
      if (editor.getText().length === 0) {
        beginGracefulClose();
        return { consume: true };
      }
      return undefined;
    }
    return undefined;
  });

  // Keep older output in the terminal's own scrollback: the transcript is never
  // windowed, so when it shrinks (collapsing tool output, a thinking block
  // re-wrapping) a full clear would wipe the scrollback the user scrolls through.
  // Differential rendering clears the vacated rows without the wipe.
  //
  // The Ctrl+O / Ctrl+T toggles are viewport-anchored for the same reason: an
  // entry above the live viewport lives in terminal scrollback, which cannot
  // be rewritten, so resizing it would push pi-tui's differential renderer
  // into a scrollback-clearing full redraw (its `firstChanged < viewportTop`
  // path). The toggles therefore retarget only entries inside the viewport;
  // see entryInLiveViewport in pi-transcript.ts (#1097). A block whose own
  // expansion pushed its head above the viewport can consequently never be
  // collapsed in place (#1134): the toggles still flip the default and append
  // a notice, and the expanded content stays readable in scrollback.
  tui.setClearOnShrink(false);
  tui.addChild(layout);
  tui.setFocus(editorSurface);
  try {
    tui.start();
    // The AttentionController set the initial title in its constructor. Enable
    // focus reporting so it learns when the terminal is backgrounded; the input
    // listener forwards the `\x1b[I` / `\x1b[O` reports. This must run *after*
    // tui.start() puts the terminal in raw mode — otherwise the terminal's reply
    // to the enable sequence (a focus-in `\x1b[I`) is echoed by the cooked-mode
    // line discipline and leaks onto the screen as a stray `^[[I` on launch.
    terminal.write(ENABLE_FOCUS_REPORTING);
    if (input.firstRun) void showSetupWizard();
  } catch (error) {
    beginClose(error instanceof Error ? error : new Error(String(error)));
  }

  if (input.resumeSessionId) {
    void runControl(async () => {
      try {
        await switchSession(input.resumeSessionId!, input.resumeCwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (input.resumeFailure === 'exit') {
          handleProcessExit(
            1,
            new Error(`Could not resume session ${input.resumeSessionId}: ${message}`),
          );
          return;
        }
        const recoveryHint =
          input.resumeCwd === undefined && message.startsWith('Session cwd no longer exists:')
            ? ` Retry with: ${formatMakaResumeCommand(
                input.cliCommand ?? 'maka',
                input.resumeSessionId!,
                { cwd: '<new-path>' },
              )}.`
            : '';
        state.entries.push({
          kind: 'notice',
          level: 'error',
          text: `Could not resume session ${input.resumeSessionId}: ${message}.${recoveryHint} Starting fresh.`,
        });
        requestRender();
      }
    });
  }

  return closedPromise;
}

const BOTTOM_PICKER_MARGIN_ROWS = 4;

// The editor's autocomplete window height. Keep it at least as large as the
// full slash-command menu, so a bare `/` shows every command rather than
// silently clipping the last command.
const EDITOR_AUTOCOMPLETE_MAX_VISIBLE = 24;

export function formatContextDiagnostics(diagnostics: ContextDiagnostics): string {
  if (diagnostics.status === 'unavailable') {
    return diagnostics.reason === 'no_completed_request'
      ? 'Context unavailable\nNo completed provider request exists for this session.'
      : 'Context unavailable\nProvider request trace data could not be read.';
  }

  const lines = [
    'Context',
    'Latest completed request',
    `${diagnostics.providerId} · ${diagnostics.modelId}`,
    '',
    'Usage',
  ];
  const pushMetric = (label: string, value: string, source: string): void => {
    lines.push(`  ${label}: ${value}`, `    ${source}`);
  };
  pushMetric(
    'Used',
    diagnostics.inputTokens === undefined
      ? 'unavailable'
      : `${formatContextCount(diagnostics.inputTokens)} tokens`,
    diagnostics.inputTokens === undefined ? 'provider report missing' : 'provider-reported',
  );
  pushMetric(
    'Total',
    diagnostics.contextWindow === undefined
      ? 'unavailable'
      : `${formatContextCount(diagnostics.contextWindow)} tokens`,
    diagnostics.contextWindow === undefined
      ? 'request-model snapshot missing'
      : 'request-model snapshot',
  );

  if (diagnostics.inputTokens !== undefined && diagnostics.contextWindow !== undefined) {
    const free = Math.max(0, diagnostics.contextWindow - diagnostics.inputTokens);
    const percent = Math.round((diagnostics.inputTokens / diagnostics.contextWindow) * 100);
    pushMetric('Free', `${formatContextCount(free)} tokens`, 'calculated');
    pushMetric('Share', `${percent}%`, 'calculated');
  } else {
    pushMetric('Free', 'unavailable', 'requires Used and Total');
    pushMetric('Share', 'unavailable', 'requires Used and Total');
  }

  lines.push('', 'Estimated breakdown');
  const composition = diagnostics.composition;
  if (!composition) {
    // The metering record named this request; no capture explained it. Said
    // plainly, because a silent "0 tokens" would read as an empty prompt.
    lines.push('  Unavailable', '    this request left no composition on record');
  } else {
    const labels: Record<(typeof composition.segments)[number]['kind'], string> = {
      system_instructions: 'System instructions',
      tool_definitions: 'Tool definitions',
      messages: 'Messages',
      other: 'Other options',
    };
    for (const segment of composition.segments) {
      lines.push(
        `  ${labels[segment.kind]}: ≈${formatContextCount(estimateContextTokens(segment.bytes))} tokens`,
      );
    }
    // Per tool, because that is the only row a reader can act on: "tool
    // definitions ≈ 40%" names nothing to remove (#2323).
    if (composition.tools && composition.tools.length > 0) {
      lines.push('', 'By tool');
      for (const tool of composition.tools) {
        lines.push(
          `  ${tool.name}: ≈${formatContextCount(estimateContextTokens(tool.bytes))} tokens`,
        );
      }
      if (composition.remainingTools) {
        const remainder = composition.remainingTools;
        lines.push(
          `  ${remainder.count} more tool${remainder.count === 1 ? '' : 's'}: ≈${formatContextCount(estimateContextTokens(remainder.bytes))} tokens`,
        );
      }
    }
    if (composition.unlabelledToolBytes !== undefined) {
      lines.push(
        `  Unnamed tools: ≈${formatContextCount(estimateContextTokens(composition.unlabelledToolBytes))} tokens`,
      );
    }
  }

  if (diagnostics.compaction) {
    const compaction = diagnostics.compaction;
    lines.push(
      '',
      'History compaction',
      `  ${compaction.phase.replace('_', '-')} · ${formatContextCount(compaction.eventCount)} events / ${formatContextCount(compaction.turnCount)} turns`,
      `  ≈${formatContextCount(compaction.estimatedTokens)} tokens · local estimate`,
    );
  } else {
    lines.push('', 'History compaction', '  Unavailable for this request');
  }
  return lines.join('\n');
}

/**
 * The estimate lives here, at the surface that shows it, and prints with a `≈`
 * every time. The Host reports measured bytes; four-bytes-per-token is a rule
 * of thumb over serialized JSON, and one that is wrong for an attachment's
 * base64 in a direction nobody downstream can correct (#2323).
 */
function estimateContextTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function formatContextCount(value: number): string {
  return value.toLocaleString('en-US');
}

function formatAgentGraphHistory(
  graph: AgentGraphClientSnapshot,
  epoch: AgentGraphEpochSummary,
): string {
  const settled = graph.operators.filter((operator) =>
    ['completed', 'failed', 'aborted', 'cancelled'].includes(operator.status),
  ).length;
  const lines = [
    `Agent Graph run #${epoch.epoch}${epoch.current ? ' · Current' : ' · History (read-only)'}`,
    `  ${formatAgentGraphStatus(graph.status)} · ${settled}/${graph.operators.length} operators settled`,
  ];
  for (const operator of graph.operators) {
    lines.push(`  ${operator.agentId}: ${operator.status.replaceAll('_', ' ')}`);
  }
  if (graph.finish) {
    lines.push(`  Selected results: ${graph.finish.resultIds.join(', ') || 'none'}`);
  }
  if (graph.omitted.operators > 0) {
    lines.push(`  ${graph.omitted.operators} more operators omitted`);
  }
  return lines.join('\n');
}

function formatAgentGraphStatus(status: AgentGraphClientSnapshot['status']): string {
  return {
    empty: 'Awaiting schedule',
    active: 'Running',
    closing: 'Finishing',
    waiting: 'Waiting',
    stopped: 'Stopped',
    failed: 'Failed',
    completed: 'Completed',
  }[status];
}

function flattenLinkedSessionTree(
  roots: readonly SessionSummary[],
  childrenByParentId: ReadonlyMap<string, readonly SessionSummary[]>,
): Array<{ session: SessionSummary; depth: number }> {
  const flattened: Array<{ session: SessionSummary; depth: number }> = [];
  const visit = (session: SessionSummary, depth: number): void => {
    flattened.push({ session, depth });
    for (const child of childrenByParentId.get(session.id) ?? []) {
      visit(child, depth + 1);
    }
  };
  for (const root of roots) visit(root, 0);
  return flattened;
}

// A short, stable slice of a session id — enough to tell two same-named
// sessions apart in the picker without showing the full unreadable uuid.
function shortSessionId(id: string): string {
  return id.slice(0, 8);
}

// Matches only the four exact "close the TUI" spellings — bare `quit`/`exit`
// and their slash forms — never a prefix or a phrase merely containing one, so
// it can gate both the idle submit path and mid-turn input without swallowing
// an in-turn steering message that happens to mention "quit".
function isExitPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  return trimmed === 'quit' || trimmed === 'exit' || trimmed === '/quit' || trimmed === '/exit';
}

// Two Escapes this close together read as one deliberate "stop the turn".
const DOUBLE_ESCAPE_INTERRUPT_WINDOW_MS = 600;
const DOUBLE_CTRL_C_EXIT_WINDOW_MS = 1_000;
