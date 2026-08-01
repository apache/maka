import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { QueueEnqueueOutcome, SessionEvent } from '@maka/core/events';
import type { PermissionMode } from '@maka/core/permission';
import type { ExecutionBoundary, SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import { executionBoundaryDisplayMode } from '@maka/core/sandbox-boundary';
import type { UserQuestionResponse } from '@maka/core/user-question';
import type {
  BranchFromTurnInput,
  CreateSessionInput,
  TurnOrchestration,
  UserMessageInput,
} from '@maka/core/runtime-inputs';
import type { OrchestrationMode } from '@maka/core/orchestration';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import { userFacingText } from '@maka/core/session';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type {
  ContextDiagnostics,
  RuntimeContinuation,
  SafeBoundaryContinuationPlan,
} from '@maka/runtime';
import { DEFAULT_SESSION_NAME } from '@maka/core';

const execFileAsync = promisify(execFile);

export interface MakaSessionMoveResult {
  previousCwd: string;
  cwd: string;
  changed: boolean;
  oldCwdDirty?: boolean;
}

export type InspectCwdChanges = (cwd: string) => Promise<boolean | undefined>;

export interface MakaSessionRuntime {
  createSession(input: CreateSessionInput): Promise<SessionSummary>;
  listSessions(): Promise<SessionSummary[]>;
  readExecutionBoundary(sessionId: string): Promise<ExecutionBoundary>;
  getMessages(sessionId: string): Promise<StoredMessage[]>;
  getContextDiagnostics?(sessionId: string): Promise<ContextDiagnostics>;
  sendMessage(sessionId: string, input: UserMessageInput): AsyncIterable<SessionEvent>;
  compactSession(sessionId: string, input?: { turnId?: string }): AsyncIterable<SessionEvent>;
  planLatestAuthoritativeSafeBoundaryContinuation?(
    sessionId: string,
  ): Promise<SafeBoundaryContinuationPlan>;
  resumeSafeBoundaryContinuation?(continuation: RuntimeContinuation): AsyncIterable<SessionEvent>;
  stopSession(sessionId: string, input?: { source?: 'stop_button' }): Promise<void>;
  steer(sessionId: string, text: string): QueueEnqueueOutcome;
  queueMessage(sessionId: string, text: string): QueueEnqueueOutcome;
  drainFollowup(sessionId: string): string | null;
  retractQueue(sessionId: string): string;
  respondToSandboxBoundary(sessionId: string, response: SandboxBoundaryResponse): Promise<void>;
  respondToUserQuestion?(sessionId: string, response: UserQuestionResponse): Promise<void>;
  setPermissionMode(sessionId: string, mode: PermissionMode): Promise<SessionSummary>;
  setOrchestrationMode(sessionId: string, mode: OrchestrationMode): Promise<SessionSummary>;
  updateSession(
    sessionId: string,
    patch: {
      cwd?: string;
      model?: string;
      llmConnectionSlug?: string;
      thinkingLevel?: ThinkingLevel | undefined;
      name?: string;
    },
  ): Promise<SessionSummary>;
  // Rewind reuses the runtime's branch primitives: a non-destructive copy of the
  // transcript + RuntimeEvent ledger at a turn boundary, so resume correctness is
  // inherited and the original session's log is left intact. `branchBeforeTurn`
  // is the exclusive dual — it keeps everything strictly before the turn.
  branchFromTurn(sessionId: string, input: BranchFromTurnInput): Promise<SessionSummary>;
  branchBeforeTurn(sessionId: string, input: BranchFromTurnInput): Promise<SessionSummary>;
}

/** A turn the user can rewind to: its id plus a one-line label (its prompt). */
export interface RewindTarget {
  turnId: string;
  label: string;
}

/**
 * A rewind result: the branched session's summary + messages (as with a switch),
 * plus the chosen turn's full prompt so the caller can refill the editor for the
 * user to edit and resend.
 */
export interface MakaSessionRewindResult extends MakaSessionSwitchResult {
  prompt: string;
}

export interface MakaSessionDriverInput {
  runtime: MakaSessionRuntime;
  cwd: string;
  llmConnectionSlug: string;
  model: string;
  permissionMode?: PermissionMode;
  orchestrationMode?: OrchestrationMode;
  newId?: () => string;
  inspectCwdChanges?: InspectCwdChanges;
}

export interface MakaSessionSwitchResult {
  summary: SessionSummary;
  messages: StoredMessage[];
}

export interface MakaPreparedSessionTurn {
  sessionId: string;
  turnId: string;
  events: AsyncIterable<SessionEvent>;
}

export interface MakaPreparePromptOptions {
  /** Caller-owned identity used when Goal admission reserves a turn synchronously. */
  turnId?: string;
  /** Model-facing text when it differs from the prompt shown to the user. */
  modelText?: string;
  /** Trusted per-turn orchestration override; never encoded into prompt text. */
  turnOrchestration?: TurnOrchestration;
}

export interface MakaSessionDriver {
  listSessions(): Promise<SessionSummary[]>;
  getSessionResumeAvailability?(session: SessionSummary): Promise<SessionResumeAvailability>;
  /**
   * Prepare a turn without consuming its event stream. `prompt` remains the
   * human-facing text; a distinct `modelText` is persisted with `displayText`.
   */
  preparePrompt(
    prompt: string,
    options?: MakaPreparePromptOptions,
  ): Promise<MakaPreparedSessionTurn>;
  compactSession(): AsyncIterable<SessionEvent>;
  resumeLatest?(): AsyncIterable<SessionEvent>;
  /**
   * Queue the text for mid-turn injection at the next step boundary. Returns
   * `fallback` when there is no active run (the turn just ended); the caller
   * should open a fresh turn with the text instead so it is never dropped.
   * Optional so existing driver stubs need not implement the steering surface.
   */
  steer?(text: string): QueueEnqueueOutcome;
  /** Queue the text to open the turn after the current one finishes. */
  queueMessage?(text: string): QueueEnqueueOutcome;
  /** Drain the followup queue into one `\n\n`-joined prompt, or null if empty. */
  takePendingFollowup?(): string | null;
  /** Take back every queued message as one `\n\n`-joined string (clears both queues). */
  retractQueued?(): string;
  respondToSandboxBoundary(response: SandboxBoundaryResponse): Promise<void>;
  respondToUserQuestion?(response: UserQuestionResponse): Promise<void>;
  /**
   * Switch the active session's model, optionally rebinding it to another
   * connection at the same time (cross-provider `/model`). The next turn builds
   * a fresh backend on the new connection.
   */
  setModel(model: string, connectionSlug?: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel | undefined): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** Available on Runtime-backed drivers; optional for lightweight host adapters. */
  setOrchestrationMode?(mode: OrchestrationMode): Promise<void>;
  renameSession(name: string): Promise<string | void>;
  moveSession?(cwd: string): Promise<MakaSessionMoveResult>;
  switchSession(sessionId: string): Promise<MakaSessionSwitchResult>;
  /** Every prompted turn the user can rewind to, newest first. */
  listRewindTargets(): Promise<RewindTarget[]>;
  /**
   * Rewind to a turn: branch the session to the state just *before* that turn
   * (discarding it and everything after), switch onto the branch, and return the
   * turn's prompt so the caller can refill the editor for an edit-and-resend.
   */
  rewindToTurn(turnId: string): Promise<MakaSessionRewindResult>;
  /** Abandon the active session so the next prompt starts a fresh one. */
  startNewSession(): void;
  stop(): Promise<void>;
  getSessionId(): string | null;
  getContextDiagnostics?(): Promise<ContextDiagnostics>;
  getOrchestrationMode?(): OrchestrationMode;
  /**
   * The permission mode the ACTIVE session should be presented as, derived
   * from its authoritative execution boundary (#1611). Available on
   * Runtime-backed drivers; hosts without a boundary to read fall back to the
   * summary they already hand the caller.
   */
  getPermissionMode?(): PermissionMode;
}

export type SessionResumeAvailability = { available: true } | { available: false; reason: string };

const MISSING_SESSION_CWD_REASON = 'Missing working directory';
const DELETED_SESSION_CWD_REASON = 'Working directory no longer exists';

export async function inspectSessionResumeAvailability(
  session: SessionSummary,
): Promise<SessionResumeAvailability> {
  if (!session.cwd) return { available: false, reason: MISSING_SESSION_CWD_REASON };
  try {
    await realpath(session.cwd);
    return { available: true };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { available: false, reason: DELETED_SESSION_CWD_REASON };
    }
    throw error;
  }
}

