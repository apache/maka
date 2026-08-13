import { constants as osConstants } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { encodeTerminalInputActions } from '@maka/core/terminal-input';
import {
  isActiveShellRunStatus,
  isShellRunSourceToolCallId,
  isTerminalShellRunStatus,
  SHELL_RUN_SOURCE_TOOL_CALL_ID_MAX_BYTES,
  type ShellMode,
  type ShellOutput,
  type ShellRunPatch,
  type ShellRunRecord,
} from '@maka/core/shell-run';
import { TerminalMouseInputRejectedError } from '@maka/core/terminal-mouse-input';
import { type ShellRunSnapshotResult, type ShellRunUpdate } from '@maka/core/events';
import type { ToolResultContent } from '@maka/core/events';
import { redactSecrets } from '@maka/core/redaction';

import {
  BASH_MAX_LIVE_EMIT_CHARS,
  BASH_MAX_RETAINED_CHARS,
  LIVE_OUTPUT_SUPPRESSED_MARKER,
} from './shell-exec.js';
import {
  DEFAULT_PROCESS_TERMINATION_GRACE_MS,
  terminateProcessTree,
  type ProcessTerminationSignal,
} from './process-tree-terminator.js';
import { buildPtyShellSpawnPlan, buildShellSpawnPlan, defaultShellPlan } from './shell-detect.js';
import { PipeProcessDriver, type PipeProcessExit } from './pipe-process-driver.js';
import { PipeTailCollector } from './pipe-tail-collector.js';
import { PtyProcessDriver, type PtyProcessExit } from './pty-process-driver.js';
import {
  PTY_INITIAL_COLS,
  PTY_INITIAL_ROWS,
  PtyScreenCollector,
  type PtySnapshotAtCut,
} from './pty-screen-collector.js';
import { loadPtyStack, type PtyStack } from './pty-stack.js';
import {
  DEFAULT_BASH_TIMEOUT_MS,
  DEFAULT_MAX_LIVE_PTY_RUNS,
  DEFAULT_MAX_LIVE_SHELL_RUNS,
  DEFAULT_PIPE_OUTPUT_DRAIN_MS,
  DEFAULT_SHELL_RUN_FLUSH_BYTES,
  DEFAULT_SHELL_RUN_FLUSH_INTERVAL_MS,
  MAX_FOREGROUND_BASH_TIMEOUT_MS,
  MAX_SHELL_RUN_TIMEOUT_MS,
  SHELL_RUN_CONTEXT_SUMMARY_LIMIT,
  ShellRunPtyControlClosedError,
  parseShellRunResourceRef,
  shellRunResourceRef,
  validateWriteStdinInput,
  type BackgroundTaskStopper,
  type PtyControlWriter,
  type RuntimeResourceReader,
  type ShellRunBashInput,
  type ShellRunPtyDataEvent,
  type ShellRunPtySnapshot,
  type ShellRunProcessManagerInput,
  type ShellRunWriteInput,
} from './shell-run-contract.js';
import {
  compactShellRunContent,
  ptyControlOperation,
  shellRunContent,
  shellRunUpdate,
  terminalContent,
  type ShellRunToolResult,
  type TerminalToolResult,
} from './shell-run-tool-result.js';
import { CompletionLatch } from './completion-latch.js';
import { closeChildFdSources } from './child-fd-input.js';

type LifecycleCause = 'timeout' | 'cancel' | 'shutdown';
const PTY_RAW_REPLAY_CHARS = 16_000;
const PTY_RAW_PUBLISH_INTERVAL_MS = 16;
const PTY_RAW_INPUT_CHUNK_CODE_POINTS = 4_096;
const PTY_RAW_PUBLISH_TARGET_BYTES = 32 * 1024;
const PTY_RAW_PUBLISH_MAX_BYTES = 40 * 1024;

/**
 * Shown whenever a `ref` argument does not parse. Echoing the rejected string
 * back taught the model nothing (and could carry command text back into the
 * transcript); the canonical shape and where to obtain it are the only useful
 * reply. Keep this in sync with the `ref` description in shell-tools.ts.
 *
 * `Read({ ref })` reaches this through `resourceDetail`, not through
 * `stopBackgroundTask`: `classifyRuntimeResourceRef` waves through anything
 * shaped `maka://runtime/<something>`, so a mistyped path segment gets all the
 * way here. That is the likeliest place to mistype a ref, and it was the one
 * still echoing.
 */
const BACKGROUND_TASK_REF_HELP =
  'That is not a runtime background task ref. Use the ref exactly as it was returned when the ' +
  'background task started — the form is maka://runtime/background-tasks/<id>.';

/**
 * The model reads {@link BACKGROUND_TASK_REF_HELP}; an operator reads the
 * `cause`. Dropping the rejected string outright would have made three call
 * sites indistinguishable in a log, so it travels the way `builtin-tools.ts`
 * carries its worker-protocol violations: out of the transcript, in every
 * stack.
 */
function backgroundTaskRefError(ref: string): Error {
  return new Error(BACKGROUND_TASK_REF_HELP, {
    cause: new Error(`Unsupported runtime background task ref: ${ref}`),
  });
}
type DriverExit =
  | { mode: 'pipes'; value: PipeProcessExit }
  | { mode: 'pty'; value: PtyProcessExit };

interface TerminationLifecycle {
  initialDecision: CompletionLatch<void>;
  initialSignal: CompletionLatch<boolean>;
  finished: CompletionLatch<void>;
}

type PendingStopOutcome = 'abort' | 'termination' | 'exit';

class PendingStop {
  private readonly decision = new CompletionLatch<PendingStopOutcome>();
  private outcome: PendingStopOutcome | undefined;
  private readonly onAbort = () => this.settle('abort');

  constructor(private readonly abortSignal: AbortSignal) {
    if (abortSignal.aborted) this.settle('abort');
    else abortSignal.addEventListener('abort', this.onAbort, { once: true });
  }

  current(): PendingStopOutcome | undefined {
    return this.outcome;
  }

  settle(outcome: PendingStopOutcome): void {
    if (this.outcome) return;
    this.outcome = outcome;
    this.abortSignal.removeEventListener('abort', this.onAbort);
    this.decision.resolve(outcome);
  }

  wait(): Promise<PendingStopOutcome> {
    return this.decision.join();
  }

  dispose(): void {
    this.abortSignal.removeEventListener('abort', this.onAbort);
  }
}

interface LiveShellRunBase {
  shellRunId: string;
  sessionId: string;
  mode: ShellMode;
  timeoutMs?: number;
  record: ShellRunRecord;
  visibleRef: boolean;
  driverExit?: DriverExit;
  lifecycleCause?: LifecycleCause;
  integrityFailure?: Error;
  termination?: TerminationLifecycle;
  pendingStops: Set<PendingStop>;
  cancelTimeout?: () => void;
  cancelFlush?: () => void;
  flushInFlight?: Promise<ShellRunRecord>;
  persistChain: Promise<void>;
  persistFailure?: Error;
  lastPersistedGeneration: number;
  lastSnapshotWallTime: number;
  finalizeOnce?: Promise<ShellRunRecord>;
  slotReservation: ShellRunSlotReservation;
  rootExited: boolean;
  nativeRootExit: CompletionLatch<void>;
  startupSettled: CompletionLatch<void>;
  finished: CompletionLatch<ShellRunRecord>;
  onCompletion?: (outcome: { successful: boolean }) => void;
  completionNotified: boolean;
}

interface ShellRunSlotReservation {
  mode: ShellMode;
  released: boolean;
}