export function createMakaSessionDriver(input: MakaSessionDriverInput): MakaSessionDriver {
  return new RuntimeMakaSessionDriver(input);
}

class RuntimeMakaSessionDriver implements MakaSessionDriver {
  private sessionId: string | null = null;
  private cwd: string;
  private model: string;
  // The connection the active/next session runs on. Mutable so a cross-provider
  // /model switch can rebind it; new sessions are created on this connection.
  private llmConnectionSlug: string;
  private thinkingLevel: ThinkingLevel | undefined;
  /** The mode the NEXT created session is given. */
  private permissionMode: PermissionMode;
  /**
   * How the ACTIVE session must be presented (#1611): derived from its
   * execution boundary, which is the authority on what it may actually do.
   * Kept apart from `permissionMode` on purpose — a resumed read-only session
   * must read as read-only without making read-only the default for the next
   * session started with `/new`.
   */
  private activeBoundaryDisplayMode: PermissionMode | undefined;
  private orchestrationMode: OrchestrationMode;
  private readonly newId: () => string;

  constructor(private readonly input: MakaSessionDriverInput) {
    this.newId = input.newId ?? randomUUID;
    this.cwd = input.cwd;
    this.model = input.model;
    this.llmConnectionSlug = input.llmConnectionSlug;
    this.permissionMode = input.permissionMode ?? 'ask';
    this.orchestrationMode = input.orchestrationMode ?? 'default';
  }

  async preparePrompt(
    prompt: string,
    options: MakaPreparePromptOptions = {},
  ): Promise<MakaPreparedSessionTurn> {
    const sessionId = await this.ensureSession();
    const turnId = options.turnId ?? this.newId();
    const modelText = options.modelText ?? prompt;
    const events = this.input.runtime.sendMessage(sessionId, {
      turnId,
      text: modelText,
      ...(modelText !== prompt ? { displayText: prompt } : {}),
      ...(options.turnOrchestration ? { turnOrchestration: options.turnOrchestration } : {}),
    });
    return {
      sessionId,
      turnId,
      events,
    };
  }

  async *compactSession(): AsyncIterable<SessionEvent> {
    if (!this.sessionId) throw new Error('Cannot compact before a session starts.');
    yield* this.input.runtime.compactSession(this.sessionId, { turnId: this.newId() });
  }

  async getContextDiagnostics(): Promise<ContextDiagnostics> {
    if (!this.sessionId) return { status: 'unavailable', reason: 'no_completed_request' };
    const read = this.input.runtime.getContextDiagnostics;
    return read
      ? read.call(this.input.runtime, this.sessionId)
      : { status: 'unavailable', reason: 'trace_unavailable' };
  }

  async *resumeLatest(): AsyncIterable<SessionEvent> {
    if (!this.sessionId) throw new Error('Cannot resume before a session starts.');
    const planLatest = this.input.runtime.planLatestAuthoritativeSafeBoundaryContinuation;
    const resume = this.input.runtime.resumeSafeBoundaryContinuation;
    if (!planLatest || !resume)
      throw new Error('Safe-boundary resume is unavailable on this runtime.');
    const plan = await planLatest.call(this.input.runtime, this.sessionId);
    if (plan.disposition !== 'continue' || !plan.continuation) {
      const detail =
        plan.diagnostics.map((diagnostic) => diagnostic.message).join('; ') ||
        plan.rejectionReasons.join(', ') ||
        'no safe continuation candidate exists';
      throw new Error(`Safe-boundary resume parked: ${detail}`);
    }
    yield* resume.call(this.input.runtime, plan.continuation);
  }