interface LivePipeShellRun extends LiveShellRunBase {
  mode: 'pipes';
  driver: PipeProcessDriver;
  collector: PipeTailCollector;
  pendingFlushChars: number;
  forwardLive: boolean;
  liveEmitted: Record<'stdout' | 'stderr', number>;
  liveSuppressed: Record<'stdout' | 'stderr', boolean>;
  emitOutput: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

interface LivePtyShellRun extends LiveShellRunBase {
  mode: 'pty';
  driver: PtyProcessDriver;
  collector: PtyScreenCollector;
  rawBuffer: string;
  rawSequence: number;
  pendingRawData: string;
  rawPublishTimer?: NodeJS.Timeout;
}

type LiveShellRun = LivePipeShellRun | LivePtyShellRun;
type PersistPatch = Omit<ShellRunPatch, 'output' | 'updatedAt'>;

interface SnapshotAtCut {
  output: ShellOutput;
  generation: number;
}

interface PersistOptions {
  allowLastGood?: boolean;
  bestEffort?: boolean;
  snapshotBarrier?: Promise<SnapshotAtCut | undefined>;
}

interface SessionCloseLease {
  readonly sessionId: string;
  readonly token: symbol;
}

export class ShellRunProcessManager
  implements RuntimeResourceReader, BackgroundTaskStopper, PtyControlWriter
{
  private readonly live = new Map<string, LiveShellRun>();
  private readonly sessionCloseLeases = new Map<string, Set<symbol>>();
  private readonly sessionTerminationEpochs = new Map<string, number>();
  private readonly pendingStartups = new Map<string, Set<Promise<void>>>();
  private readonly startupOwners = new Set<string>();
  private readonly maxLiveShellRuns: number;
  private readonly maxLivePtyRuns: number;
  private readonly flushIntervalMs: number;
  private readonly flushBytes: number;
  private readonly maxRetainedChars: number;
  private readonly maxLiveEmitChars: number;
  private readonly killGraceMs: number;
  private readonly exitAcknowledgementMs: number;
  private readonly pipeOutputDrainMs: number;
  private readonly scheduleFlush: (run: () => void, delayMs: number) => () => void;
  private readonly scheduleTimeout: (run: () => void, delayMs: number) => () => void;
  private reservedShellRuns = 0;
  private reservedPtyRuns = 0;
  private shuttingDown = false;

  constructor(private readonly input: ShellRunProcessManagerInput) {
    this.maxLiveShellRuns = input.maxLiveShellRuns ?? DEFAULT_MAX_LIVE_SHELL_RUNS;
    this.maxLivePtyRuns = input.maxLivePtyRuns ?? DEFAULT_MAX_LIVE_PTY_RUNS;
    this.flushIntervalMs = input.flushIntervalMs ?? DEFAULT_SHELL_RUN_FLUSH_INTERVAL_MS;
    this.flushBytes = input.flushBytes ?? DEFAULT_SHELL_RUN_FLUSH_BYTES;
    this.maxRetainedChars = input.maxRetainedChars ?? BASH_MAX_RETAINED_CHARS;
    this.maxLiveEmitChars = input.maxLiveEmitChars ?? BASH_MAX_LIVE_EMIT_CHARS;
    this.killGraceMs = input.killGraceMs ?? DEFAULT_PROCESS_TERMINATION_GRACE_MS;
    this.exitAcknowledgementMs =
      input.exitAcknowledgementMs ?? DEFAULT_PROCESS_TERMINATION_GRACE_MS;
    this.pipeOutputDrainMs = input.pipeOutputDrainMs ?? DEFAULT_PIPE_OUTPUT_DRAIN_MS;
    this.scheduleFlush =
      input.scheduleFlush ??
      ((run, delayMs) => {
        const timer = setTimeout(run, delayMs);
        return () => clearTimeout(timer);
      });
    this.scheduleTimeout =
      input.scheduleTimeout ??
      ((run, delayMs) => {
        const timer = setTimeout(run, delayMs);
        return () => clearTimeout(timer);
      });
  }

  async runBackgroundBash(input: ShellRunBashInput): Promise<ShellRunToolResult> {
    const onCompletion = onceShellRunCompletion(input.onCompletion);
    const ownedInput = onCompletion ? { ...input, onCompletion } : input;
    try {
      validateSourceToolCallId(input.sourceToolCallId);
      return await this.withPendingStartup(input.sessionId, async () => {
        if (input.abortSignal?.aborted)
          throw abortError('Command aborted before shell process started');
        const mode: ShellMode = input.pty ? 'pty' : 'pipes';
        const timeoutMs = normalizeBackgroundTimeoutMs(input.timeoutMs);
        const live = await this.start(ownedInput, mode, timeoutMs, false);
        const record = await this.persistObservation(live);
        if (input.abortSignal?.aborted) {
          this.requestForcedTermination(live, 'cancel');
          return shellRunContent(await this.markObserved(await live.finished.join()));
        }
        live.visibleRef = true;
        let handoffRecord = live.record.revision >= record.revision ? live.record : record;
        if (isTerminalShellRunStatus(handoffRecord.status)) {
          handoffRecord = await this.markObserved(handoffRecord);
        }
        this.notifyShellRunUpdate(handoffRecord);
        return isTerminalShellRunStatus(handoffRecord.status)
          ? shellRunContent(handoffRecord)
          : compactShellRunContent(handoffRecord);
      });
    } catch (error) {
      notifyFailedStartup(onCompletion);
      throw error;
    }
  }

  async runForegroundBash(input: ShellRunBashInput): Promise<TerminalToolResult> {
    const onCompletion = onceShellRunCompletion(input.onCompletion);
    const ownedInput = onCompletion ? { ...input, onCompletion } : input;
    let live: LiveShellRun | undefined;
    const cancel = () => {
      if (live) this.requestForcedTermination(live, 'cancel');
    };
    input.abortSignal?.addEventListener('abort', cancel, { once: true });
    try {
      validateSourceToolCallId(input.sourceToolCallId);
      return await this.withPendingStartup(input.sessionId, async () => {
        if (input.pty)
          throw new Error('Foreground Bash does not support PTY mode; set run_in_background=true');
        if (input.abortSignal?.aborted)
          throw abortError('Command aborted before shell process started');
        const timeoutMs = normalizeForegroundTimeoutMs(input.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS);
        live = await this.start(ownedInput, 'pipes', timeoutMs, true, (admitted) => {
          live = admitted;
          if (input.abortSignal?.aborted) cancel();
        });
        return this.markObservedAndReturnTerminal(await live.finished.join());
      });
    } catch (error) {
      notifyFailedStartup(onCompletion);
      throw error;
    } finally {
      input.abortSignal?.removeEventListener('abort', cancel);
    }
  }

  async writeStdin(input: ShellRunWriteInput): Promise<ShellRunToolResult> {
    validateWriteStdinInput(input);
    const target = parseShellRunResourceRef(input.ref);
    if (!target) throw backgroundTaskRefError(input.ref);
    const live = this.liveResource(input.sessionId, target.shellRunId);
    if (!live) return this.writeStdinWithoutLive(input, target.shellRunId);
    if (live.mode !== 'pty') throw new Error('WriteStdin requires a PTY background task ref');
    if (live.driverExit) {
      const record = await this.markObserved(await live.finished.join());
      return shellRunContent(
        record,
        ptyControlOperation(input, {
          inputQueued: false,
          resizeApplied: false,
          resizeChanged: false,
        }),
      );
    }
    if (!isPtyControlOpen(live)) {
      throw new ShellRunPtyControlClosedError();
    }
    if (input.abortSignal?.aborted)
      throw abortError('WriteStdin aborted before the control operation was committed');

    let inputQueued = false;
    let resizeApplied = false;
    let resizeChanged = false;
    let operationFailed = false;
    let exitBeforeControlCut = false;
    const controlCut = live.collector.mutateAndSnapshotAtCut(() => {
      if (input.abortSignal?.aborted) {
        throw abortError('WriteStdin aborted before the control operation was committed');
      }
      if (live.driverExit) {
        exitBeforeControlCut = true;
        return;
      }
      if (live.termination) throw new ShellRunPtyControlClosedError();
      const terminalInput =
        input.input ??
        (input.actions
          ? encodeTerminalInputActions(input.actions, {
              ...live.collector.currentInputState(),
              ...(input.size ? { cols: input.size.cols, rows: input.size.rows } : {}),
            })
          : undefined);
      if (input.size) {
        const currentSize = live.collector.currentSize();
        if (currentSize.cols === input.size.cols && currentSize.rows === input.size.rows) {
          resizeApplied = true;
        } else {
          live.driver.resize(input.size.cols, input.size.rows);
          resizeApplied = true;
          resizeChanged = true;
          try {
            live.collector.resize(input.size.cols, input.size.rows);
          } catch (error) {
            operationFailed = true;
            this.handleIntegrityFailure(live, asError(error, 'PTY screen resize failed'));
            return;
          }
        }
      }
      if (terminalInput !== undefined) {
        try {
          live.driver.write(terminalInput);
          inputQueued = true;
        } catch (error) {
          operationFailed = true;
          this.handleIntegrityFailure(live, asError(error, 'PTY input write failed'));
        }
      }
    });
    const persistedControl = this.persistObservation(
      live,
      controlCut.then(
        (snapshot) => (operationFailed || exitBeforeControlCut ? undefined : snapshot),
        () => undefined,
      ),
    );
    try {
      await controlCut;
    } catch (error) {
      if (
        error instanceof ShellRunPtyControlClosedError ||
        error instanceof TerminalMouseInputRejectedError ||
        isAbortError(error)
      ) {
        throw error;
      }
      operationFailed = true;
      this.handleIntegrityFailure(live, asError(error, 'PTY control failed'));
    }

    const operation = ptyControlOperation(input, {
      inputQueued,
      resizeApplied,
      resizeChanged,
      failed: operationFailed,
    });
    if (exitBeforeControlCut || operationFailed) {
      const record = await this.markObserved(await live.finished.join());
      return shellRunContent(record, operation);
    }
    let record: ShellRunRecord;
    try {
      record = await persistedControl;
    } catch (error) {
      if (live.integrityFailure && !live.persistFailure) {
        record = await this.markObserved(await live.finished.join());
        return shellRunContent(
          record,
          ptyControlOperation(input, {
            inputQueued,
            resizeApplied,
            resizeChanged,
            failed: true,
          }),
        );
      }
      throw error;
    }
    if (live.integrityFailure && !live.persistFailure) {
      record = await this.markObserved(await live.finished.join());
      return shellRunContent(
        record,
        ptyControlOperation(input, {
          inputQueued,
          resizeApplied,
          resizeChanged,
          failed: true,
        }),
      );
    }
    if (isTerminalShellRunStatus(record.status)) record = await this.markObserved(record);
    return shellRunContent(record, operation);
  }

  async readRuntimeResource(
    sessionId: string,
    ref: string,
    abortSignal: AbortSignal,
  ): Promise<ToolResultContent> {
    return this.resourceDetail(sessionId, ref, true, abortSignal);
  }

  async inspectResource(sessionId: string, ref: string): Promise<ShellRunSnapshotResult> {
    const result = await this.resourceDetail(sessionId, ref, false, new AbortController().signal);
    if (result.output === undefined) {
      throw new Error('ShellRun inspection did not produce a snapshot');
    }
    const { operation: _operation, ...snapshot } = result;
    return snapshot;
  }

  async stopBackgroundTask(
    sessionId: string,
    ref: string,
    abortSignal: AbortSignal,
  ): Promise<ToolResultContent> {
    const target = parseShellRunResourceRef(ref);
    if (!target) throw backgroundTaskRefError(ref);
    const live = this.liveResource(sessionId, target.shellRunId);
    if (!live) return this.stopWithoutLive(sessionId, target.shellRunId, abortSignal);
    if (live.driverExit) {
      const record = await this.markObserved(await live.finished.join());
      return shellRunContent(record, { kind: 'stop', applied: false });
    }
    if (live.termination) {
      await this.waitForTerminationDecision(live.termination, abortSignal);
      const record = await this.markObserved(await live.finished.join());
      return shellRunContent(record, { kind: 'stop', applied: false });
    }
    if (abortSignal.aborted)
      throw abortError('StopBackgroundTask aborted before termination was committed');

    let applied = false;
    const pending = new PendingStop(abortSignal);
    live.pendingStops.add(pending);
    try {
      if (live.mode === 'pty') {
        try {
          applied = await live.collector.mutateAtCut(() =>
            this.beginStopTermination(live, pending),
          );
        } catch (error) {
          if (isAbortError(error)) throw error;
          this.handleIntegrityFailure(live, asError(error, 'PTY stop sequencing failed'));
          const record = await this.markObserved(await live.finished.join());
          return shellRunContent(record, { kind: 'stop', applied: false });
        }
      } else {
        applied = await this.beginStopTermination(live, pending);
      }
    } finally {
      live.pendingStops.delete(pending);
      pending.dispose();
    }
    const record = await this.markObserved(await live.finished.join());
    return shellRunContent(record, { kind: 'stop', applied });
  }

  async buildContextSummary(sessionId: string): Promise<string | undefined> {
    const records = await this.actionableRecords(sessionId);
    if (records.length === 0) return undefined;
    const visible = records.slice(0, SHELL_RUN_CONTEXT_SUMMARY_LIMIT);
    const lines = [
      'Background tasks for this session:',
      ...visible.map((record) => {
        const completed =
          record.completedAt !== undefined ? ` completedAt=${record.completedAt}` : '';
        return `- ref=${shellRunResourceRef(record.shellRunId)} mode=${record.output.mode} status=${record.status} cwd=${record.cwd} updatedAt=${record.updatedAt}${completed} command=${JSON.stringify(record.command)}`;
      }),
    ];
    const overflow = records.length - visible.length;
    if (overflow > 0)
      lines.push(`- ${overflow} more background task(s) not shown in this turn tail.`);
    const hasControllablePty = records.some((record) => {
      const live = this.liveResource(sessionId, record.shellRunId);
      return live?.mode === 'pty' && isPtyControlOpen(live);
    });
    lines.push(
      hasControllablePty
        ? 'Use Read on a ref for its bounded output snapshot; use WriteStdin to control a running PTY task.'
        : 'Use Read on a ref for its bounded output snapshot.',
    );
    return lines.join('\n');
  }

  async listSessionUpdates(sessionId: string): Promise<ShellRunUpdate[]> {
    const records = await this.input.store.listSessionShellRuns(sessionId);
    return records.map(shellRunUpdate);
  }

  async getSessionUpdate(sessionId: string, ref: string): Promise<ShellRunUpdate | undefined> {
    const target = parseShellRunResourceRef(ref);
    if (!target) return undefined;
    try {
      return shellRunUpdate(await this.input.store.readShellRun(sessionId, target.shellRunId));
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      throw error;
    }
  }

  getLivePtySnapshot(sessionId: string, ref: string): ShellRunPtySnapshot | null {
    const target = parseShellRunResourceRef(ref);
    if (!target) return null;
    const live = this.live.get(target.shellRunId);
    if (!live || live.sessionId !== sessionId || live.mode !== 'pty') return null;
    return {
      sessionId,
      ref,
      sequence: live.rawSequence,
      buffer: live.rawBuffer,
      size: live.collector.currentSize(),
    };
  }

  async recoverOrphanedSession(sessionId: string): Promise<number> {
    const records = await this.input.store.listSessionShellRuns(sessionId);
    let recovered = 0;
    for (const record of records) {
      if (
        !isActiveShellRunStatus(record.status) ||
        this.live.has(record.shellRunId) ||
        this.startupOwners.has(record.shellRunId)
      )
        continue;
      await this.markOrphaned(record, 'Runtime restarted without a live shell process handle');
      recovered += 1;
    }
    return recovered;
  }

  async terminateSession(sessionId: string): Promise<SessionCloseLease> {
    const lease = { sessionId, token: Symbol('session-close') };
    this.holdSessionClose(lease);
    this.sessionTerminationEpochs.set(sessionId, this.sessionTerminationEpoch(sessionId) + 1);
    try {
      await this.settleSessionLives(sessionId);
      return lease;
    } catch (error) {
      this.rollbackSessionClose(lease);
      throw error;
    }
  }

  async commitSessionClose(lease: SessionCloseLease): Promise<void> {
    const alreadyClosed = (this.sessionCloseLeases.get(lease.sessionId)?.size ?? 0) > 0;
    this.holdSessionClose(lease);
    if (alreadyClosed) return;
    this.sessionTerminationEpochs.set(
      lease.sessionId,
      this.sessionTerminationEpoch(lease.sessionId) + 1,
    );
    await this.settleSessionLives(lease.sessionId);
  }

  rollbackSessionClose(lease: SessionCloseLease): void {
    const leases = this.sessionCloseLeases.get(lease.sessionId);
    if (!leases) return;
    leases.delete(lease.token);
    if (leases.size === 0) this.sessionCloseLeases.delete(lease.sessionId);
  }

  resumeSession(sessionId: string): void {
    this.sessionCloseLeases.delete(sessionId);
  }

  async terminateAll(): Promise<void> {
    this.shuttingDown = true;
    const failures: unknown[] = [];
    await this.captureTerminationFailure(
      this.terminateLives([...this.live.values()], 'shutdown'),
      failures,
    );
    await Promise.all([...this.pendingStartups.values()].flatMap((startups) => [...startups]));
    await this.captureTerminationFailure(
      this.terminateLives([...this.live.values()], 'shutdown'),
      failures,
    );
    if (failures.length > 0) throw failures[0];
  }

  liveCount(): number {
    return this.reservedShellRuns;
  }

  livePtyCount(): number {
    return this.reservedPtyRuns;
  }

  private async start(
    input: ShellRunBashInput,
    mode: ShellMode,
    timeoutMs: number | undefined,
    forwardLive: boolean,
    onLiveAdmission?: (live: LiveShellRun) => void,
  ): Promise<LiveShellRun> {
    const sessionEpoch = this.sessionTerminationEpoch(input.sessionId);
    this.assertStartAllowed(input.sessionId, sessionEpoch);
    if (mode === 'pty' && (input.argv || input.fdInputs)) {
      throw new Error('PTY Bash does not support transformed argv or inherited fd inputs');
    }
    const slotReservation = this.reserveSlot(mode);
    try {
      const shellRunId = this.input.newId();
      this.startupOwners.add(shellRunId);
      try {
        if (mode === 'pipes') {
          return await this.startPipe(
            input,
            shellRunId,
            timeoutMs,
            forwardLive,
            slotReservation,
            sessionEpoch,
            onLiveAdmission,
          );
        }

        const stack = await racePromiseWithAbort(loadPtyStack(), input.abortSignal);
        this.assertStartAllowed(input.sessionId, sessionEpoch);
        if (input.abortSignal?.aborted)
          throw abortError('Command aborted before PTY process started');
        return await this.startPty(
          input,
          shellRunId,
          timeoutMs,
          stack,
          slotReservation,
          sessionEpoch,
        );
      } finally {
        this.startupOwners.delete(shellRunId);
      }
    } catch (error) {
      this.releaseSlot(slotReservation);
      throw error;
    }
  }

  private async startPipe(
    input: ShellRunBashInput,
    shellRunId: string,
    timeoutMs: number | undefined,
    forwardLive: boolean,
    slotReservation: ShellRunSlotReservation,
    sessionEpoch: number,
    onLiveAdmission: ((live: LiveShellRun) => void) | undefined,
  ): Promise<LivePipeShellRun> {
    const collector = new PipeTailCollector(this.maxRetainedChars);
    const pending: Array<(live: LivePipeShellRun) => void> = [];
    let live: LivePipeShellRun | undefined;
    let startingRecord: ShellRunRecord | undefined;
    let spawnAttempted = false;
    const dispatch = (callback: (target: LivePipeShellRun) => void): void => {
      if (live) callback(live);
      else pending.push(callback);
    };
    try {
      const plan = input.argv
        ? {
            file: requireProgram(input.argv),
            args: [...input.argv.slice(1)],
            useShellOption: false,
          }
        : buildShellSpawnPlan(
            input.shell ?? defaultShellPlan(),
            input.command,
            input.env ?? process.env,
          );
      startingRecord = await this.createStartingRecord(
        input,
        shellRunId,
        timeoutMs,
        collector.snapshot(),
      );
      this.assertStartupAllowed(input.sessionId, sessionEpoch, input.abortSignal);
      spawnAttempted = true;
      const driver = new PipeProcessDriver({
        plan,
        cwd: input.cwd,
        ...((plan.env ?? input.env) ? { env: plan.env ?? input.env } : {}),
        ...(input.fdInputs ? { fdInputs: input.fdInputs } : {}),
        outputDrainMs: this.pipeOutputDrainMs,
        onData: (stream, data) => dispatch((target) => this.onPipeData(target, stream, data)),
        onRootExit: () => dispatch((target) => this.onNativeRootExit(target)),
        onExit: (exit) =>
          dispatch((target) => this.onDriverExit(target, { mode: 'pipes', value: exit })),
        onFailure: (error) => dispatch((target) => this.handleIntegrityFailure(target, error)),
      });
      live = {
        ...this.createLiveBase(input, startingRecord, 'pipes', timeoutMs, slotReservation),
        mode: 'pipes',
        driver,
        collector,
        pendingFlushChars: 0,
        forwardLive,
        liveEmitted: { stdout: 0, stderr: 0 },
        liveSuppressed: { stdout: false, stderr: false },
        emitOutput: input.emitOutput,
      };
      this.live.set(shellRunId, live);
      for (const callback of pending) callback(live);
      driver.writeInputs();
      await racePromiseWithAbort(driver.ready, input.abortSignal);
      onLiveAdmission?.(live);
      this.armTimeout(live);
      this.assertLiveStartupAllowed(live, sessionEpoch, input.abortSignal);
      await this.markRunning(live);
      this.assertLiveStillAdmitted(live, sessionEpoch);
      live.startupSettled.resolve();
      return live;
    } catch (error) {
      if (!spawnAttempted) closeChildFdSources(input.fdInputs);
      if (!startingRecord) throw error;
      throw await this.completeStartupFailure(live, startingRecord, error);
    }
  }

  private async startPty(
    input: ShellRunBashInput,
    shellRunId: string,
    timeoutMs: number | undefined,
    stack: PtyStack,
    slotReservation: ShellRunSlotReservation,
    sessionEpoch: number,
  ): Promise<LivePtyShellRun> {
    const pending: Array<(live: LivePtyShellRun) => void> = [];
    let live: LivePtyShellRun | undefined;
    let driver: PtyProcessDriver | undefined;
    const dispatch = (callback: (target: LivePtyShellRun) => void): void => {
      if (live) callback(live);
      else pending.push(callback);
    };
    let collector: PtyScreenCollector | undefined;
    let startingRecord: ShellRunRecord | undefined;
    try {
      collector = new PtyScreenCollector({
        stack,
        cols: PTY_INITIAL_COLS,
        rows: PTY_INITIAL_ROWS,
        onProtocolReply: (data) => {
          if (!live || !driver)
            throw new Error('PTY protocol reply arrived before driver admission');
          if (live.driverExit || live.termination || live.integrityFailure) return;
          driver.write(data);
        },
        onDirty: () => dispatch((target) => this.scheduleAutomaticFlush(target)),
        onFailure: (error) => dispatch((target) => this.handleIntegrityFailure(target, error)),
      });
      const plan = buildPtyShellSpawnPlan(
        input.shell ?? defaultShellPlan(),
        input.command,
        input.env ?? process.env,
      );
      startingRecord = await this.createStartingRecord(
        input,
        shellRunId,
        timeoutMs,
        collector.lastGoodSnapshot(),
      );
      this.assertStartupAllowed(input.sessionId, sessionEpoch, input.abortSignal);
      driver = new PtyProcessDriver({
        stack,
        file: plan.file,
        args: plan.args,
        cwd: input.cwd,
        env: plan.env ?? input.env ?? process.env,
        cols: PTY_INITIAL_COLS,
        rows: PTY_INITIAL_ROWS,
        onData: (data) => dispatch((target) => this.onPtyData(target, data)),
        onExit: (exit) => {
          dispatch((target) => {
            this.publishPtyData(target);
            this.onNativeRootExit(target);
          });
          dispatch((target) => this.onDriverExit(target, { mode: 'pty', value: exit }));
        },
        onInvariantFailure: (error) =>
          dispatch((target) => this.handleIntegrityFailure(target, error)),
      });
    } catch (error) {
      try {
        collector?.dispose();
      } catch {
        /* startup cleanup continues */
      }
      try {
        driver?.dispose();
      } catch {
        /* startup cleanup continues */
      }
      if (!startingRecord) throw error;
      throw await this.completeStartupFailure(undefined, startingRecord, error);
    }
    if (!driver || !collector || !startingRecord) {
      throw new Error('PTY startup completed without a driver and collector');
    }
    live = {
      ...this.createLiveBase(input, startingRecord, 'pty', timeoutMs, slotReservation),
      mode: 'pty',
      driver,
      collector,
      rawBuffer: '',
      rawSequence: 0,
      pendingRawData: '',
    };
    this.live.set(shellRunId, live);
    try {
      this.armTimeout(live);
      for (const callback of pending) callback(live);
      this.assertLiveStartupAllowed(live, sessionEpoch, input.abortSignal);
      await this.markRunning(live);
      this.assertLiveStillAdmitted(live, sessionEpoch);
      live.startupSettled.resolve();
      return live;
    } catch (error) {
      throw await this.completeStartupFailure(live, startingRecord, error);
    }
  }

  private createLiveBase(
    input: ShellRunBashInput,
    record: ShellRunRecord,
    mode: ShellMode,
    timeoutMs: number | undefined,
    slotReservation: ShellRunSlotReservation,
  ): LiveShellRunBase {
    return {
      shellRunId: record.shellRunId,
      sessionId: input.sessionId,
      mode,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      record,
      visibleRef: false,
      pendingStops: new Set(),
      persistChain: Promise.resolve(),
      lastPersistedGeneration: 0,
      lastSnapshotWallTime: 0,
      slotReservation,
      rootExited: false,
      nativeRootExit: new CompletionLatch<void>(),
      startupSettled: new CompletionLatch<void>(),
      finished: new CompletionLatch<ShellRunRecord>(),
      ...(input.onCompletion ? { onCompletion: input.onCompletion } : {}),
      completionNotified: false,
    };
  }

  private async createStartingRecord(
    input: ShellRunBashInput,
    shellRunId: string,
    timeoutMs: number | undefined,
    output: ShellOutput,
  ): Promise<ShellRunRecord> {
    const startedAt = this.input.now();
    const record: ShellRunRecord = {
      shellRunId,
      sessionId: input.sessionId,
      ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
      sourceTurnId: input.sourceTurnId,
      sourceToolCallId: input.sourceToolCallId,
      cwd: input.cwd,
      command: redactSecrets(input.command),
      status: 'starting',
      startedAt,
      updatedAt: startedAt,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(input.sandboxType
        ? {
            sandboxExecution: {
              type: input.sandboxType,
              enforced: input.sandboxType !== 'none',
            },
          }
        : {}),
      revision: 1,
      output,
    };
    return this.input.store.createShellRun(record);
  }

  private async markRunning(live: LiveShellRun): Promise<void> {
    live.record = await this.input.store.updateShellRun(live.sessionId, live.shellRunId, {
      status: 'running',
      output: (await this.snapshotAtCut(live, false)).output,
      updatedAt: this.input.now(),
    });
    if (live.driverExit) {
      void this.beginFinalize(live).catch(() => {});
    } else if (this.currentGeneration(live) > 0) {
      this.scheduleAutomaticFlush(live);
    }
  }

  private onPipeData(live: LivePipeShellRun, stream: 'stdout' | 'stderr', data: string): void {
    if (live.driverExit || live.finalizeOnce) return;
    live.collector.accept(stream, data);
    live.pendingFlushChars += data.length;
    this.emitLivePipeOutput(live, stream, data);
    this.scheduleAutomaticFlush(live);
  }

  private onPtyData(live: LivePtyShellRun, data: string): void {
    if (live.driverExit || live.finalizeOnce) return;
    live.rawBuffer = `${live.rawBuffer}${data}`.slice(-PTY_RAW_REPLAY_CHARS);
    live.collector.accept(data);
    for (const chunk of splitPtyData(data)) {
      const combined = `${live.pendingRawData}${chunk}`;
      if (live.pendingRawData && encodedPtyDataBytes(combined) > PTY_RAW_PUBLISH_MAX_BYTES) {
        this.publishPtyData(live);
      }
      live.rawSequence += 1;
      live.pendingRawData += chunk;
      if (encodedPtyDataBytes(live.pendingRawData) >= PTY_RAW_PUBLISH_TARGET_BYTES) {
        this.publishPtyData(live);
      }
    }
    if (!live.pendingRawData) return;
    live.rawPublishTimer ??= setTimeout(() => {
      live.rawPublishTimer = undefined;
      this.publishPtyData(live);
    }, PTY_RAW_PUBLISH_INTERVAL_MS);
  }

  private publishPtyData(live: LivePtyShellRun): void {
    if (live.rawPublishTimer) {
      clearTimeout(live.rawPublishTimer);
      live.rawPublishTimer = undefined;
    }
    const data = live.pendingRawData;
    if (!data) return;
    live.pendingRawData = '';
    const event: ShellRunPtyDataEvent = {
      sessionId: live.sessionId,
      ref: shellRunResourceRef(live.shellRunId),
      sequence: live.rawSequence,
      data,
    };
    try {
      this.input.onPtyData?.(event);
    } catch {
      // The PTY and durable screen snapshot remain authoritative.
    }
  }

  private emitLivePipeOutput(
    live: LivePipeShellRun,
    stream: 'stdout' | 'stderr',
    chunk: string,
  ): void {
    if (!live.forwardLive || live.liveSuppressed[stream]) return;
    if (live.liveEmitted[stream] + chunk.length <= this.maxLiveEmitChars) {
      live.emitOutput(stream, chunk);
      live.liveEmitted[stream] += chunk.length;
      return;
    }
    live.emitOutput(stream, LIVE_OUTPUT_SUPPRESSED_MARKER);
    live.liveSuppressed[stream] = true;
  }

  private scheduleAutomaticFlush(live: LiveShellRun): void {
    if (live.finalizeOnce || live.driverExit || live.integrityFailure || live.persistFailure)
      return;
    if (live.flushInFlight || live.cancelFlush) return;
    if (live.mode === 'pipes') {
      if (live.pendingFlushChars >= this.flushBytes) {
        this.queueAutomaticFlush(live);
      } else {
        live.cancelFlush = this.scheduleFlush(() => {
          live.cancelFlush = undefined;
          this.queueAutomaticFlush(live);
        }, this.flushIntervalMs);
      }
      return;
    }
    // Real elapsed time, not the injected `now()`: this paces flushes against the wall
    // clock, while `now()` only stamps records and is a plain counter under test.
    const elapsed = Date.now() - live.lastSnapshotWallTime;
    live.cancelFlush = this.scheduleFlush(
      () => {
        live.cancelFlush = undefined;
        this.queueAutomaticFlush(live);
      },
      Math.max(0, this.flushIntervalMs - elapsed),
    );
  }

  private queueAutomaticFlush(live: LiveShellRun): void {
    if (
      live.finalizeOnce ||
      live.driverExit ||
      live.integrityFailure ||
      live.persistFailure ||
      live.flushInFlight ||
      this.currentGeneration(live) <= live.lastPersistedGeneration
    )
      return;
    if (live.mode === 'pipes') live.pendingFlushChars = 0;
    const task = this.queuePersist(live);
    live.flushInFlight = task;
    void task
      .catch(() => {})
      .finally(() => {
        if (live.flushInFlight === task) live.flushInFlight = undefined;
        if (this.currentGeneration(live) > live.lastPersistedGeneration) {
          this.scheduleAutomaticFlush(live);
        }
      });
  }

  private persistObservation(
    live: LiveShellRun,
    snapshotBarrier?: Promise<SnapshotAtCut | undefined>,
  ): Promise<ShellRunRecord> {
    if (live.integrityFailure || live.driverExit) return live.finished.join();
    if (live.cancelFlush) {
      live.cancelFlush();
      live.cancelFlush = undefined;
    }
    if (live.mode === 'pipes') live.pendingFlushChars = 0;
    const task = this.queuePersist(live, {}, snapshotBarrier ? { snapshotBarrier } : {});
    return task.catch((error: unknown) => {
      if (!live.integrityFailure || live.persistFailure) throw error;
      return live.finished.join();
    });
  }

  private queuePersist(
    live: LiveShellRun,
    patch: PersistPatch = {},
    options: PersistOptions = {},
  ): Promise<ShellRunRecord> {
    const barrier = options.snapshotBarrier
      ? options.snapshotBarrier
      : this.snapshotAtCut(live, Boolean(options.allowLastGood));
    let failureStage: 'snapshot' | 'persist' = 'snapshot';
    const settledBarrier = barrier.then(
      (snapshot) => ({ ok: true as const, snapshot }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const task = live.persistChain.then(async () => {
      const settled = await settledBarrier;
      if (!settled.ok) throw settled.error;
      const { snapshot } = settled;
      if (!snapshot) {
        if (this.currentGeneration(live) > live.lastPersistedGeneration) {
          this.scheduleAutomaticFlush(live);
        }
        return live.record;
      }
      failureStage = 'persist';
      if (live.persistFailure && !options.bestEffort) throw live.persistFailure;
      const current = live.record;
      const candidate: ShellRunRecord = { ...current, ...patch, output: snapshot.output };
      let updated = current;
      if (!isDeepStrictEqual(candidate, current)) {
        updated = await this.input.store.updateShellRun(live.sessionId, live.shellRunId, {
          ...patch,
          output: snapshot.output,
          updatedAt: this.input.now(),
        });
        live.record = updated;
        if (live.visibleRef) this.notifyShellRunUpdate(updated);
      }
      live.lastPersistedGeneration = Math.max(live.lastPersistedGeneration, snapshot.generation);
      live.lastSnapshotWallTime = Date.now();
      return updated;
    });
    live.persistChain = task.then(
      () => undefined,
      (error: unknown) => {
        const failure = asError(
          error,
          failureStage === 'snapshot' ? 'ShellRun snapshot failed' : 'ShellRun persistence failed',
        );
        if (failureStage === 'persist') live.persistFailure ??= failure;
        this.handleIntegrityFailure(live, failure);
      },
    );
    return task;
  }

  private snapshotAtCut(live: LiveShellRun, allowLastGood: boolean): Promise<SnapshotAtCut> {
    if (live.mode === 'pipes') {
      const output = live.collector.snapshot();
      if (live.driverExit?.mode === 'pipes') {
        output.stdoutTruncated ||= live.driverExit.value.stdoutTruncated;
        output.stderrTruncated ||= live.driverExit.value.stderrTruncated;
      }
      return Promise.resolve({
        output,
        generation: live.collector.currentGeneration(),
      });
    }
    const snapshot = live.collector.snapshotAtCut();
    if (!allowLastGood) return snapshot;
    return snapshot.catch(() => ({
      output: live.collector.lastGoodSnapshot(),
      generation: live.collector.currentGeneration(),
    }));
  }

  private onNativeRootExit(live: LiveShellRun): void {
    if (live.rootExited) return;
    live.rootExited = true;
    this.settlePendingStops(live, 'exit');
    live.nativeRootExit.resolve();
  }

  private onDriverExit(live: LiveShellRun, exit: DriverExit): void {
    if (live.driverExit || live.finalizeOnce) return;
    live.driverExit = exit;
    this.onNativeRootExit(live);
    if (
      exit.mode === 'pipes' &&
      (exit.value.stdoutTruncated || exit.value.stderrTruncated) &&
      !live.integrityFailure
    ) {
      live.integrityFailure = new Error(
        'Shell root exited before inherited output pipes drained completely',
      );
    }
    if (live.mode === 'pty') live.collector.closeDataAdmission();
    if (live.record.status === 'running') void this.beginFinalize(live).catch(() => {});
  }

  private beginFinalize(live: LiveShellRun, abandoned = false): Promise<ShellRunRecord> {
    live.finalizeOnce ??= this.finalizeLive(live, abandoned);
    return live.finalizeOnce;
  }

  private async finalizeLive(live: LiveShellRun, abandoned: boolean): Promise<ShellRunRecord> {
    if (live.termination) await live.termination.finished.join();
    if (abandoned && !live.integrityFailure) {
      live.integrityFailure = new Error(
        'Shell process did not acknowledge exit after forced termination',
      );
    }
    this.clearLiveTimers(live);
    if (live.mode === 'pty') live.collector.closeDataAdmission();

    let finalSnapshot: SnapshotAtCut;
    try {
      finalSnapshot = await this.snapshotAtCut(live, true);
    } catch (error) {
      live.integrityFailure ??= asError(error, 'ShellRun final snapshot failed');
      finalSnapshot = {
        output: live.record.output,
        generation: live.lastPersistedGeneration,
      };
    }
    let cleanupError: Error | undefined;
    try {
      if (live.mode === 'pty') live.collector.dispose();
    } catch (error) {
      cleanupError ??= asError(error, 'PTY collector cleanup failed');
    }
    try {
      live.driver.dispose();
    } catch (error) {
      cleanupError ??= asError(error, 'Shell process driver cleanup failed');
    }

    live.integrityFailure ??= cleanupError;

    let finalRecord: ShellRunRecord | undefined;
    let completionError: Error | undefined;
    try {
      finalRecord = await this.queuePersist(live, this.finalState(live), {
        bestEffort: true,
        snapshotBarrier: Promise.resolve(finalSnapshot),
      });
    } catch (error) {
      completionError = asError(error, 'ShellRun final persistence failed');
    }
    try {
      if (completionError || !finalRecord) {
        const error =
          completionError ??
          new Error(`ShellRun ${live.shellRunId} finalized without a durable record`);
        live.finished.reject(error);
        throw error;
      }
      this.notifyCompletionOwner(
        live,
        finalRecord.status === 'completed' && finalRecord.exitCode === 0,
      );
      live.finished.resolve(finalRecord);
      return finalRecord;
    } finally {
      this.notifyCompletionOwner(live, false);
      this.live.delete(live.shellRunId);
      this.releaseLiveSlot(live);
    }
  }

  private notifyCompletionOwner(live: LiveShellRun, successful: boolean): void {
    if (live.completionNotified) return;
    live.completionNotified = true;
    try {
      live.onCompletion?.({ successful });
    } catch {
      // Resource cleanup must not corrupt the durable shell-run terminal state.
    }
  }

  private finalState(live: LiveShellRun): PersistPatch {
    const completedAt = this.input.now();
    if (live.integrityFailure) {
      return {
        status: 'failed',
        failureMessage: safeFailureMessage(live.integrityFailure),
        exitCode: undefined,
        completedAt,
      };
    }
    if (live.lifecycleCause === 'timeout') {
      return {
        status: 'timed_out',
        failureMessage:
          live.timeoutMs === undefined
            ? 'Command timed out'
            : `Command timed out after ${live.timeoutMs}ms`,
        exitCode: 124,
        completedAt,
      };
    }
    if (live.lifecycleCause === 'cancel' || live.lifecycleCause === 'shutdown') {
      return {
        status: 'cancelled',
        failureMessage: 'Command cancelled',
        exitCode: 130,
        completedAt,
      };
    }
    const exitCode = naturalExitCode(live.driverExit);
    return {
      status: exitCode === 0 ? 'completed' : 'failed',
      ...(exitCode === 0 ? {} : { failureMessage: 'Command failed' }),
      exitCode,
      completedAt,
    };
  }

  private handleIntegrityFailure(live: LiveShellRun, error: Error): void {
    live.integrityFailure ??= error;
    if (live.mode === 'pty') live.collector.closeDataAdmission();
    if (!live.rootExited && !live.termination) this.requestTermination(live);
  }

  private requestForcedTermination(live: LiveShellRun, cause: LifecycleCause): void {
    this.requestTermination(live, cause);
  }

  private requestTermination(
    live: LiveShellRun,
    cause?: LifecycleCause,
  ): TerminationLifecycle | undefined {
    if (live.rootExited || live.finalizeOnce) return live.termination;
    if (live.termination) {
      // A timeout fired while termination was still waiting for the process
      // (POSIX process discovery, child startup); a cancellation that arrives
      // before the kill is applied should win, so callers observe 'cancelled'
      // instead of a stale 'timed_out'. Once the process is gone (rootExited /
      // finalizeOnce) we never reach this branch.
      if (cause === 'cancel' && live.lifecycleCause === 'timeout') {
        live.lifecycleCause = 'cancel';
      }
      return live.termination;
    }
    const lifecycle = createTerminationLifecycle();
    live.termination = lifecycle;
    this.startTermination(live, lifecycle, cause, () => {
      if (live.termination !== lifecycle || live.rootExited) return false;
      this.settlePendingStops(live, 'termination');
      return true;
    });
    return lifecycle;
  }

  private async beginStopTermination(live: LiveShellRun, pending: PendingStop): Promise<boolean> {
    if (live.rootExited) {
      pending.settle('exit');
      return false;
    }
    if (live.termination) {
      return this.finishPendingStop(pending);
    }

    const lifecycle = createTerminationLifecycle();
    this.startTermination(live, lifecycle, 'cancel', () => {
      if (pending.current()) return false;
      if (live.rootExited) {
        pending.settle('exit');
        return false;
      }
      if (live.termination) return false;
      live.termination = lifecycle;
      this.settlePendingStops(live, 'termination');
      return true;
    });

    const applied = await lifecycle.initialSignal.join();
    if (live.termination === lifecycle) return applied;
    return this.finishPendingStop(pending);
  }

  private async finishPendingStop(pending: PendingStop): Promise<false> {
    if ((await pending.wait()) === 'abort') {
      throw abortError('StopBackgroundTask aborted before termination was committed');
    }
    return false;
  }

  private settlePendingStops(live: LiveShellRun, outcome: PendingStopOutcome): void {
    for (const pending of live.pendingStops) pending.settle(outcome);
  }

  private async waitForTerminationDecision(
    lifecycle: TerminationLifecycle,
    abortSignal: AbortSignal,
  ): Promise<void> {
    if ((await lifecycle.initialDecision.waitFor(abortSignal)) === 'abort') {
      throw abortError('StopBackgroundTask aborted before termination was committed');
    }
  }

  private startTermination(
    live: LiveShellRun,
    lifecycle: TerminationLifecycle,
    cause: LifecycleCause | undefined,
    commit: () => boolean,
  ): void {
    void this.runTermination(live, lifecycle, cause, commit)
      .catch((error: unknown) => {
        if (live.termination !== lifecycle) return;
        live.integrityFailure ??= asError(error, 'Shell process termination failed');
        if (live.mode === 'pty') live.collector.closeDataAdmission();
        if (live.record.status === 'running') void this.beginFinalize(live, true).catch(() => {});
      })
      .finally(() => {
        lifecycle.initialDecision.resolve();
        lifecycle.initialSignal.resolve(false);
        lifecycle.finished.resolve();
        if (live.termination === lifecycle) {
          this.settlePendingStops(live, live.rootExited ? 'exit' : 'termination');
        }
      });
  }

  private async runTermination(
    live: LiveShellRun,
    lifecycle: TerminationLifecycle,
    cause: LifecycleCause | undefined,
    commit: () => boolean,
  ): Promise<void> {
    let committed = false;
    const applied = await this.signalProcessTree(live, 'SIGTERM', () => {
      if (!commit()) return false;
      committed = true;
      lifecycle.initialDecision.resolve();
      return true;
    });
    if (!committed) {
      lifecycle.initialDecision.resolve();
      lifecycle.initialSignal.resolve(false);
      return;
    }
    if (applied && cause) live.lifecycleCause ??= cause;
    lifecycle.initialSignal.resolve(applied);
    if (live.rootExited || live.finalizeOnce) return;

    if ((await live.nativeRootExit.wait(this.killGraceMs)) !== 'delay') return;
    const forced = await this.signalProcessTree(live, 'SIGKILL');
    if (forced && cause) live.lifecycleCause ??= cause;
    if (live.rootExited || live.finalizeOnce) return;

    if ((await live.nativeRootExit.wait(this.exitAcknowledgementMs)) !== 'delay') return;
    await this.signalProcessTree(live, 'SIGKILL');
    if (live.rootExited || live.finalizeOnce) return;

    this.handleIntegrityFailure(
      live,
      new Error('Shell process did not acknowledge exit after forced termination'),
    );
    if (live.record.status === 'running') void this.beginFinalize(live, true).catch(() => {});
  }

  private signalProcessTree(
    live: LiveShellRun,
    signal: ProcessTerminationSignal,
    beforeSignal?: () => boolean,
  ): Promise<boolean> {
    if (live.rootExited) return Promise.resolve(false);
    const pid = live.driver.pid;
    if (pid === undefined || pid <= 0) {
      if (beforeSignal && !beforeSignal()) return Promise.resolve(false);
      try {
        const applied = live.driver.kill(signal);
        return Promise.resolve(applied !== false);
      } catch {
        return Promise.resolve(false);
      }
    }
    return terminateProcessTree({
      pid,
      signal,
      fallback: () => (live.rootExited ? false : live.driver.kill(signal)),
      hasExited: () => live.rootExited,
      beforeSignal,
    });
  }

  private async terminateLive(live: LiveShellRun, cause: LifecycleCause): Promise<void> {
    this.requestForcedTermination(live, cause);
    await live.startupSettled.join();
    await live.finished.join();
  }

  private async terminateLives(lives: LiveShellRun[], cause: LifecycleCause): Promise<void> {
    const settlements = await Promise.allSettled(
      lives.map((live) => this.terminateLive(live, cause)),
    );
    const failure = settlements.find(
      (settlement): settlement is PromiseRejectedResult => settlement.status === 'rejected',
    );
    if (failure) throw failure.reason;
  }

  private async cleanupStartupNative(live: LiveShellRun): Promise<void> {
    this.clearLiveTimers(live);
    if (!live.rootExited) {
      const termination = live.termination ?? this.requestTermination(live);
      if (termination) await termination.finished.join();
    }

    let cleanupError: Error | undefined;
    if (!live.rootExited) {
      cleanupError =
        live.integrityFailure ??
        new Error('Shell process did not acknowledge exit during startup cleanup');
    }
    try {
      if (live.mode === 'pty') {
        live.collector.closeDataAdmission();
        live.collector.dispose();
      }
    } catch (error) {
      cleanupError ??= asError(error, 'PTY collector startup cleanup failed');
    }
    try {
      live.driver.dispose();
    } catch (error) {
      cleanupError ??= asError(error, 'Shell process driver startup cleanup failed');
    }
    if (cleanupError) throw cleanupError;
  }

  private assertLiveStartupAllowed(
    live: LiveShellRun,
    sessionEpoch: number,
    abortSignal: AbortSignal | undefined,
  ): void {
    if (abortSignal?.aborted) {
      throw abortError('Command aborted before shell process became ready');
    }
    this.assertLiveStillAdmitted(live, sessionEpoch);
  }

  private assertLiveStillAdmitted(live: LiveShellRun, sessionEpoch: number): void {
    this.assertStartAllowed(live.sessionId, sessionEpoch);
    if (live.integrityFailure) throw live.integrityFailure;
  }

  private assertStartupAllowed(
    sessionId: string,
    sessionEpoch: number,
    abortSignal: AbortSignal | undefined,
  ): void {
    if (abortSignal?.aborted) {
      throw abortError('Command aborted before shell process became ready');
    }
    this.assertStartAllowed(sessionId, sessionEpoch);
  }

  private async completeStartupFailure(
    live: LiveShellRun | undefined,
    record: ShellRunRecord,
    startupFailure: unknown,
  ): Promise<Error> {
    const startupError = asError(startupFailure, 'Shell process startup failed');
    let reportedError = startupError;
    let cleanupFailed = false;
    if (live) {
      try {
        await this.cleanupStartupNative(live);
      } catch (error) {
        cleanupFailed = true;
        reportedError = startupCleanupError(startupError, error);
      }
    }

    try {
      const terminal = await this.markStartupTerminal(record, reportedError, cleanupFailed);
      live?.finished.resolve(terminal);
    } catch (error) {
      reportedError = startupPersistenceError(reportedError, error);
      live?.finished.reject(reportedError);
    } finally {
      if (live) {
        live.startupSettled.resolve();
        this.notifyCompletionOwner(live, false);
        this.live.delete(live.shellRunId);
        this.releaseLiveSlot(live);
      }
    }
    return reportedError;
  }

  private async markStartupTerminal(
    record: ShellRunRecord,
    error: Error,
    orphaned: boolean,
  ): Promise<ShellRunRecord> {
    return this.terminalizeActiveRecord(record, () => {
      const now = this.input.now();
      return {
        status: orphaned ? 'orphaned' : 'failed',
        failureMessage: safeFailureMessage(error),
        exitCode: undefined,
        completedAt: now,
        observedAt: now,
        updatedAt: now,
      };
    });
  }

  private async resourceDetail(
    sessionId: string,
    ref: string,
    markObserved: boolean,
    abortSignal: AbortSignal,
  ): Promise<ShellRunToolResult> {
    const target = parseShellRunResourceRef(ref);
    if (!target) throw backgroundTaskRefError(ref);
    const live = this.liveResource(sessionId, target.shellRunId);
    let record: ShellRunRecord;
    if (live) {
      if (live.integrityFailure || live.driverExit) {
        record = await live.finished.join();
      } else {
        if (abortSignal.aborted)
          throw abortError('Read aborted before the runtime snapshot cut was established');
        record = await this.persistObservation(live);
      }
    } else {
      if (abortSignal.aborted)
        throw abortError('Read aborted before the durable runtime snapshot was read');
      record = await this.readDurableRecord(sessionId, target.shellRunId);
      if (isActiveShellRunStatus(record.status)) {
        record = await this.markOrphaned(
          record,
          'Runtime restarted without a live shell process handle',
        );
      }
      if (abortSignal.aborted)
        throw abortError('Read aborted before the durable runtime snapshot was observed');
    }
    if (markObserved && isTerminalShellRunStatus(record.status))
      record = await this.markObserved(record);
    return shellRunContent(record);
  }

  private liveResource(sessionId: string, shellRunId: string): LiveShellRun | undefined {
    const live = this.live.get(shellRunId);
    return live?.sessionId === sessionId ? live : undefined;
  }

  private async writeStdinWithoutLive(
    input: ShellRunWriteInput,
    shellRunId: string,
  ): Promise<ShellRunToolResult> {
    if (input.abortSignal?.aborted) {
      throw abortError('WriteStdin aborted before the terminal state was observed');
    }
    let record = await this.readDurableRecord(input.sessionId, shellRunId);
    if (record.output.mode !== 'pty')
      throw new Error('WriteStdin requires a PTY background task ref');
    if (isActiveShellRunStatus(record.status)) {
      record = await this.markOrphaned(
        record,
        'Runtime restarted without a live shell process handle',
      );
    }
    if (input.abortSignal?.aborted) {
      throw abortError('WriteStdin aborted before the terminal state was observed');
    }
    record = await this.markObserved(record);
    return shellRunContent(
      record,
      ptyControlOperation(input, {
        inputQueued: false,
        resizeApplied: false,
        resizeChanged: false,
      }),
    );
  }

  private async stopWithoutLive(
    sessionId: string,
    shellRunId: string,
    abortSignal?: AbortSignal,
  ): Promise<ShellRunToolResult> {
    if (abortSignal?.aborted) {
      throw abortError('StopBackgroundTask aborted before the terminal state was observed');
    }
    let record = await this.readDurableRecord(sessionId, shellRunId);
    if (isActiveShellRunStatus(record.status)) {
      record = await this.markOrphaned(
        record,
        'Runtime restarted without a live shell process handle',
      );
    }
    if (abortSignal?.aborted) {
      throw abortError('StopBackgroundTask aborted before the terminal state was observed');
    }
    record = await this.markObserved(record);
    return shellRunContent(record, { kind: 'stop', applied: false });
  }

  private async markObservedAndReturnTerminal(record: ShellRunRecord): Promise<TerminalToolResult> {
    return terminalContent(await this.markObserved(record));
  }

  private async readDurableRecord(sessionId: string, shellRunId: string): Promise<ShellRunRecord> {
    try {
      return await this.input.store.readShellRun(sessionId, shellRunId);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      const notFound = new Error(
        'Runtime background task not found in this session',
      ) as NodeJS.ErrnoException;
      notFound.code = 'ENOENT';
      throw notFound;
    }
  }

  private async markObserved(record: ShellRunRecord): Promise<ShellRunRecord> {
    if (!isTerminalShellRunStatus(record.status) || record.observedAt !== undefined) return record;
    return this.input.store.updateShellRun(record.sessionId, record.shellRunId, {
      observedAt: this.input.now(),
    });
  }

  private async markOrphaned(record: ShellRunRecord, reason: string): Promise<ShellRunRecord> {
    const failureMessage = redactSecrets(reason);
    return this.terminalizeActiveRecord(record, () => {
      const now = this.input.now();
      return {
        status: 'orphaned',
        failureMessage,
        exitCode: undefined,
        completedAt: now,
        updatedAt: now,
      };
    });
  }

  private async terminalizeActiveRecord(
    record: ShellRunRecord,
    buildPatch: () => ShellRunPatch,
  ): Promise<ShellRunRecord> {
    if (!isActiveShellRunStatus(record.status)) return record;
    try {
      return await this.input.store.updateShellRun(
        record.sessionId,
        record.shellRunId,
        buildPatch(),
      );
    } catch (error) {
      let current: ShellRunRecord;
      try {
        current = await this.input.store.readShellRun(record.sessionId, record.shellRunId);
      } catch {
        throw error;
      }
      if (!isActiveShellRunStatus(current.status)) return current;
      return this.input.store.updateShellRun(current.sessionId, current.shellRunId, buildPatch());
    }
  }

  private async actionableRecords(sessionId: string): Promise<ShellRunRecord[]> {
    const records = await this.input.store.listSessionShellRuns(sessionId);
    return records
      .filter(
        (record) =>
          isActiveShellRunStatus(record.status) ||
          (record.observedAt === undefined && isTerminalShellRunStatus(record.status)),
      )
      .sort(compareActionableShellRuns);
  }

  private notifyShellRunUpdate(record: ShellRunRecord): void {
    try {
      this.input.onShellRunUpdate?.(shellRunUpdate(record));
    } catch {
      // Durable state is authoritative; presentation observers are best-effort.
    }
  }

  private armTimeout(live: LiveShellRun): void {
    if (live.timeoutMs === undefined) return;
    live.cancelTimeout = this.scheduleTimeout(() => {
      if (live.rootExited || live.finalizeOnce || live.termination) return;
      live.lifecycleCause ??= 'timeout';
      this.requestForcedTermination(live, 'timeout');
    }, live.timeoutMs);
  }

  private clearLiveTimers(live: LiveShellRun): void {
    live.cancelTimeout?.();
    if (live.mode === 'pty' && live.rawPublishTimer) {
      clearTimeout(live.rawPublishTimer);
    }
    live.cancelFlush?.();
    live.cancelTimeout = undefined;
    if (live.mode === 'pty') live.rawPublishTimer = undefined;
    live.cancelFlush = undefined;
  }

  private sessionTerminationEpoch(sessionId: string): number {
    return this.sessionTerminationEpochs.get(sessionId) ?? 0;
  }

  private async withPendingStartup<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    let resolveStartup!: () => void;
    const startup = new Promise<void>((resolve) => {
      resolveStartup = resolve;
    });
    const startups = this.pendingStartups.get(sessionId) ?? new Set<Promise<void>>();
    startups.add(startup);
    this.pendingStartups.set(sessionId, startups);
    try {
      return await operation();
    } finally {
      startups.delete(startup);
      if (startups.size === 0) this.pendingStartups.delete(sessionId);
      resolveStartup();
    }
  }

  private async awaitSessionStartups(sessionId: string): Promise<void> {
    const startups = this.pendingStartups.get(sessionId);
    if (startups) await Promise.all([...startups]);
  }

  private async settleSessionLives(sessionId: string): Promise<void> {
    const failures: unknown[] = [];
    const sessionLives = () =>
      [...this.live.values()].filter((live) => live.sessionId === sessionId);
    await this.captureTerminationFailure(this.terminateLives(sessionLives(), 'shutdown'), failures);
    await this.awaitSessionStartups(sessionId);
    await this.captureTerminationFailure(this.terminateLives(sessionLives(), 'shutdown'), failures);
    if (failures.length > 0) throw failures[0];
  }

  private async captureTerminationFailure(
    termination: Promise<void>,
    failures: unknown[],
  ): Promise<void> {
    try {
      await termination;
    } catch (error) {
      failures.push(error);
    }
  }

  private holdSessionClose(lease: SessionCloseLease): void {
    const leases = this.sessionCloseLeases.get(lease.sessionId) ?? new Set<symbol>();
    leases.add(lease.token);
    this.sessionCloseLeases.set(lease.sessionId, leases);
  }

  private assertStartAllowed(sessionId: string, sessionEpoch: number): void {
    if (this.shuttingDown) {
      throw abortError('Command aborted because the shell runtime is shutting down');
    }
    if (
      this.sessionCloseLeases.has(sessionId) ||
      this.sessionTerminationEpoch(sessionId) !== sessionEpoch
    ) {
      throw abortError('Command aborted because the session lifecycle changed');
    }
  }

  private currentGeneration(live: LiveShellRun): number {
    return live.collector.currentGeneration();
  }

  private reserveSlot(mode: ShellMode): ShellRunSlotReservation {
    // The counters are manager-wide, so the session that hits the cap may own
    // none of the runs holding it. Waiting is therefore the only recovery
    // action available to every caller; stopping one of its own tasks is a
    // conditional alternative.
    if (this.reservedShellRuns >= this.maxLiveShellRuns) {
      throw new Error(
        `No free background task slot: the runtime is at its limit of ${this.maxLiveShellRuns} ` +
          'live background tasks. The limit is shared across sessions, so some of them may not be ' +
          'yours. Wait for a running background task to finish and try again, or, if you have a ' +
          'tool for stopping background tasks, stop one you started.',
      );
    }
    if (mode === 'pty' && this.reservedPtyRuns >= this.maxLivePtyRuns) {
      throw new Error(
        `No free interactive (PTY) background task slot: the runtime is at its limit of ` +
          `${this.maxLivePtyRuns} live interactive tasks. The limit is shared across sessions, so ` +
          'some of them may not be yours. Run this command as a non-interactive background task, ' +
          'which does not use this limit, or wait for a running interactive task to finish and ' +
          'try again.',
      );
    }
    this.reservedShellRuns += 1;
    if (mode === 'pty') this.reservedPtyRuns += 1;
    return { mode, released: false };
  }

  private releaseLiveSlot(live: LiveShellRun): void {
    this.releaseSlot(live.slotReservation);
  }

  private releaseSlot(reservation: ShellRunSlotReservation): void {
    if (reservation.released) return;
    reservation.released = true;
    this.reservedShellRuns -= 1;
    if (reservation.mode === 'pty') this.reservedPtyRuns -= 1;
  }
}

function onceShellRunCompletion(
  callback: ShellRunBashInput['onCompletion'],
): ShellRunBashInput['onCompletion'] {
  if (!callback) return undefined;
  let completed = false;
  return (outcome) => {
    if (completed) return;
    completed = true;
    callback(outcome);
  };
}

function notifyFailedStartup(callback: ShellRunBashInput['onCompletion']): void {
  try {
    callback?.({ successful: false });
  } catch {
    // Resource cleanup errors must not replace the original startup failure.
  }
}

function createTerminationLifecycle(): TerminationLifecycle {
  return {
    initialDecision: new CompletionLatch<void>(),
    initialSignal: new CompletionLatch<boolean>(),
    finished: new CompletionLatch<void>(),
  };
}

function isPtyControlOpen(live: LivePtyShellRun): boolean {
  return (
    live.record.status === 'running' &&
    !hasUndecidedPendingStop(live) &&
    !live.driverExit &&
    !live.termination &&
    !live.integrityFailure
  );
}

function hasUndecidedPendingStop(live: LivePtyShellRun): boolean {
  for (const pending of live.pendingStops) {
    if (pending.current() === undefined) return true;
  }
  return false;
}

function naturalExitCode(exit: DriverExit | undefined): number {
  if (!exit) return 1;
  if (exit.mode === 'pty') {
    if (exit.value.signal && exit.value.signal > 0) return 128 + exit.value.signal;
    return exit.value.exitCode;
  }
  if (exit.value.exitCode !== null) return exit.value.exitCode;
  const signal = exit.value.signal;
  return signal ? 128 + (osConstants.signals[signal] ?? 0) : 1;
}

function safeFailureMessage(error: Error): string {
  const message = redactSecrets(error.message || 'Shell runtime integrity failure');
  return message.length <= 500 ? message : `${message.slice(0, 497)}...`;
}

function startupPersistenceError(startupError: Error, persistenceFailure: unknown): Error {
  const persistenceError = asError(
    persistenceFailure,
    'ShellRun startup terminal persistence failed',
  );
  return new Error(
    `Shell process startup failed: ${safeFailureMessage(startupError)}; failed to persist terminal ShellRun after retry: ${safeFailureMessage(persistenceError)}`,
    { cause: new AggregateError([startupError, persistenceError]) },
  );
}

function startupCleanupError(startupError: Error, cleanupFailure: unknown): Error {
  const cleanupError = asError(cleanupFailure, 'Shell process startup cleanup failed');
  return new Error(
    `Shell process startup failed: ${safeFailureMessage(startupError)}; startup cleanup failed: ${safeFailureMessage(cleanupError)}`,
    { cause: new AggregateError([startupError, cleanupError]) },
  );
}

function compareActionableShellRuns(a: ShellRunRecord, b: ShellRunRecord): number {
  const rank = (record: ShellRunRecord) => (isActiveShellRunStatus(record.status) ? 1 : 0);
  return (
    rank(a) - rank(b) ||
    b.updatedAt - a.updatedAt ||
    b.startedAt - a.startedAt ||
    a.shellRunId.localeCompare(b.shellRunId)
  );
}

async function racePromiseWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError('Operation aborted');
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError('Operation aborted'));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function normalizeBackgroundTimeoutMs(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_SHELL_RUN_TIMEOUT_MS) {
    throw new Error(`Background Bash timeout must be between 1 and ${MAX_SHELL_RUN_TIMEOUT_MS}ms`);
  }
  return value;
}