  async listSessions(): Promise<SessionSummary[]> {
    return (await this.input.runtime.listSessions())
      .map((session, index) => ({ session, index }))
      .sort((left, right) => {
        const cwdDelta = cwdRank(left.session, this.cwd) - cwdRank(right.session, this.cwd);
        return cwdDelta !== 0 ? cwdDelta : left.index - right.index;
      })
      .map(({ session }) => session);
  }

  async getSessionResumeAvailability(session: SessionSummary): Promise<SessionResumeAvailability> {
    return inspectSessionResumeAvailability(session);
  }

  async stop(): Promise<void> {
    if (!this.sessionId) return;
    await this.input.runtime.stopSession(this.sessionId, { source: 'stop_button' });
  }

  steer(text: string): QueueEnqueueOutcome {
    if (!this.sessionId) return { kind: 'fallback' };
    return this.input.runtime.steer(this.sessionId, text);
  }

  queueMessage(text: string): QueueEnqueueOutcome {
    if (!this.sessionId) return { kind: 'fallback' };
    return this.input.runtime.queueMessage(this.sessionId, text);
  }

  takePendingFollowup(): string | null {
    if (!this.sessionId) return null;
    return this.input.runtime.drainFollowup(this.sessionId);
  }

  retractQueued(): string {
    if (!this.sessionId) return '';
    return this.input.runtime.retractQueue(this.sessionId);
  }

  async respondToSandboxBoundary(response: SandboxBoundaryResponse): Promise<void> {
    if (!this.sessionId) throw new Error('Cannot respond to permission before a session starts.');
    await this.input.runtime.respondToSandboxBoundary(this.sessionId, response);
  }

  async respondToUserQuestion(response: UserQuestionResponse): Promise<void> {
    if (!this.sessionId)
      throw new Error('Cannot respond to a user question before a session starts.');
    if (!this.input.runtime.respondToUserQuestion)
      throw new Error('User questions are unavailable on this runtime.');
    await this.input.runtime.respondToUserQuestion(this.sessionId, response);
  }

  async setModel(model: string, connectionSlug?: string): Promise<void> {
    // Only rebind the connection when a different one is asked for; a same-slug
    // /model is a plain model change and must not churn the backend needlessly.
    const nextConnection =
      connectionSlug && connectionSlug !== this.llmConnectionSlug ? connectionSlug : undefined;
    if (this.sessionId) {
      // Switching model (or connection) clears the per-model thinking variant.
      const summary = await this.input.runtime.updateSession(this.sessionId, {
        model,
        thinkingLevel: undefined,
        ...(nextConnection ? { llmConnectionSlug: nextConnection } : {}),
      });
      this.model = summary.model;
      this.llmConnectionSlug = summary.llmConnectionSlug;
      this.thinkingLevel = summary.thinkingLevel;
      return;
    }
    this.model = model;
    if (nextConnection) this.llmConnectionSlug = nextConnection;
    this.thinkingLevel = undefined;
  }

  async setThinkingLevel(level: ThinkingLevel | undefined): Promise<void> {
    if (this.sessionId) {
      const summary = await this.input.runtime.updateSession(this.sessionId, {
        thinkingLevel: level,
      });
      this.thinkingLevel = summary.thinkingLevel;
      return;
    }
    this.thinkingLevel = level;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.sessionId) {
      const summary = await this.input.runtime.setPermissionMode(this.sessionId, mode);
      this.permissionMode = summary.permissionMode;
      // An explicit switch replaces the boundary, so re-derive rather than
      // assume the requested mode landed exactly as asked.
      this.activeBoundaryDisplayMode = executionBoundaryDisplayMode(
        await this.input.runtime.readExecutionBoundary(this.sessionId),
      );
      return;
    }
    this.permissionMode = mode;
  }

  async setOrchestrationMode(mode: OrchestrationMode): Promise<void> {
    if (this.sessionId) {
      const summary = await this.input.runtime.setOrchestrationMode(this.sessionId, mode);
      this.orchestrationMode = summary.orchestrationMode ?? mode;
      return;
    }
    this.orchestrationMode = mode;
  }

  async renameSession(name: string): Promise<string> {
    if (!this.sessionId) throw new Error('Cannot rename before a session starts.');
    return (await this.input.runtime.updateSession(this.sessionId, { name })).name;
  }

  async moveSession(rawCwd: string): Promise<MakaSessionMoveResult> {
    if (!this.sessionId) throw new Error('Cannot move before a session starts.');
    const nextCwd = await resolveMoveCwd(rawCwd, this.cwd);
    const previousCwd = this.cwd;
    if (nextCwd === previousCwd) {
      return { previousCwd, cwd: nextCwd, changed: false, oldCwdDirty: false };
    }
    const inspectCwdChanges = this.input.inspectCwdChanges ?? inspectGitCwdChanges;
    const oldCwdDirty = await inspectCwdChanges(previousCwd).catch(() => undefined);
    const summary = await this.input.runtime.updateSession(this.sessionId, {
      cwd: nextCwd,
    });
    this.cwd = summary.cwd ?? nextCwd;
    return { previousCwd, cwd: this.cwd, changed: true, oldCwdDirty };
  }

  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    const summary = (await this.listSessions()).find((session) => session.id === sessionId);
    if (!summary) throw new Error(`Session not found: ${sessionId}`);
    const availability = await inspectSessionResumeAvailability(summary);
    if (!availability.available) {
      if (!summary.cwd) throw new Error('Session has no working directory and cannot be resumed.');
      throw new Error(`Session cwd no longer exists: ${summary.cwd}`);
    }
    const sessionCwd = summary.cwd!;
    const boundary = await this.input.runtime.readExecutionBoundary(summary.id);
    if (boundary.kind === 'external') {
      throw new Error(
        `Cannot resume externally isolated session ${summary.id} outside its owning harness.`,
      );
    }
    // #1611: the boundary — not the stored header mode — decides how this
    // session is presented, and the summary is left exactly as the runtime
    // returned it. Overwriting `summary.permissionMode` here used to label a
    // read-only session "Auto", which the picker then marked as the current
    // option; choosing that "current" option silently replaced the read-only
    // boundary with a writable one.
    const displayMode = executionBoundaryDisplayMode(boundary);
    const messages = await this.input.runtime.getMessages(summary.id);
    this.sessionId = summary.id;
    this.cwd = sessionCwd;
    this.model = summary.model;
    this.llmConnectionSlug = summary.llmConnectionSlug;
    this.thinkingLevel = summary.thinkingLevel;
    this.activeBoundaryDisplayMode = displayMode;
    // New sessions started after this one still default to a normal mode.
    this.permissionMode = boundary.kind === 'bypass' ? 'bypass' : 'ask';
    this.orchestrationMode = summary.orchestrationMode ?? 'default';
    return { summary, messages };
  }

  async listRewindTargets(): Promise<RewindTarget[]> {
    if (!this.sessionId) return [];
    const messages = await this.input.runtime.getMessages(this.sessionId);
    // One target per turn that has a user prompt, in send order. The prompt text
    // is the label — it is what the user recognizes a turn by. Rewinding to a
    // turn resets to just *before* it (see rewindToTurn), so the latest turn is
    // itself a valid target (undo it, edit its prompt, resend) and no turn is
    // excluded. Turns with no user prompt (e.g. a /compact turn) never appear.
    const promptByTurn = new Map<string, string>();
    const order: string[] = [];
    for (const message of messages) {
      if (message.type !== 'user' || promptByTurn.has(message.turnId)) continue;
      promptByTurn.set(message.turnId, userFacingText(message));
      order.push(message.turnId);
    }
    return order
      .reverse()
      .map((turnId) => ({ turnId, label: firstLine(promptByTurn.get(turnId) ?? '') }));
  }

  async rewindToTurn(turnId: string): Promise<MakaSessionRewindResult> {
    if (!this.sessionId) throw new Error('Cannot rewind before a session starts.');
    // Read the turn's prompt from the *original* session before branching — the
    // branch drops this turn, so it must be captured first. The full text (not
    // the one-line label) is refilled into the editor for an edit-and-resend.
    const messages = await this.input.runtime.getMessages(this.sessionId);
    const userMessage = messages.find(
      (message): message is Extract<StoredMessage, { type: 'user' }> =>
        message.type === 'user' && message.turnId === turnId,
    );
    if (userMessage === undefined)
      throw new Error(`Cannot rewind to turn ${turnId}: no user prompt.`);
    const prompt = userFacingText(userMessage);
    // Branch to the state just before the turn (copies transcript + ledger up to,
    // but not including, it), then switch onto the branch. switchSession
    // re-validates folder/connection and loads the branched messages, so the
    // branch inherits the same resume guarantees as any resumed session and the
    // original session — including the discarded turn — is left untouched.
    const branch = await this.input.runtime.branchBeforeTurn(this.sessionId, {
      sourceTurnId: turnId,
    });
    return { ...(await this.switchSession(branch.id)), prompt };
  }

  startNewSession(): void {
    // Drop the active session id only. The current model / thinking / permission
    // stay put, so the next prompt lazily creates a fresh session that inherits
    // them (via ensureSession). The old session is left intact on disk.
    this.sessionId = null;
    // The previous session's boundary says nothing about the next one.
    this.activeBoundaryDisplayMode = undefined;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getOrchestrationMode(): OrchestrationMode {
    return this.orchestrationMode;
  }

  getPermissionMode(): PermissionMode {
    return this.activeBoundaryDisplayMode ?? this.permissionMode;
  }

  private async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const session = await this.input.runtime.createSession({
      cwd: this.cwd,
      name: DEFAULT_SESSION_NAME,
      backend: 'ai-sdk',
      llmConnectionSlug: this.llmConnectionSlug,
      model: this.model,
      permissionMode: this.permissionMode,
      ...(this.orchestrationMode !== 'default'
        ? { orchestrationMode: this.orchestrationMode }
        : {}),
      ...(this.thinkingLevel !== undefined ? { thinkingLevel: this.thinkingLevel } : {}),
    });
    this.sessionId = session.id;
    return session.id;
  }
}