function splitPtyData(data: string): string[] {
  const codePoints = Array.from(data);
  const chunks: string[] = [];
  for (let offset = 0; offset < codePoints.length; offset += PTY_RAW_INPUT_CHUNK_CODE_POINTS) {
    chunks.push(codePoints.slice(offset, offset + PTY_RAW_INPUT_CHUNK_CODE_POINTS).join(''));
  }
  return chunks;
}

function encodedPtyDataBytes(data: string): number {
  return Buffer.byteLength(JSON.stringify(data), 'utf8');
}

function validateSourceToolCallId(value: string): void {
  if (!isShellRunSourceToolCallId(value)) {
    throw new Error(
      `ShellRun source tool-call ID must be non-empty and at most ${SHELL_RUN_SOURCE_TOOL_CALL_ID_MAX_BYTES} UTF-8 bytes`,
    );
  }
}

function requireProgram(argv: readonly string[]): string {
  const program = argv[0];
  if (!program) throw new Error('Transformed Bash argv must include a program');
  return program;
}

function normalizeForegroundTimeoutMs(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_FOREGROUND_BASH_TIMEOUT_MS) {
    throw new Error(
      `Foreground Bash timeout must be between 1 and ${MAX_FOREGROUND_BASH_TIMEOUT_MS}ms`,
    );
  }
  return value;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(`${fallback}: ${String(error)}`);
}