async function resolveMoveCwd(rawCwd: string, currentCwd: string): Promise<string> {
  const input = rawCwd.trim();
  if (!input) throw new Error('Working directory cannot be empty.');
  const unquoted =
    input.length >= 2 &&
    ((input.startsWith('"') && input.endsWith('"')) ||
      (input.startsWith("'") && input.endsWith("'")))
      ? input.slice(1, -1)
      : input;
  const expanded =
    unquoted === '~'
      ? homedir()
      : unquoted.startsWith('~/')
        ? resolve(homedir(), unquoted.slice(2))
        : unquoted;
  const candidate = resolve(currentCwd, expanded);
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`Working directory does not exist: ${candidate}`);
    }
    throw error;
  }
  const details = await stat(canonical);
  if (!details.isDirectory()) throw new Error(`Working directory is not a directory: ${canonical}`);
  return canonical;
}

async function inspectGitCwdChanges(cwd: string): Promise<boolean | undefined> {
  try {
    const result = await execFileAsync(
      'git',
      ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '--untracked-files=normal'],
      {
        cwd,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 5_000,
      },
    );
    return result.stdout.trim().length > 0;
  } catch {
    // A non-git directory, inaccessible repository, or a git timeout should
    // never prevent a successful move. The warning is best-effort by design.
    return undefined;
  }
}

function cwdRank(session: SessionSummary, cwd: string): number {
  return session.cwd === cwd ? 0 : 1;
}

/** First non-empty line of a prompt, for a compact rewind-target label. */
function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? '(empty prompt)';
}
