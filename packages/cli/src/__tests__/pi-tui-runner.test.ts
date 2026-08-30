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

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { SHELL_RUN_UPDATE_BUFFER_MAX_ENTRIES } from '@maka/core/shell-run-result';
import { type PermissionMode } from '@maka/core/permission';
import { type OrchestrationMode } from '@maka/core/orchestration';
import { type SessionEvent, type ShellRunUpdate } from '@maka/core/events';
import { type SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import { type SessionSummary, type StoredMessage } from '@maka/core/session';
import { type ThinkingLevel } from '@maka/core/model-thinking';
import type { ConnectionCatalogSnapshot } from '@maka/core/runtime-policy';
import { type UserQuestionResponse } from '@maka/core/user-question';
import type { SkillInvocationResult } from '@maka/core/skill-invocation';
import type {
  AgentGraphClientSnapshot,
  TurnMessageSubmitResult,
} from '@maka/runtime-host/protocol';
import { SessionActivityRegistry } from '@maka/runtime/goal-turn-lifecycle';
import { type ContextDiagnostics } from '@maka/runtime/context-diagnostics';
import type { GoalProjection, TurnResumeParkReason } from '@maka/runtime-host/protocol';
import type {
  MakaPreparePromptOptions,
  MakaPreparedSessionTurn,
  MakaAttachedSessionTurn,
  MakaSessionMoveResult,
  MakaSessionDriver,
  MakaSideConversationParentStatus,
  MakaSessionRewindResult,
  MakaSessionSwitchOptions,
  MakaSessionSwitchResult,
  MakaSubmitMessageOptions,
  MakaTranscriptReplacementReason,
  RewindTarget,
  SessionResumeAvailability,
} from '../session-driver.js';
import { skillInvocationBlockedMessage } from '../session-driver.js';
import { SafeBoundaryResumeParkedError } from '../runtime-host-session-driver.js';
import { listApiKeyOnboardableProviders } from '../onboarding-catalog.js';
import { projectRuntimeHostModelChoices } from '../runtime-host-onboarding.js';
import { modelChoiceConnectionLabels } from '../pi-tui-pickers.js';
import type {
  MakaOnboardingSurface,
  MakaPiTuiTurnActivitySurface,
  ModelChoice,
  OnboardingProviderEntry,
  OnboardingSaveInput,
  OnboardingSaveResult,
  OnboardingVerifyInput,
  OnboardingVerifyResult,
} from '../pi-tui-contracts.js';
import {
  resolveTaskbarProgress,
  runMakaPiTui as runMakaPiTuiImpl,
  type MakaPiTuiInput,
} from '../pi-tui-runner.js';
import { AUTO_RECAP_IDLE_MS } from '../session-recap.js';
import { BUSY_SPINNER_FRAMES } from '../tui-attention.js';
import { EXPANSION_COLLAPSE_CONFIRM_WINDOW_MS } from '../pi-transcript.js';
import type { TuiMcpAction, TuiMcpManagement } from '../tui-mcp-control.js';
import {
  autocompleteSuggestionLines,
  assertBottomPickerPlacement,
  FakeTerminal,
  findInputSurfaceRows,
  latestPlainLineContaining,
  plainTerminalOutput,
  WAIT_BUDGET_MS,
  waitFor,
  waitForTuiPaint,
} from './tui-terminal-mock.js';

// Deadline for `Promise.race([run, …])` close watchdogs. A passing race
// resolves the moment `run` settles, so this only bounds how long a FAILING
// close takes to report — the same budget split as waitFor's WAIT_BUDGET_MS
// (tight locally, generous on loaded CI runners).
const CLOSE_BUDGET_MS = Math.max(WAIT_BUDGET_MS, 500);

type TestMakaPiTuiInput = Omit<MakaPiTuiInput, 'driver' | 'turnActivity'> & {
  driver: MakaSessionDriver;
  turnActivity?: MakaPiTuiTurnActivitySurface;
};

function runMakaPiTui(input: TestMakaPiTuiInput): Promise<void> {
  const { driver, turnActivity, ...rest } = input;
  return runMakaPiTuiImpl({
    ...rest,
    driver,
    taskbarProgress: input.taskbarProgress ?? true,
    turnActivity: turnActivity ?? createTestTurnActivity(),
  });
}

interface TestPromptDriver {
  getSessionId(): string | null;
  promptEvents(prompt: string): AsyncIterable<SessionEvent>;
}

function prepareTestPrompt(
  driver: TestPromptDriver,
  prompt: string,
  turnId = 'turn-1',
): Promise<MakaPreparedSessionTurn> {
  return Promise.resolve({
    sessionId: driver.getSessionId() ?? 'session-1',
    turnId,
    events: driver.promptEvents(prompt),
  });
}

function createTestTurnActivity(
  activities = new SessionActivityRegistry(),
): MakaPiTuiTurnActivitySurface {
  return { activities };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function historicalGraphSnapshot(graphId: string): AgentGraphClientSnapshot {
  return {
    schemaVersion: 1,
    rootSessionId: 'session-1',
    graphId,
    orchestrationMode: 'graph',
    snapshotVersion: `sha256:${'1'.repeat(64)}`,
    status: 'completed',
    scheduleRevision: 2,
    topologyFingerprint: `sha256:${'2'.repeat(64)}`,
    closed: true,
    operators: [],
    edges: [],
    work: [],
    reconciliationFailures: [],
    stoppedTargets: [],
    finish: { resultIds: ['result-1'], reason: 'done', revision: 2, committedAt: 2 },
    claims: [],
    recentControlDecisions: [],
    recentActivity: [],
    terminalHistory: { records: [] },
    omitted: {
      operators: 0,
      edges: 0,
      work: 0,
      reconciliationFailures: 0,
      stoppedTargets: 0,
      claims: 0,
      controlDecisions: 0,
      recentActivity: 0,
    },
  };
}

/** Catalog API-key providers as wizard entries with no existing connection —
 *  the default `/setup` provider list for tests that don't need configured state. */
function defaultOnboardingProviders(): OnboardingProviderEntry[] {
  return listApiKeyOnboardableProviders().map((provider) => ({
    ...provider,
    target: { kind: 'create', providerType: provider.providerType },
    label: provider.label,
    enabledModelIds: [],
  }));
}

interface FakeOnboardingOpts {
  providers?: OnboardingProviderEntry[];
  verify?: (input: OnboardingVerifyInput) => Promise<OnboardingVerifyResult>;
  save?: (input: OnboardingSaveInput) => Promise<OnboardingSaveResult>;
}

/** A controllable `/setup` surface: the wizard calls `listProviders` to open,
 *  `verify` to check a key and discover models, and `save` to persist. Defaults
 *  verify two models and save ok so a test can drive the whole flow by opting
 *  into the branches it cares about. */
function fakeOnboardingSurface(opts: FakeOnboardingOpts = {}): MakaOnboardingSurface {
  return {
    listProviders: async () => opts.providers ?? defaultOnboardingProviders(),
    verify:
      opts.verify ??
      (async () => ({ kind: 'ok', models: [{ id: 'gpt-5.5' }, { id: 'gpt-5.5-mini' }] })),
    save: opts.save ?? (async () => savedOnboardingResult()),
  };
}

function savedOnboardingResult(
  modelChoices: ModelChoice[] = [],
  connectionId = 'saved-connection-id',
): OnboardingSaveResult {
  return {
    kind: 'ok',
    connection: {
      connectionId,
      revision: 1,
      slug: 'openai',
      providerType: 'openai',
    },
    refresh: { kind: 'ok', modelChoices, connectionIdentities: [] },
  };
}

function savedOnboardingRefreshFailed(connectionId = 'saved-connection-id'): OnboardingSaveResult {
  return {
    kind: 'ok',
    connection: {
      connectionId,
      revision: 1,
      slug: 'openai',
      providerType: 'openai',
    },
    refresh: {
      kind: 'failed',
      reason: 'catalog_unavailable',
    },
  };
}

describe('Maka Pi TUI runner', () => {
  test('/help uses the resolved locale for headings and command descriptions', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      locale: 'zh',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    await waitForTuiPaint(terminal);
    terminal.input('/help');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('快捷键'));
    const output = plainTerminalOutput(terminal.output());
    assert.match(output, /\/compact\s+— 压缩会话上下文/);
    assert.match(output, /!<command> — 执行一次仅用户可见的 shell 命令/);
    assert.match(output, /Ctrl\+D — 输入为空时退出/);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('!<command> runs once without opening an agent turn', async () => {
    const terminal = new FakeTerminal();
    const driver = new UserCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    await waitForTuiPaint(terminal);
    terminal.input('!pwd');
    terminal.input('\r');
    await waitFor(() => driver.commands.includes('pwd'));
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('User command'));
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await run;
  });

  test('a second leading bang remains part of the shell command', async () => {
    const terminal = new FakeTerminal();
    const driver = new UserCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    await waitForTuiPaint(terminal);
    terminal.input('!!pwd');
    terminal.input('\r');
    await waitFor(() => driver.commands.includes('!pwd'));
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await run;
  });

  test('a submitted bare ! shows usage without starting a turn', async () => {
    const terminal = new FakeTerminal();
    const driver = new UserCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      locale: 'zh',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    await waitForTuiPaint(terminal);
    terminal.input('!');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Usage: !<command>'));
    assert.deepEqual(driver.commands, []);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await run;
  });

  test('Ctrl-C stops a running user command without exiting the TUI', async () => {
    const terminal = new FakeTerminal();
    const driver = new RunningUserCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    await waitForTuiPaint(terminal);
    terminal.input('!sleep 3600');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('User command'));

    terminal.input('\x03');
    await waitFor(() => driver.stopUserCommandCalls === 1);
    assert.equal(terminal.stopCalls, 0);

    exitMaka(terminal);
    await run;
  });

  test('a rejected startNewSession aborts /new with identity and transcript intact (#3210 review)', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    let attempted = 0;
    driver.startNewSession = async () => {
      attempted += 1;
      // Mirrors the real driver: the barrier-aware user-command stop rejected,
      // so the identity swap must not commit.
      throw new Error('host_draining');
    };
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      listShellRunUpdates: async () => [],
    });

    await waitForTuiPaint(terminal);
    const transcriptBefore = plainTerminalOutput(terminal.screenOutput());
    terminal.input('/new');
    terminal.input('\r');
    await waitFor(() => attempted === 1);
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('host_draining'));

    // Identity untouched…
    assert.equal(driver.getSessionId(), 'session-1');
    // …and the transcript was not wiped by the aborted /new.
    assert.match(plainTerminalOutput(terminal.screenOutput()), /host_draining/);
    assert.ok(transcriptBefore.length > 0);

    exitMaka(terminal);
    await run;
  });

  test('a rejected user-command stop hands Ctrl-C back to the exit chord (#3210)', async () => {
    const terminal = new FakeTerminal();
    const driver = new RejectingUserCommandStopDriver();
    const processExitCodes: number[] = [];
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      onProcessExit: (exitCode) => processExitCodes.push(exitCode),
    });

    await waitForTuiPaint(terminal);
    terminal.input('!sleep 3600');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('User command'));

    // The first Ctrl+C is captured to stop the command, but the stop rejects:
    // no terminal update is published, so the card still reads running.
    terminal.input('\x03');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('host_draining'));
    assert.equal(driver.stopUserCommandCalls, 1);
    assert.equal(terminal.stopCalls, 0);

    // The capture must disarm: the next press shows the exit prompt and the
    // one after exits.
    terminal.input('\x03');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Press Ctrl+C again to exit.'),
    );
    assert.equal(driver.stopUserCommandCalls, 1);
    assert.equal(terminal.stopCalls, 0);

    terminal.input('\x03');
    await run;
    assert.deepEqual(processExitCodes, [0]);
  });

  test('a new user command re-arms Ctrl-C after an earlier stop rejection', async () => {
    const terminal = new FakeTerminal();
    const driver = new RejectingUserCommandStopDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    await waitForTuiPaint(terminal);
    terminal.input('!first');
    terminal.input('\r');
    await waitFor(() => driver.commands.length === 1);
    terminal.input('\x03');
    await waitFor(() => driver.stopUserCommandCalls === 1);

    terminal.input('!second');
    terminal.input('\r');
    await waitFor(() => driver.commands.length === 2);
    terminal.input('\x03');
    await waitFor(() => driver.stopUserCommandCalls === 2);
    assert.equal(terminal.stopCalls, 0);

    exitMaka(terminal);
    await run;
  });

  test('same-session reconnect keeps a user-command card for its terminal update', async () => {
    const terminal = new FakeTerminal();
    const driver = new RunningUserCommandDriver();
    let publishShellRun: ((update: ShellRunUpdate) => void) | undefined;
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      subscribeShellRunUpdates: (listener) => {
        publishShellRun = listener;
        return () => {
          publishShellRun = undefined;
        };
      },
    });

    await waitForTuiPaint(terminal);
    terminal.input('!printf done');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('User command'));

    driver.publishReconnect();
    publishShellRun?.({
      sessionId: 'session-1',
      ownership: { kind: 'local' },
      sourceTurnId: 'user-command-1',
      sourceToolCallId: 'user-command-1',
      result: {
        kind: 'shell_run',
        ref: 'maka://runtime/background-tasks/user-command-1',
        mode: 'pipes',
        status: 'completed',
        cwd: '/repo',
        cmd: 'printf done',
        startedAt: 1,
        updatedAt: 2,
        completedAt: 2,
        exitCode: 0,
        revision: 2,
        output: pipeOutput('done\n'),
      },
    });

    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('done'));
    assert.match(plainTerminalOutput(terminal.screenOutput()), /User command/);

    exitMaka(terminal);
    await run;
  });

  test('disables taskbar progress on Windows and Windows Terminal by default', () => {
    assert.equal(resolveTaskbarProgress(undefined, { platform: 'win32' }), false);
    assert.equal(
      resolveTaskbarProgress(undefined, {
        platform: 'linux',
        windowsTerminalSession: 'session-id',
      }),
      false,
    );
    assert.equal(resolveTaskbarProgress(undefined, { platform: 'linux' }), true);
    assert.equal(resolveTaskbarProgress(undefined, { platform: 'darwin' }), true);
  });

  test('allows environment and explicit taskbar progress overrides', () => {
    assert.equal(
      resolveTaskbarProgress(undefined, { platform: 'win32', override: ' true ' }),
      true,
    );
    assert.equal(resolveTaskbarProgress(undefined, { platform: 'linux', override: '0' }), false);
    assert.equal(
      resolveTaskbarProgress(undefined, { platform: 'win32', override: 'invalid' }),
      false,
    );
    assert.equal(
      resolveTaskbarProgress(false, {
        platform: 'linux',
        override: '1',
      }),
      false,
    );
    assert.equal(
      resolveTaskbarProgress(true, {
        platform: 'win32',
        override: '0',
      }),
      true,
    );
  });

  test('does not publish taskbar progress when the policy disables it', async () => {
    const terminal = new FakeTerminal();
    const driver = new InterruptibleTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      taskbarProgress: false,
    });

    terminal.input('run');
    terminal.input('\r');
    // The double Escape interrupts a *running* Turn, so wait for the Host-
    // admitted Turn to reach the drain rather than for the Message to be sent.
    await waitFor(() => driver.streamPulls === 1);
    terminal.input('\x1b');
    terminal.input('\x1b');
    await waitFor(() => driver.stopCalls === 1);
    terminal.input('/exit');
    terminal.input('\r');
    await run;

    assert.deepEqual(terminal.progressStates, []);
  });

  test('keeps slash autocomplete visible while a short terminal resizes', async () => {
    const terminal = new FakeTerminal(40, 20);
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    await waitForTuiPaint(terminal);
    terminal.input('/');
    await waitFor(() => {
      const screen = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
      return autocompleteSuggestionLines(screen).some((line) => line.includes('→ /compact'));
    });

    let screen = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
    const initialInputRows = findInputSurfaceRows(screen);
    assert.ok(initialInputRows);
    let [topBorder, bottomBorder] = initialInputRows;
    const firstCounter = /^\s*\((\d+)\/(\d+)\)\s*$/.exec(screen[topBorder - 1] ?? '');
    assert.ok(firstCounter);
    const totalCommands = Number(firstCounter[2]);
    const shortVisibleCommands = autocompleteSuggestionLines(screen).length;
    assert.ok(totalCommands > shortVisibleCommands);
    assert.equal(bottomBorder, terminal.rows - 2);
    assert.ok(autocompleteSuggestionLines(screen).some((line) => line.includes('→ /compact')));

    terminal.input('\x1b[A');
    await waitFor(() => {
      const current = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
      const currentInputRows = findInputSurfaceRows(current);
      if (!currentInputRows) return false;
      const [currentTopBorder] = currentInputRows;
      return (
        current[currentTopBorder - 1]?.includes(`(${totalCommands}/${totalCommands})`) === true
      );
    });
    screen = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
    const selectedInputRows = findInputSurfaceRows(screen);
    assert.ok(selectedInputRows);
    [topBorder, bottomBorder] = selectedInputRows;
    assert.ok(autocompleteSuggestionLines(screen).some((line) => line.includes('→ /')));
    assert.equal(bottomBorder, terminal.rows - 2);

    terminal.resize(80, 40);
    await waitFor(() => {
      const current = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
      return autocompleteSuggestionLines(current).length > shortVisibleCommands;
    });
    screen = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
    assert.ok(screen.some((line) => line.includes(`(${totalCommands}/${totalCommands})`)));
    assert.ok(autocompleteSuggestionLines(screen).some((line) => line.includes('→ /')));

    terminal.resize(40, 20);
    await waitFor(() => {
      const current = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
      const currentInputRows = findInputSurfaceRows(current);
      if (!currentInputRows) return false;
      const [currentTopBorder, currentBottomBorder] = currentInputRows;
      return (
        currentBottomBorder === terminal.rows - 2 &&
        current[currentTopBorder - 1]?.includes(`(${totalCommands}/${totalCommands})`) === true
      );
    });

    exitMaka(terminal);
    await run;
  });

  test('restores the terminal before exiting on SIGTERM', async () => {
    const { code, signal, stdout } = await runSignalExitProbe('SIGTERM');

    assert.equal(signal, null);
    assert.equal(code, 143);
    assert.match(stdout, /TERMINAL_STOP/);
    assert.match(stdout, /CLOSED/);
  });

  test('forces signal exit when outer cleanup never settles after terminal restoration', async () => {
    const { code, signal, stdout } = await runSignalExitProbe('SIGTERM', true);

    assert.equal(signal, null);
    assert.equal(code, 143);
    assert.match(stdout, /TERMINAL_STOP/);
    assert.match(stdout, /CLOSED/);
  });

  test('restores the terminal before reporting an uncaught exception', async () => {
    const { code, signal, stdout, stderr } = await runFatalExitProbe('uncaughtException');

    assert.equal(signal, null);
    assert.equal(code, 1);
    assert.match(stdout, /TERMINAL_STOP/);
    assert.match(stdout, /CLOSED/);
    assert.match(stderr, /fatal probe/);
  });

  test('restores the terminal when driver stop rejects during close', async () => {
    const terminal = new FakeTerminal();
    const driver = new RejectingStopDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'bypass',
      terminal,
    });

    exitMaka(terminal);

    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);

    assert.equal(driver.stopCalls, 1);
    assert.equal(terminal.stopCalls, 1);
    assert.equal(terminal.progressStates.at(-1), false);
  });

  test('restores the terminal before a slow driver stop settles', async () => {
    const terminal = new FakeTerminal();
    const driver = new HangingCloseDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'bypass',
      terminal,
    });

    terminal.input('/exit');
    terminal.input('\r');
    await waitFor(() => driver.stopCalls === 1);
    try {
      assert.equal(terminal.stopCalls, 1);
    } finally {
      driver.releaseStop();
      await run;
    }
  });

  test('restores the terminal when focus reporting fails after TUI start', async () => {
    const terminal = new ThrowingFocusReportTerminal();
    const driver = new SlashCommandDriver();
    const previousExitCode = process.exitCode;

    try {
      await assert.rejects(
        runMakaPiTui({
          title: 'Maka',
          driver,
          cwd: '/repo',
          model: 'deepseek-v4-flash',
          connectionSlug: 'deepseek',
          permissionMode: 'ask',
          terminal,
        }),
        /focus reporting failed/,
      );
      assert.equal(terminal.stopCalls, 1);
    } finally {
      if (terminal.stopCalls === 0) process.emit('SIGTERM');
      process.exitCode = previousExitCode;
    }
  });

  test('verify failure re-arms the key prompt so the key can be retried', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const verifyCalls: string[] = [];
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'bypass',
      locale: 'zh',
      terminal,
      onboarding: fakeOnboardingSurface({
        verify: async (input) => {
          verifyCalls.push(input.apiKey ?? '');
          return verifyCalls.length === 1
            ? { kind: 'rejected', reason: 'connection_not_found' }
            : { kind: 'ok', models: [{ id: 'gpt-5.5' }] };
        },
      }),
    });

    await waitForTuiPaint(terminal);
    terminal.input('/setup');
    terminal.input('\r');
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), '配置模型提供商') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('\r'); // pick provider -> key phase
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'API key') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('sk-bad');
    terminal.input('\r');
    await waitFor(() => verifyCalls.length === 1);
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), '该连接已不存在') !== null;
      } catch {
        return false;
      }
    });
    // Retrying with a good key verifies and advances to the models step.
    terminal.input('sk-good');
    terminal.input('\r');
    await waitFor(() => verifyCalls.length === 2);
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('3/3'));
    assert.deepEqual(verifyCalls, ['sk-bad', 'sk-good']);

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('localizes a save rejection without displaying Host text', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    let saveCalls = 0;
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'bypass',
      locale: 'zh',
      terminal,
      onboarding: fakeOnboardingSurface({
        save: async () => {
          saveCalls += 1;
          return { kind: 'rejected', reason: 'superseded' };
        },
      }),
    });

    await waitForTuiPaint(terminal);
    terminal.input('/setup');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('配置模型提供商'));
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('API key'));
    terminal.input('sk-test');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('3/3'));
    terminal.input(' ');
    terminal.input('\r');
    await waitFor(() => saveCalls === 1);
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('该连接已发生变化'));
    assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /This connection changed/);

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('threads the selected same-provider account identity through verify and save', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const verifyCalls: OnboardingVerifyInput[] = [];
    const saveCalls: OnboardingSaveInput[] = [];
    const provider = listApiKeyOnboardableProviders().find(
      (candidate) => candidate.providerType === 'openai',
    );
    assert.ok(provider);
    const providers: OnboardingProviderEntry[] = [
      {
        ...provider,
        label: 'OpenAI · openai',
        target: { kind: 'existing', connectionId: 'connection-openai-1' },
        connectionSlug: 'openai',
        enabledModelIds: [],
      },
      {
        ...provider,
        label: 'OpenAI · openai-2',
        target: { kind: 'existing', connectionId: 'connection-openai-2' },
        connectionSlug: 'openai-2',
        enabledModelIds: [],
      },
    ];
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'gpt-5.5',
      connectionId: 'connection-openai-1',
      connectionSlug: 'openai',
      providerType: 'openai',
      permissionMode: 'bypass',
      terminal,
      onboarding: fakeOnboardingSurface({
        providers,
        verify: async (input) => {
          verifyCalls.push(input);
          return { kind: 'ok', models: [{ id: 'gpt-5.5' }] };
        },
        save: async (input) => {
          saveCalls.push(input);
          return savedOnboardingResult([], 'connection-openai-2');
        },
      }),
    });

    await waitForTuiPaint(terminal);
    terminal.input('/setup');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('openai-2'));
    terminal.input('\x1b[B');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('API key'));
    terminal.input('\r'); // reuse the selected account's stored key
    await waitFor(() => verifyCalls.length === 1);
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('3/3'));
    terminal.input(' ');
    terminal.input('\r');
    await waitFor(() => saveCalls.length === 1);

    const expectedTarget = { kind: 'existing' as const, connectionId: 'connection-openai-2' };
    assert.deepEqual(verifyCalls[0]?.target, expectedTarget);
    assert.deepEqual(saveCalls[0]?.target, expectedTarget);

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('an armed key prompt routes a slash command instead of swallowing it as the key', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const verifyCalls: unknown[] = [];
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'bypass',
      terminal,
      onboarding: fakeOnboardingSurface({
        verify: async (req) => {
          verifyCalls.push(req);
          return { kind: 'ok', models: [] };
        },
      }),
    });

    await waitForTuiPaint(terminal);
    terminal.input('/setup');
    terminal.input('\r');
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'Set Up Provider') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('\r'); // pick provider -> arms the key prompt
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'API key') !== null;
      } catch {
        return false;
      }
    });
    // A slash command typed while armed must route as a command, not be stored
    // as the API key (otherwise /exit, /model, etc. become persisted secrets).
    terminal.input('/setup');
    terminal.input('\r');
    // The wizard restarts at the provider step (closeWizard + re-route): the
    // key field leaving the screen is the observable proof the input line was
    // routed as a command instead of being consumed as key text.
    await waitFor(() => {
      const screen = plainTerminalOutput(terminal.screenOutput());
      return screen.includes('Set Up Provider') && !screen.includes('API key');
    });

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
    // Anchored after close: every queued input has been fully processed, so a
    // swallowed-as-key submit would have surfaced in verifyCalls by now.
    assert.equal(verifyCalls.length, 0);
  });

  test('/setup without an onboarding surface reports unavailable in-frame instead of throwing', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    // No onboarding surface: a minimal host that can open /setup's picker (via
    // the catalog fallback) but cannot verify or save.
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'bypass',
      terminal,
    });

    await waitForTuiPaint(terminal);
    terminal.input('/setup');
    terminal.input('\r');
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'Set Up Provider') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('\r'); // pick provider -> key phase
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'API key') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('sk-test');
    terminal.input('\r');
    await waitFor(() => {
      try {
        return (
          latestPlainLineContaining(terminal.writes.join(''), 'Onboarding is unavailable') !== null
        );
      } catch {
        return false;
      }
    });

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('/setup reports a listProviders failure as an error instead of "no providers"', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'bypass',
      terminal,
      onboarding: {
        listProviders: async () => {
          throw new Error('storage read failed');
        },
        verify: async () => ({ kind: 'ok', models: [] }),
        save: async () => savedOnboardingResult(),
      },
    });

    await waitForTuiPaint(terminal);
    terminal.input('/setup');
    terminal.input('\r');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes(
        'Could not read configured connections',
      ),
    );
    assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /storage read failed/);
    assert.doesNotMatch(
      plainTerminalOutput(terminal.screenOutput()),
      /No configurable API key providers are available/,
    );

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('wizard ignores a verify result from an abandoned attempt', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const verifyCalls: Array<{ apiKey?: string }> = [];
    let resolveFirst!: (value: OnboardingVerifyResult) => void;
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'bypass',
      terminal,
      onboarding: fakeOnboardingSurface({
        verify: (input) => {
          verifyCalls.push({ apiKey: input.apiKey });
          return verifyCalls.length === 1
            ? new Promise<OnboardingVerifyResult>((r) => {
                resolveFirst = r;
              })
            : Promise.resolve<OnboardingVerifyResult>({ kind: 'ok', models: [{ id: 'gpt-5.5' }] });
        },
      }),
    });

    await waitForTuiPaint(terminal);
    terminal.input('/setup');
    terminal.input('\r');
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'Set Up Provider') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('\r'); // pick provider A -> key phase
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'API key') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('sk-a');
    terminal.input('\r'); // submit A — verify deferred, wizard shows verifying
    await waitFor(() => verifyCalls.length === 1);
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'Verifying') !== null;
      } catch {
        return false;
      }
    });
    // Abandon A: Esc back to search, move to the second provider, pick it, and
    // start typing its key (do not submit).
    terminal.input('\x1b');
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), '1/3') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('\x1b[B'); // down to the second provider
    terminal.input('\r');
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'API key') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('sk-b');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('sk-b'));
    // A's verify now resolves with a failure. It must not clobber attempt B:
    // no failure status line, and the key being typed for B survives.
    resolveFirst({ kind: 'failed', errorClass: 'auth' });
    // Sentinel render: one more typed key char forces a full repaint that lands
    // after A's settled continuation, so a wrongly-applied failure line would be
    // in this exact frame.
    terminal.input('x');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('sk-bx'));

    assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /验证失败/);

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('an abandoned create save keeps its committed identity for retry', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const saveCalls: OnboardingSaveInput[] = [];
    let resolveFirstSave!: (value: OnboardingSaveResult) => void;
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'bypass',
      terminal,
      onboarding: fakeOnboardingSurface({
        save: (input) => {
          saveCalls.push(input);
          return saveCalls.length === 1
            ? new Promise<OnboardingSaveResult>((r) => {
                resolveFirstSave = r;
              })
            : Promise.resolve(savedOnboardingResult([], 'committed-openai-id'));
        },
      }),
    });

    await waitForTuiPaint(terminal);
    terminal.input('/setup');
    terminal.input('\r');
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'Set Up Provider') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('\r'); // pick provider -> key phase
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'API key') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('sk-test');
    terminal.input('\r'); // verify ok -> models
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('3/3'));
    terminal.input(' '); // toggle the first model on
    terminal.input('\r'); // save A — deferred
    await waitFor(() => saveCalls.length === 1);
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'Saving') !== null;
      } catch {
        return false;
      }
    });
    // Abandon A: Esc back to the key step.
    terminal.input('\x1b');
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), '2/3') !== null;
      } catch {
        return false;
      }
    });
    // A's durable create succeeds but its follow-up catalog refresh fails. The
    // abandoned attempt must not show stale success, while its exact committed
    // identity must still replace the create target for a later submit.
    resolveFirstSave(savedOnboardingRefreshFailed('committed-openai-id'));
    // Sentinel render: typing into the key field forces a repaint that lands
    // after A's settled save continuation, so a wrongly-shown success frame
    // would be in this exact frame.
    terminal.input('sk-z');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('sk-z'));
    assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /Models enabled/u);

    terminal.input('\r'); // verify the now-existing Connection
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('3/3'));
    terminal.input('\r'); // preserve the prior selection and save again
    await waitFor(() => saveCalls.length === 2);
    assert.deepEqual(saveCalls[1]?.target, {
      kind: 'existing',
      connectionId: 'committed-openai-id',
    });

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('a late save cannot rebind a reselected create row', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const saveCalls: OnboardingSaveInput[] = [];
    let resolveFirstSave!: (value: OnboardingSaveResult) => void;
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'bypass',
      terminal,
      onboarding: fakeOnboardingSurface({
        save: (input) => {
          saveCalls.push(input);
          return saveCalls.length === 1
            ? new Promise<OnboardingSaveResult>((resolve) => {
                resolveFirstSave = resolve;
              })
            : Promise.resolve(savedOnboardingResult([], 'second-account-id'));
        },
      }),
    });

    await waitForTuiPaint(terminal);
    terminal.input('/setup');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Set Up Provider'));
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('API key'));
    terminal.input('sk-a');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('3/3'));
    terminal.input(' ');
    terminal.input('\r');
    await waitFor(() => saveCalls.length === 1);

    terminal.input('\x1b'); // models -> key
    terminal.input('\x1b'); // key -> provider search
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('1/3'));
    terminal.input('\r'); // reselect the same add-account row as a new intent
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('API key'));
    resolveFirstSave(savedOnboardingRefreshFailed('first-account-id'));
    terminal.input('sk-b');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('3/3'));
    terminal.input(' ');
    terminal.input('\r');
    await waitFor(() => saveCalls.length === 2);
    assert.deepEqual(saveCalls[1]?.target, saveCalls[0]?.target);
    assert.equal(saveCalls[1]?.target.kind, 'create');

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('wizard collects a base URL for a custom relay and threads it through verify and save', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const verifyCalls: Array<{ baseUrl?: string }> = [];
    const saveCalls: Array<{ baseUrl?: string }> = [];
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'bypass',
      terminal,
      onboarding: fakeOnboardingSurface({
        verify: async (input) => {
          verifyCalls.push(input);
          return { kind: 'ok', models: [{ id: 'relay/model' }] };
        },
        save: async (input) => {
          saveCalls.push(input);
          return savedOnboardingRefreshFailed('relay-connection-id');
        },
      }),
    });

    await waitForTuiPaint(terminal);
    terminal.input('/setup');
    terminal.input('\r');
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'Set Up Provider') !== null;
      } catch {
        return false;
      }
    });
    // Filter down to the relay entries and pick the first (OpenAI Chat).
    terminal.input('relay');
    terminal.input('\r');
    // The relay flow inserts the base-URL step (2/4) before the key.
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Base URL'));
    assert.ok(plainTerminalOutput(terminal.screenOutput()).includes('2/4'));
    // A malformed endpoint is rejected in place, before any host call.
    terminal.input('not a url');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('not a valid URL'));
    for (let i = 0; i < 'not a url'.length; i++) terminal.input('\x7f'); // clear the field
    terminal.input('https://relay.example.test/v1');
    terminal.input('\r');
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'API key') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('sk-relay');
    terminal.input('\r');
    await waitFor(() => verifyCalls.length === 1);
    assert.equal(verifyCalls[0]?.baseUrl, 'https://relay.example.test/v1');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('4/4'));
    terminal.input(' '); // toggle the discovered model on
    terminal.input('\r'); // save
    await waitFor(() => saveCalls.length === 1);
    assert.equal(saveCalls[0]?.baseUrl, 'https://relay.example.test/v1');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Models enabled'));
    assert.match(
      plainTerminalOutput(terminal.screenOutput()),
      /Account saved, but the model list has not refreshed/,
    );

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('a late abandoned save cannot replace the running model choices', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    let resolveFirstSave!: (value: OnboardingSaveResult) => void;
    const saveCalls: Array<{ enabledModelIds: readonly string[] }> = [];
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'bypass',
      terminal,
      onboarding: fakeOnboardingSurface({
        save: (input) => {
          saveCalls.push(input);
          return new Promise<OnboardingSaveResult>((r) => {
            resolveFirstSave = r;
          });
        },
      }),
    });

    await waitForTuiPaint(terminal);
    terminal.input('/setup');
    terminal.input('\r');
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'Set Up Provider') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('\r'); // pick provider -> key phase
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'API key') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('sk-test');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('3/3'));
    terminal.input(' '); // toggle the first model on
    terminal.input('\r'); // save — deferred
    await waitFor(() => saveCalls.length === 1);
    // Back out during saving: Esc to the key step, then Ctrl+C to close the wizard.
    terminal.input('\x1b');
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), '2/3') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('\x03'); // Ctrl+C closes the wizard
    // The wizard frame leaving the screen proves the overlay released input
    // focus, so the next line routes to the editor.
    await waitFor(() => !plainTerminalOutput(terminal.screenOutput()).includes('2/3'));
    // The save completes after the user left. Its projection may be older than
    // a newer attempt, so it must not replace the running model choices.
    resolveFirstSave(
      savedOnboardingResult([
        {
          connectionSlug: 'openai',
          connectionName: 'OpenAI',
          providerType: 'openai',
          model: 'gpt-5.5-new',
          isDefaultConnection: true,
        },
      ]),
    );
    // One macrotask turn lands after the save continuation.
    await delay(0);
    terminal.input('/model');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Select Model'));
    assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /gpt-5\.5-new/);
    assert.deepEqual(driver.models, []);

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('first-run wizard never reaches an agent turn after a slash command escapes the key field', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    let preparePromptCalls = 0;
    driver.preparePrompt = async () => {
      preparePromptCalls += 1;
      throw new Error('first-run onboarding: no agent turn before a connection exists');
    };
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: '',
      connectionSlug: '',
      permissionMode: 'bypass',
      terminal,
      firstRun: true,
      onboarding: fakeOnboardingSurface(),
    });

    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'Set Up Provider') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('\r'); // pick provider -> key phase
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'API key') !== null;
      } catch {
        return false;
      }
    });

    // A slash command typed in the key field escapes the wizard (designed, so
    // /exit still works). But after it closes, first-run must not hand control
    // to a connection-less driver: any later submit reopens the wizard instead
    // of opening an agent turn.
    terminal.input('/help');
    terminal.input('\r');
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'Keybindings') !== null;
      } catch {
        return false;
      }
    });

    terminal.input('hello');
    terminal.input('\r');
    // The wizard is back open as the only first-run surface; its frame is the
    // observable proof the submit was intercepted before reaching the driver.
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Set Up Provider'));
    assert.equal(preparePromptCalls, 0);

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('first-run closes after a durable save even when catalog refresh fails', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: '',
      connectionSlug: '',
      permissionMode: 'bypass',
      terminal,
      firstRun: true,
      onboarding: fakeOnboardingSurface({
        save: async () => savedOnboardingRefreshFailed('first-run-connection-id'),
      }),
    });

    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Set Up Provider'));
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('API key'));
    terminal.input('sk-test');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('3/3'));
    terminal.input(' ');
    terminal.input('\r');

    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('first-run TUI did not close after the committed save');
      }),
    ]);
    assert.equal(terminal.stopCalls, 1);
  });

  test('freezes and preserves the editor draft while a boundary request owns input', async () => {
    const terminal = new FakeTerminal();
    let releaseBoundaryRequest!: () => void;
    const boundaryRequestGate = new Promise<void>((resolve) => {
      releaseBoundaryRequest = resolve;
    });
    const driver = new SandboxBoundaryPromptDriver(
      ['/outside'],
      async () => {},
      async () => boundaryRequestGate,
    );
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    // The submit clearing the editor is the observable signal the next typed
    // text starts a fresh draft instead of appending to 'run'.
    await waitFor(() => {
      try {
        return editorInputText(terminal) === '';
      } catch {
        return false; // the first frame has not painted an editor yet
      }
    });
    terminal.input('keep this draft');
    await waitFor(() => editorInputText(terminal) === 'keep this draft');
    releaseBoundaryRequest();
    await waitFor(() => driver.boundaryRequests === 1);
    // The rendered prompt is the observable arming signal: only once it owns
    // input is 'x' a (rejected) decision key instead of editor text.
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Allow access outside the workspace?'),
    );

    terminal.input('x');
    terminal.input('n');
    await waitFor(() => driver.boundaryResponses.length === 1);
    // Input is processed in order, so a single deny response proves the armed
    // prompt ignored 'x': an 'x'-triggered response would either add a second
    // entry or change the first decision.
    assert.deepEqual(driver.boundaryResponses, [{ requestId: 'boundary-1', decision: 'deny' }]);
    await waitFor(() => editorInputText(terminal) === 'keep this draft');

    exitMaka(terminal);
    await run;
  });

  test('ignores repeated allow keys while a sandbox boundary request waits', async () => {
    const terminal = new FakeTerminal();
    const driver = new SandboxBoundaryPromptDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => driver.boundaryRequests === 1);
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Allow access outside the workspace?'),
    );
    terminal.input('\x1b[121;1:2u');
    terminal.input('y');
    await waitFor(() => driver.boundaryResponses.length === 1);
    exitMaka(terminal);
    await run;
    // After close every queued input has been drained: exactly one allow
    // response proves the armed prompt ignored the 'y' key-release event.
    assert.deepEqual(driver.boundaryResponses, [{ requestId: 'boundary-1', decision: 'allow' }]);
  });

  test('denies a pending sandbox boundary request from the terminal', async () => {
    const terminal = new FakeTerminal();
    const driver = new SandboxBoundaryPromptDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('r');
    terminal.input('u');
    terminal.input('n');
    terminal.input('\r');

    await waitFor(() => driver.boundaryRequests === 1);
    // The rendered prompt is the observable arming signal: only once it owns
    // input does 'n' mean deny instead of editor text.
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Allow access outside the workspace?'),
    );
    terminal.input('n');
    await waitFor(() => driver.boundaryResponses.length === 1);

    assert.deepEqual(driver.boundaryResponses, [
      {
        requestId: 'boundary-1',
        decision: 'deny',
      },
    ]);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('waits for boundary acknowledgement before advancing concurrent requests', async () => {
    const terminal = new FakeTerminal();
    let releaseFirstAck!: () => void;
    const firstAck = new Promise<void>((resolve) => {
      releaseFirstAck = resolve;
    });
    const driver = new SandboxBoundaryPromptDriver(['/first', '/second'], async (index) => {
      if (index === 0) await firstAck;
    });
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('r');
    terminal.input('u');
    terminal.input('n');
    terminal.input('\r');

    await waitFor(() => driver.boundaryRequests === 2);
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('/first'));
    assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /\/second/);

    terminal.input('n');
    await waitFor(() => driver.boundaryResponses.length === 1);
    terminal.input('y');
    await delay(0);
    assert.equal(driver.boundaryResponses.length, 1);
    assert.match(plainTerminalOutput(terminal.screenOutput()), /\/first/);
    assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /\/second/);

    releaseFirstAck();
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('/second'));

    terminal.input('y');
    await waitFor(() => driver.boundaryResponses.length === 2);
    assert.deepEqual(driver.boundaryResponses, [
      { requestId: 'boundary-1', decision: 'deny' },
      { requestId: 'boundary-2', decision: 'allow' },
    ]);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('answers sequential questions inline with a choice, Escape, and type-to-jump Other', async () => {
    const terminal = new FakeTerminal();
    const driver = new UserQuestionPromptDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('choose');
    terminal.input('\r');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Choose an approach'),
    );
    assertBottomPickerPlacement(
      terminal,
      'Choose an approach',
      'Maka · Auto · claude-sonnet-4-5 · claude-subscription · /repo',
    );
    // The preset options and the free-text "Other" row are on screen together —
    // the option list is no longer swapped out for a separate text overlay.
    const firstScreen = plainTerminalOutput(terminal.screenOutput());
    assert.ok(firstScreen.includes('Extend'));
    assert.ok(firstScreen.includes('Separate'));
    assert.ok(firstScreen.includes('Other: type your answer'));
    assert.ok(firstScreen.includes('Ctrl+C stop'));

    // Q1: Enter selects the highlighted first option (Extend).
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Keep the default'));
    // Q2: Escape leaves the question unanswered.
    terminal.input('\x1b');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Anything else'));
    // Q3: typing while an option is highlighted jumps straight into the Other
    // row and seeds it with the typed text — options stay visible throughout.
    terminal.input('Use the existing seam');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Use the existing seam'),
    );
    assert.ok(plainTerminalOutput(terminal.screenOutput()).includes('Nothing'));
    terminal.input('\r');

    await waitFor(() => driver.responses.length === 1);
    assert.deepEqual(driver.responses, [
      {
        requestId: 'question-1',
        answers: ['Extend', null, 'Use the existing seam'],
      },
    ]);

    exitMaka(terminal);
    await run;
  });

  test('Ctrl-C stops a turn while a user-question overlay is open', async () => {
    const terminal = new FakeTerminal();
    const driver = new UserQuestionPromptDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('choose');
    terminal.input('\r');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Choose an approach'),
    );
    terminal.input('\x03');

    await waitFor(() => driver.stopCalls === 1);
    assert.deepEqual(driver.responses, []);
    exitMaka(terminal);
    await run;
  });

  test('off-screen shell-run settle never clears scrollback (#1135)', async () => {
    const terminal = new FakeTerminal();
    const driver = new OffscreenSettleDriver();
    let listener: ((update: ShellRunUpdate) => void) | undefined;
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      subscribeShellRunUpdates: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    });

    terminal.input('r');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('late-build'));
    assert.ok(listener);
    // Settle the off-screen early card.
    listener({
      sessionId: 'session-1',
      ownership: { kind: 'local' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'tool-early',
      result: {
        kind: 'shell_run',
        ref: 'maka://runtime/background-tasks/bg-1',
        mode: 'pipes' as const,
        status: 'completed',
        cwd: '/repo',
        cmd: 'early-build',
        startedAt: 1_000,
        updatedAt: 5_000,
        completedAt: 5_000,
        exitCode: 0,
        revision: 5_000,
        output: pipeOutput('early-build done'),
      },
    });
    // Sentinel render: the typed char repaints in the same coalesced pass as
    // the settle-dirtied state, so a wrongful scrollback clear would have been
    // written by the time it shows.
    terminal.input('z');
    await waitFor(() => editorInputText(terminal) === 'z');

    assert.equal(terminal.output().includes('\x1b[3J'), false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('streaming text past the viewport keeps appending visible content (#1135)', async () => {
    const terminal = new FakeTerminal();
    const driver = new StreamingPastViewportDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('r');
    terminal.input('\r');
    // The assistant reply fills the viewport, then a second delta appends a
    // unique tail marker. The tail must be visible — the entry straddles the
    // scrollback/viewport boundary and only its scrollback prefix is frozen.
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('UNIQUE-TAIL-MARKER'));
    assert.equal(terminal.output().includes('\x1b[3J'), false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('renders a background ShellRun terminal update after the agent turn ends', async () => {
    const terminal = new FakeTerminal();
    const driver = new BackgroundShellRunDriver();
    let listener: ((update: ShellRunUpdate) => void) | undefined;
    let unsubscribed = false;
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      subscribeShellRunUpdates: (next) => {
        listener = next;
        return () => {
          listener = undefined;
          unsubscribed = true;
        };
      },
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('running'));
    assert.ok(listener);
    listener({
      sessionId: 'session-1',
      ownership: { kind: 'local' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'tool-bg',
      result: {
        kind: 'shell_run',
        ref: 'maka://runtime/background-tasks/bg-1',
        mode: 'pipes',
        status: 'completed',
        cwd: '/repo',
        cmd: 'build',
        startedAt: 1_000,
        updatedAt: 5_000,
        completedAt: 5_000,
        exitCode: 0,
        revision: 5_000,
        output: pipeOutput('done\n'),
      },
    });
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('(4s · 1 line)'));

    exitMaka(terminal);
    await run;
    assert.equal(unsubscribed, true);
  });

  test('keeps tool expansion when kitty protocol reports the Ctrl-O release', async () => {
    const terminal = new FakeTerminal();
    const driver = new ToolOutputDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('(31 lines)'));

    // Kitty keyboard protocol terminals (Ghostty/Kitty) send one event for the
    // key press and another for the release. The release must not undo the
    // toggle, or expansion only lasts while the key is physically held.
    terminal.input('\x1b[111;5u');
    terminal.input('\x1b[111;5:3u');

    // The compact-only annotation leaving the screen proves the card is
    // still expanded after the release event.
    await waitFor(() => !plainTerminalOutput(terminal.screenOutput()).includes('(31 lines)'));
    // Sentinel render ordered after the release event: if the release had
    // collapsed the card back, this frame would show the annotation again.
    terminal.input('z');
    await waitFor(() => editorInputText(terminal) === 'z');
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('(31 lines)'), false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('a confirmed second Ctrl+T collapses a head-scrolled block with one full redraw (#4011)', async () => {
    const terminal = new FakeTerminal();
    const driver = new ThinkingDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Thinking…'));

    // Expand: the 80-line thinking block renders in full and pushes its own
    // head above the 24-row viewport.
    terminal.input('\x14');
    await waitFor(() => terminal.output().includes('reason-row-0'));
    assert.equal(terminal.output().includes('\x1b[3J'), false);

    // First collapse press: the block's head is stranded in scrollback, so the
    // toggle flips the default, names the stranded block, offers the second
    // press — and does NOT redraw. (Match a wrap-safe early fragment: the
    // notice line wraps at 80 columns.)
    terminal.input('\x14');
    await waitFor(() =>
      plainTerminalOutput(terminal.output()).includes('stayed expanded in scrollback'),
    );
    assert.equal(terminal.output().includes('\x1b[3J'), false);

    // Confirmed second press inside the window: one deliberate
    // scrollback-clearing full redraw collapses the stranded block.
    terminal.input('\x14');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Thinking…'));
    assert.equal(terminal.output().includes('\x1b[3J'), true);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('an expired Ctrl+T confirmation re-offers collapse instead of reversing it (#4011)', async (t) => {
    const terminal = new FakeTerminal();
    const driver = new ThinkingDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Thinking…'));

    terminal.input('\x14');
    await waitFor(() => terminal.output().includes('reason-row-0'));
    terminal.input('\x14');
    await waitFor(() =>
      plainTerminalOutput(terminal.output()).includes('stayed expanded in scrollback'),
    );

    const beforeExpiredPress = terminal.output().length;
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.mock.timers.tick(EXPANSION_COLLAPSE_CONFIRM_WINDOW_MS + 1);
    terminal.input('\x14');
    t.mock.timers.reset();

    await waitFor(() => terminal.output().length > beforeExpiredPress);
    const expiredPressOutput = terminal.output().slice(beforeExpiredPress);
    assert.equal(expiredPressOutput.includes('\x1b[3J'), false);
    assert.equal(
      plainTerminalOutput(expiredPressOutput).includes('stayed expanded in scrollback'),
      true,
    );
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('reason-row-0'), false);
    assert.equal(
      plainTerminalOutput(terminal.screenOutput()).includes('stayed expanded in scrollback'),
      true,
    );

    // The new offer arms a fresh window. This second press is the only one
    // that clears scrollback and collapses the above-viewport block.
    terminal.input('\x14');
    await waitFor(() => terminal.output().slice(beforeExpiredPress).includes('\x1b[3J'));
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('Thinking…'), true);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('does not treat a kitty Escape press+release as a double Escape', async () => {
    const terminal = new FakeTerminal();
    const driver = new InterruptibleTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);

    // One physical Esc keypress arrives as a press + release pair under the
    // kitty protocol; it must count as a single Escape, not an interrupt.
    // Escape handling runs synchronously off the input dispatch, so one
    // macrotask turn (which drains every queued microtask first) is a
    // deterministic settle — a wrongly-counted double Escape would have
    // called stopSession by now.
    terminal.input('\x1b[27u');
    terminal.input('\x1b[27;1:3u');
    await delay(0);
    assert.equal(driver.stopCalls, 0);

    // A real second press still interrupts the running turn.
    terminal.input('\x1b[27u');
    await waitFor(() => driver.stopCalls === 1);
    await waitFor(() => terminal.progressStates.at(-1) === false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('waits to drain a visible turn until shared session activity releases', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const activities = new SessionActivityRegistry();
    const heartbeat = activities.reserve('session-1');
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
      turnActivity: createTestTurnActivity(activities),
    });

    terminal.input('run');
    terminal.input('\r');
    // Runtime Host owns admission, so the Message goes out at once; it is the
    // visible Turn that waits for the Session another surface is holding.
    await waitFor(() => driver.prompts.length === 1);
    await delay(0);
    assert.equal(driver.streamPulls, 0);

    heartbeat.release();
    await waitFor(() => driver.streamPulls === 1);
    assert.deepEqual(driver.prompts, ['run']);
    assert.equal(activities.whenIdle('session-1'), undefined);

    exitMaka(terminal);
    await run;
  });

  test('reserves first-session activity before its prepared event stream starts', async () => {
    const terminal = new FakeTerminal();
    const driver = new FirstSessionPreparedDriver();
    const activities = new SessionActivityRegistry();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
      turnActivity: createTestTurnActivity(activities),
    });

    terminal.input('run');
    terminal.input('\r');
    await driver.streamStarted.promise;
    assert.ok(activities.whenIdle('session-first'));
    assert.equal(activities.reserveIfIdle('session-first'), undefined);

    let heartbeatAcquired = false;
    const heartbeat = activities.acquire('session-first').then((lease) => {
      heartbeatAcquired = true;
      return lease;
    });
    await delay(0);
    assert.equal(heartbeatAcquired, false);

    driver.releaseStream.resolve();
    const heartbeatLease = await heartbeat;
    heartbeatLease.release();
    await waitFor(() => activities.whenIdle('session-first') === undefined);

    exitMaka(terminal);
    await run;
  });

  test('does not start a visible turn after closing while it waits for shared activity', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const activities = new SessionActivityRegistry();
    const heartbeat = activities.reserve('session-1');
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
      turnActivity: createTestTurnActivity(activities),
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => driver.prompts.length === 1);
    await delay(0);
    assert.equal(driver.streamPulls, 0);

    exitMaka(terminal);
    await run;
    heartbeat.release();
    await delay(0);

    assert.equal(driver.streamPulls, 0);
    assert.equal(activities.whenIdle('session-1'), undefined);
  });

  test('flows a transcript taller than the viewport into scrollback, untruncated and un-paged', async () => {
    const terminal = new FakeTerminal();
    const driver = new LongTranscriptDriver();
    driver.hostSummary = { model: 'deepseek-v4-flash', llmConnectionSlug: 'deepseek' };
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('fill');
    terminal.input('\r');
    // The whole 40-line reply is drawn — head and tail both reach the terminal,
    // so nothing is capped to one screen the way the old windowing did.
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('filler line 40'));
    const cumulative = plainTerminalOutput(terminal.output());
    assert.ok(
      cumulative.includes('filler line 1'),
      'the head of a tall reply must still be written out',
    );

    // The live surface stays unpaged until the user explicitly opens the
    // transcript viewer. Its navigation chrome must not consume normal rows.
    assert.doesNotMatch(cumulative, /PgUp|PgDn|\d+ more/);

    // The visible screen follows the tail: the last reply line and the status
    // line are on screen (status pinned to the bottom row), while the scrolled-off
    // head is not — it now lives in the terminal's native scrollback.
    const screen = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
    assert.ok(
      screen.some((line) => line.includes('filler line 40')),
      'the live tail should be on screen',
    );
    assert.equal(
      screen.some((line) => line.includes('filler line 1')),
      false,
      'the head should have scrolled off',
    );
    assert.equal(
      screen[terminal.rows - 1]?.includes('Maka · Auto · deepseek-v4-flash · deepseek · /repo'),
      true,
    );

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('browses a long transcript without depending on terminal scrollback', async () => {
    const terminal = new FakeTerminal();
    const driver = new LongTranscriptDriver();
    driver.hostSummary = { model: 'deepseek-v4-flash', llmConnectionSlug: 'deepseek' };
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('fill');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('filler line 40'));

    terminal.input('/transcript');
    terminal.input('\r');
    await waitFor(
      () => plainTerminalOutput(terminal.screenOutput()).includes('TRANSCRIPT'),
      'the transcript viewer to open',
    );
    let screen = plainTerminalOutput(terminal.screenOutput());
    assert.match(screen, /PgUp\/PgDn page/);
    assert.match(screen, /filler line 40/);
    assert.doesNotMatch(screen, /filler line 1\s/);

    terminal.input('\x1b[H');
    await waitFor(
      () =>
        plainTerminalOutput(terminal.screenOutput())
          .split(/\r?\n/)
          .some((line) => line.trim() === 'filler line 1'),
      'Home to reveal the transcript head',
    );
    screen = plainTerminalOutput(terminal.screenOutput());
    assert.match(screen, /> fill/);
    assert.doesNotMatch(screen, /filler line 40/);

    terminal.input('q');
    await waitFor(
      () => !plainTerminalOutput(terminal.screenOutput()).includes('TRANSCRIPT'),
      'q to close the transcript viewer',
    );
    assert.match(
      plainTerminalOutput(terminal.screenOutput()),
      /Maka · Auto · deepseek-v4-flash · deepseek · \/repo/,
    );

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('opens the read-only /mcp status on an idle local TUI', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
      mcp: {
        snapshot: () => ({
          initialization: 'ready',
          configuration: 'ready',
          publication: 'published',
          toolCount: 1,
          servers: [
            {
              serverId: 'filesystem',
              configured: true,
              synchronized: true,
              state: 'connected',
              transport: 'stdio',
              negotiatedProtocol: { era: 'modern', revision: '2026-07-28' },
              toolCount: 1,
            },
          ],
        }),
        subscribe: () => () => undefined,
        configForEdit: () => undefined,
        previewImport: () => ({ status: 'invalid', reason: 'invalid-config' }),
        discardImportPreview: () => undefined,
        execute: async () => ({ status: 'failed', reason: 'manager-failed' }),
      },
    });

    terminal.input('/mcp');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('MCP SERVERS'));
    assert.match(plainTerminalOutput(terminal.screenOutput()), /filesystem/u);
    terminal.input('q');
    await waitFor(() => !plainTerminalOutput(terminal.screenOutput()).includes('MCP SERVERS'));
    exitMaka(terminal);
    await run;
  });

  test('/mcp previews pasted JSON and completes guided setup in-frame', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const actions: TuiMcpAction[] = [];
    const discardedPreviews: string[] = [];
    let previewSource = '';
    const mcp: TuiMcpManagement = {
      snapshot: () => ({
        initialization: 'ready',
        configuration: 'ready',
        publication: 'not_published',
        toolCount: 0,
        servers: [],
      }),
      subscribe: () => () => undefined,
      configForEdit: () => undefined,
      previewImport: (source) => {
        previewSource = source;
        return {
          status: 'ready',
          preview: {
            previewId: 'preview-1',
            entries: [
              {
                serverId: 'docs',
                change: 'add',
                transport: 'remote',
                protocol: 'auto',
              },
            ],
          },
        };
      },
      discardImportPreview: (previewId) => discardedPreviews.push(previewId),
      execute: async (action) => {
        actions.push(action);
        return { status: 'applied', effect: 'published' };
      },
    };
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
      mcp,
    });

    terminal.input('/mcp');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('MCP SERVERS'));
    terminal.input('a');
    terminal.input('j');
    terminal.input('secret-draft');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('secret-draft'));
    terminal.input('\x1b');
    await waitFor(() => !plainTerminalOutput(terminal.screenOutput()).includes('secret-draft'));
    terminal.input('a');
    terminal.input('j');
    terminal.input('\x1f');
    await delay(0);
    assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /secret-draft/u);
    terminal.input('{"docs":{"url":"https://docs.example/mcp","protocol":"auto"}}');
    terminal.input('\r');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Import MCP servers?'),
    );
    assert.equal(actions.length, 0);
    assert.equal(previewSource.includes('docs.example'), true);
    terminal.input('\x1b');
    assert.deepEqual(discardedPreviews, ['preview-1']);
    terminal.input('a');
    terminal.input('j');
    terminal.input('{"docs":{"url":"https://docs.example/mcp","protocol":"auto"}}');
    terminal.input('\r');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Import MCP servers?'),
    );
    terminal.input('y');
    await waitFor(() => actions.length === 1);
    assert.deepEqual(actions[0], { kind: 'commit_import', previewId: 'preview-1' });
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('tools refreshed'));

    terminal.input('a');
    terminal.input('g');
    terminal.input('local');
    terminal.input('\r');
    terminal.input('1');
    terminal.input('mcp-server');
    terminal.input('\r');
    terminal.input('[]');
    terminal.input('\r');
    terminal.input('3');
    terminal.input('\r');
    terminal.input('{}');
    terminal.input('\r');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Add this MCP server?'),
    );
    terminal.input('y');
    await waitFor(() => actions.length === 2);
    assert.deepEqual(actions[1], {
      kind: 'add',
      serverId: 'local',
      config: {
        enabled: true,
        command: 'mcp-server',
        args: [],
        env: {},
        protocol: '2026-07-28',
      },
    });
    terminal.input('q');
    exitMaka(terminal);
    await run;
  });

  test('/mcp ignores a late action result after the user cancels its busy view', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const result = deferred<Awaited<ReturnType<TuiMcpManagement['execute']>>>();
    const actions: TuiMcpAction[] = [];
    const mcp: TuiMcpManagement = {
      snapshot: () => ({
        initialization: 'ready',
        configuration: 'ready',
        publication: 'not_published',
        toolCount: 0,
        servers: [
          {
            serverId: 'docs',
            configured: true,
            synchronized: true,
            enabled: false,
            configuredTransport: 'remote',
            configuredProtocol: 'auto',
            state: 'disabled',
            toolCount: 0,
          },
        ],
      }),
      subscribe: () => () => undefined,
      configForEdit: () => undefined,
      previewImport: () => ({ status: 'invalid', reason: 'invalid-config' }),
      discardImportPreview: () => undefined,
      execute: async (action) => {
        actions.push(action);
        return result.promise;
      },
    };
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
      mcp,
    });

    terminal.input('/mcp');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('docs'));
    terminal.input(' ');
    await waitFor(() => actions.length === 1);
    assert.deepEqual(actions[0], { kind: 'set_enabled', serverId: 'docs', enabled: true });
    terminal.input('\x1b');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('docs'));
    result.resolve({ status: 'failed', reason: 'manager-failed' });
    await delay(0);
    assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /connection action failed/u);
    terminal.input('q');
    exitMaka(terminal);
    await run;
  });

  test('clears an unsent draft on Ctrl-C without closing Maka', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('unsent draft');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('unsent draft'));
    terminal.input('\x03');
    // The draft leaving the screen is the observable effect of the Ctrl-C.
    await waitFor(() => !plainTerminalOutput(terminal.screenOutput()).includes('unsent draft'));
    assert.equal(terminal.stopCalls, 0);
    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('requires a second idle Ctrl-C to exit Maka', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const processExitCodes: number[] = [];
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
      onProcessExit: (exitCode) => processExitCodes.push(exitCode),
    });

    terminal.input('\x03');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Press Ctrl+C again to exit.'),
    );
    assert.equal(terminal.stopCalls, 0);

    terminal.input('\x03');
    await run;
    assert.equal(terminal.stopCalls, 1);
    assert.deepEqual(processExitCodes, [0]);
  });

  test('does not count a Kitty Ctrl-C repeat as the second press', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('\x1b[99;5u');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Press Ctrl+C again to exit.'),
    );
    // Ctrl-C counting runs synchronously off the input dispatch, so one
    // macrotask turn (which drains every queued microtask first) is a
    // deterministic settle — a wrongly-counted second press would have begun
    // closing the terminal by now.
    terminal.input('\x1b[99;5:2u');
    await delay(0);

    assert.equal(terminal.stopCalls, 0);
    terminal.input('\x1b[99;5u');
    await run;
  });

  test('keeps Maka open when Ctrl-D is pressed during a turn', async () => {
    const terminal = new FakeTerminal();
    const driver = new InterruptibleTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);
    // Ctrl-D handling runs synchronously off the input dispatch, so one
    // macrotask turn (which drains every queued microtask first) is a
    // deterministic settle — a wrongly-honored Ctrl-D would have begun
    // closing the terminal or stopping the turn by now.
    terminal.input('\x04');
    await delay(0);

    assert.equal(terminal.stopCalls, 0);
    assert.equal(driver.stopCalls, 0);
    terminal.input('\x1b');
    terminal.input('\x1b');
    await waitFor(() => terminal.progressStates.at(-1) === false);
    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('Enter during a turn steers the running turn and shows a pending Steering line', async () => {
    const terminal = new FakeTerminal();
    const driver = new SteeringTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'm',
      connectionSlug: 'c',
      permissionMode: 'bypass',
      terminal,
    });

    terminal.input('start the work');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);

    terminal.input('also handle Y');
    terminal.input('\r');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Steering: also handle Y'),
    );
    assert.deepEqual(driver.steered, ['also handle Y']);

    terminal.input('\x1b');
    terminal.input('\x1b');
    await waitFor(() => terminal.progressStates.at(-1) === false);
    // Interrupt refills the editor with the cleared queue; clear it before /exit.
    terminal.input('\x03');
    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('removes an idle transient message after a definite Host rejection', async () => {
    const terminal = new FakeTerminal();
    const driver = new SteeringTurnDriver();
    driver.nextSubmitError = new Error('Session is archived');
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'm',
      connectionSlug: 'c',
      permissionMode: 'bypass',
      terminal,
    });

    terminal.input('do not leave a ghost row');
    terminal.input('\r');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Session is archived'),
    );
    assert.equal(
      plainTerminalOutput(terminal.screenOutput()).includes('do not leave a ghost row'),
      false,
    );

    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('keeps an admitted message when a Host-started turn attaches from a sparse tail', async () => {
    const terminal = new FakeTerminal();
    const driver = new SteeringTurnDriver();
    driver.startedTurnMessages = [
      {
        type: 'assistant',
        id: 'later-assistant',
        turnId: 'turn-started',
        ts: 2,
        text: 'Later durable output',
        modelId: 'model-1',
      },
    ];
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'm',
      connectionSlug: 'c',
      permissionMode: 'bypass',
      terminal,
    });

    terminal.input('keep the accepted identity');
    terminal.input('\r');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Later durable output'),
    );
    assert.match(plainTerminalOutput(terminal.screenOutput()), /keep the accepted identity/);

    terminal.input('\x1b');
    terminal.input('\x1b');
    await waitFor(() => terminal.progressStates.at(-1) === false);
    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('opens /transcript during a running turn instead of steering it', async () => {
    const terminal = new FakeTerminal();
    const driver = new SteeringTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'm',
      connectionSlug: 'c',
      permissionMode: 'bypass',
      terminal,
    });

    terminal.input('start the work');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);

    terminal.input('/transcript');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('TRANSCRIPT'));
    assert.deepEqual(driver.steered, []);

    terminal.input('q');
    terminal.input('\x1b');
    terminal.input('\x1b');
    await waitFor(() => terminal.progressStates.at(-1) === false);
    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('refuses /mcp during a running turn instead of steering it', async () => {
    const terminal = new FakeTerminal();
    const driver = new SteeringTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'm',
      connectionSlug: 'c',
      permissionMode: 'bypass',
      terminal,
    });

    terminal.input('start the work');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);
    terminal.input('/mcp');
    terminal.input('\r');
    await waitFor(() =>
      plainTerminalOutput(terminal.output()).includes('Cannot run /mcp while a turn is running'),
    );
    assert.deepEqual(driver.steered, []);

    terminal.input('\x1b');
    terminal.input('\x1b');
    await waitFor(() => terminal.progressStates.at(-1) === false);
    terminal.input('\x03');
    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('quit during a running turn closes the TUI instead of steering it', async () => {
    const terminal = new FakeTerminal();
    const driver = new SteeringTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'm',
      connectionSlug: 'c',
      permissionMode: 'bypass',
      terminal,
    });

    terminal.input('start the work');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);

    terminal.input('quit');
    terminal.input('\r');

    await run;
    assert.deepEqual(driver.steered, []);
    assert.equal(driver.stopCalls, 1);
  });

  test('Alt+Enter during a turn queues a followup and shows a pending Queued line', async () => {
    const terminal = new FakeTerminal();
    const driver = new SteeringTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'm',
      connectionSlug: 'c',
      permissionMode: 'bypass',
      terminal,
    });

    terminal.input('start the work');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);

    terminal.input('do this next');
    terminal.input('\x1b\r'); // Alt+Enter
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Queued: do this next'),
    );
    assert.deepEqual(driver.queuedMessages, ['do this next']);
    assert.deepEqual(driver.steered, []);

    terminal.input('\x1b');
    terminal.input('\x1b');
    await waitFor(() => terminal.progressStates.at(-1) === false);
    // Interrupt refills the editor with the cleared queue; clear it before /exit.
    terminal.input('\x03');
    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('Alt+Up takes the queued messages back into the editor', async () => {
    const terminal = new FakeTerminal();
    const driver = new SteeringTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'm',
      connectionSlug: 'c',
      permissionMode: 'bypass',
      terminal,
    });

    terminal.input('start the work');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);

    terminal.input('reword this later');
    terminal.input('\r'); // steer
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Steering: reword this later'),
    );

    terminal.input('\x1b[1;3A'); // Alt+Up
    await waitFor(() => driver.retractCalls === 1);
    // The pending bar is cleared and the text is back in the editor.
    await waitFor(() => {
      const screen = plainTerminalOutput(terminal.screenOutput());
      return (
        !screen.includes('Steering: reword this later') && screen.includes('reword this later')
      );
    });

    terminal.input('\x1b');
    terminal.input('\x1b');
    await waitFor(() => terminal.progressStates.at(-1) === false);
    terminal.input('\x03'); // clear the refilled draft
    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('Alt+Up removes the exact transient rows without a subscription retraction event', async () => {
    const terminal = new FakeTerminal();
    const driver = new SteeringTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'm',
      connectionSlug: 'c',
      permissionMode: 'bypass',
      terminal,
    });

    terminal.input('start the work');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);

    terminal.input('take this back');
    terminal.input('\x1b\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('take this back'));

    terminal.input('\x1b[1;3A');
    await waitFor(() => driver.retractCalls === 1);
    await waitFor(() => {
      const screen = plainTerminalOutput(terminal.screenOutput());
      return screen.includes('take this back') && !screen.includes('Queued: take this back');
    });
    terminal.input('\x1b');
    terminal.input('\x1b');
    await waitFor(() => terminal.progressStates.at(-1) === false);
    terminal.input('\x03');
    await waitFor(() => !plainTerminalOutput(terminal.screenOutput()).includes('take this back'));
    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('Alt+Up in the enqueue tick retracts from the authority, not the lagging mirror', async () => {
    // Round-6 R2: the enqueue outcome arrives synchronously but the mirror
    // updates only when the queue_update event is consumed. An Alt+Up in
    // that same tick must still call the authoritative retract — gating the
    // mutation on the (empty) mirror would strand a message the runtime
    // demonstrably holds.
    const terminal = new FakeTerminal();
    const driver = new SteeringTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'm',
      connectionSlug: 'c',
      permissionMode: 'bypass',
      terminal,
    });

    terminal.input('start the work');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);

    terminal.input('reword this later');
    terminal.input('\r'); // steer — queued synchronously in the driver
    terminal.input('\x1b[1;3A'); // Alt+Up in the same tick, mirror still empty
    await waitFor(() => driver.retractCalls === 1);
    await waitFor(() => {
      const screen = plainTerminalOutput(terminal.screenOutput());
      return (
        screen.includes('reword this later') && !screen.includes('Steering: reword this later')
      );
    });

    terminal.input('\x1b');
    terminal.input('\x1b');
    await waitFor(() => terminal.progressStates.at(-1) === false);
    terminal.input('\x03');
    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('double-Escape interrupt refills the editor with the cleared queue', async () => {
    const terminal = new FakeTerminal();
    const driver = new SteeringTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'm',
      connectionSlug: 'c',
      permissionMode: 'bypass',
      terminal,
    });

    terminal.input('start the work');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);

    terminal.input('unfinished idea');
    terminal.input('\r'); // steer
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Steering: unfinished idea'),
    );

    terminal.input('\x1b');
    terminal.input('\x1b'); // interrupt
    await waitFor(() => terminal.progressStates.at(-1) === false);
    assert.ok(driver.stopCalls >= 1);
    // Queue cleared from the pending bar; text preserved in the editor.
    await waitFor(() => {
      const screen = plainTerminalOutput(terminal.screenOutput());
      return !screen.includes('Steering: unfinished idea') && screen.includes('unfinished idea');
    });

    terminal.input('\x03'); // clear the refilled draft
    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('interrupt refills only messages still queued, not steering already consumed', async () => {
    const terminal = new FakeTerminal();
    const driver = new SteeringTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'm',
      connectionSlug: 'c',
      permissionMode: 'bypass',
      terminal,
    });

    terminal.input('start the work');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);

    terminal.input('already consumed');
    terminal.input('\r'); // steer
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Steering: already consumed'),
    );

    terminal.input('still queued');
    terminal.input('\x1b\r'); // Alt+Enter queues a followup
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Queued: still queued'),
    );

    // The turn consumes the steering message at a step boundary; the CLI
    // mirror has not seen a queue_update yet and still shows it.
    driver.consumeSteering();

    terminal.input('\x1b');
    terminal.input('\x1b'); // interrupt
    await waitFor(() => terminal.progressStates.at(-1) === false);
    // The authoritative queue is cleared and only the followup comes back as
    // a draft. The consumed steering row remains for canonical reconciliation;
    // the retracted followup row is removed while its text moves to the editor.
    await waitFor(() => {
      const screen = plainTerminalOutput(terminal.screenOutput());
      return (
        screen.includes('still queued') &&
        screen.includes('already consumed') &&
        !screen.includes('Steering: already consumed') &&
        !screen.includes('Queued: still queued')
      );
    });

    terminal.input('\x03'); // clear the refilled draft
    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('Alt+Enter during a control action keeps the draft in the editor', async () => {
    const terminal = new FakeTerminal();
    const driver = new DeferredControlDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/model claude-opus-4-1');
    terminal.input('\r');
    await waitFor(() => driver.models.length === 1);

    terminal.input('a draft to keep');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('a draft to keep'));

    terminal.input('\x1b\r'); // Alt+Enter while a control action holds `busy`
    // The submit gate runs synchronously off the input dispatch; one macrotask
    // turn (which drains every queued microtask first) is a deterministic
    // settle for the prompt check.
    await delay(0);
    assert.deepEqual(driver.prompts, []);
    // Sentinel render: the draft growing by the typed char proves the editor
    // kept it — a wrongful submit would have cleared it first.
    terminal.input('z');
    await waitFor(() => editorInputText(terminal) === 'a draft to keepz');

    driver.releaseSetModel();
    // The control action settles through its promise continuations; one
    // macrotask turn runs strictly after them, releasing `busy` for /exit.
    await delay(0);
    terminal.input('\x03'); // clear the preserved draft
    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('a second Enter during Host admission submits another Message', async () => {
    const terminal = new FakeTerminal();
    const driver = new SteeringTurnDriver();
    const admission = deferred<void>();
    driver.submitGate = admission.promise;
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'm',
      connectionSlug: 'c',
      permissionMode: 'bypass',
      terminal,
    });

    terminal.input('first prompt');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('first prompt'));

    // Runtime Host decides what a Message becomes, so the client neither holds
    // the editor nor drops the text: the second Enter submits its own Message
    // and only the keystroke typed after it stays in the draft.
    terminal.input('second prompt');
    terminal.input('\r');
    terminal.input('z');
    await waitFor(() => editorInputText(terminal) === 'z');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('second prompt'));

    admission.resolve();
    await waitFor(() => terminal.progressStates.at(-1) === true);
    exitMaka(terminal);
    await run;
  });

  test('input during the interrupt convergence window stays in the editor and opens no turn', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlowStopDriver(); // stop() returns but the turn keeps running
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'm',
      connectionSlug: 'c',
      permissionMode: 'bypass',
      terminal,
    });

    terminal.input('start the work');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);
    await waitFor(() => driver.prompts.length === 1);

    terminal.input('\x1b');
    terminal.input('\x1b'); // interrupt: stop issued, turn not yet terminal
    await waitFor(() => driver.stopCalls === 1);

    terminal.input('after stop');
    terminal.input('\r'); // Enter: submits are disabled during convergence
    terminal.input('\x1b\r'); // Alt+Enter: gated before touching the editor
    // The convergence gates run synchronously off the input dispatch; one
    // macrotask turn (which drains every queued microtask first) settles them.
    await delay(0);

    driver.endTurn(); // the aborted turn finally terminates
    await waitFor(() => terminal.progressStates.at(-1) === false);
    // The typed text is still in the editor as a draft, never a queued line.
    await waitFor(() => {
      const screen = plainTerminalOutput(terminal.screenOutput());
      return screen.includes('after stop') && !screen.includes('Queued: after stop');
    });

    terminal.input('\x03'); // clear the preserved draft
    terminal.input('/exit');
    terminal.input('\r');
    await run;
    // Anchored after close: a wrongly-opened second turn would have landed in
    // prompts by the time the TUI has fully shut down.
    assert.deepEqual(driver.prompts, ['start the work']);
  });

  test('exits on the second Ctrl-C during a control command', async () => {
    const terminal = new FakeTerminal();
    const driver = new DeferredControlDriver();
    const processExitCodes: number[] = [];
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      onProcessExit: (exitCode) => processExitCodes.push(exitCode),
    });

    terminal.input('/model claude-opus-4-1');
    terminal.input('\r');
    await waitFor(() => driver.models.length === 1);
    terminal.input('\x03');
    // The rendered hint is the observable effect of the first Ctrl-C arming
    // the exit gesture without closing anything.
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Press Ctrl+C again to exit.'),
    );

    try {
      assert.equal(terminal.stopCalls, 0);
      terminal.input('\x03');
      await Promise.race([
        run,
        delay(CLOSE_BUDGET_MS).then(() => {
          throw new Error('TUI did not close after the second Ctrl-C');
        }),
      ]);
      assert.equal(terminal.stopCalls, 1);
      assert.deepEqual(processExitCodes, [0]);
    } finally {
      driver.releaseSetModel();
      if (terminal.stopCalls === 0) exitMaka(terminal);
      await run;
    }
  });

  test('requires the same second confirmation for typed /permissions bypass', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/permissions bypass');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Switch to full access?'));
    assert.deepEqual(driver.permissionModes, []);

    terminal.input('\r');

    exitMaka(terminal);
    await run;
    // Anchored after close: every queued input has been drained, so a bare
    // Enter that wrongly confirmed the switch would show in permissionModes.
    assert.deepEqual(driver.permissionModes, []);
  });

  test('rejects Swarm commands during a running turn instead of steering them', async () => {
    const terminal = new FakeTerminal();
    const driver = new SteeringTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('keep working');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);

    terminal.input('/swarm on');
    terminal.input('\r');
    await waitFor(() =>
      terminal.output().includes('Cannot change or start Swarm Mode while a turn is running.'),
    );
    assert.deepEqual(driver.steered, []);

    terminal.input('\x03');
    await waitFor(() => driver.stopCalls === 1);
    exitMaka(terminal);
    await run;
  });

  test('cancelling a one-shot Swarm turn leaves the persistent mode off', async () => {
    const terminal = new FakeTerminal();
    const driver = new SteeringTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/swarm investigate broadly');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);
    assert.deepEqual(driver.turnOrchestrations, [{ mode: 'swarm', source: 'slash_command' }]);

    terminal.input('\x03');
    await waitFor(() => driver.stopCalls === 1);
    await waitFor(() => terminal.progressStates.at(-1) === false);

    terminal.input('/swarm status');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Swarm Mode is off'));

    exitMaka(terminal);
    await run;
  });

  test('removes a one-shot Swarm transient when turn admission fails', async () => {
    const terminal = new FakeTerminal();
    const driver = new FailingOrchestrationDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/swarm inspect the projection');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('admission failed'));
    assert.equal(
      plainTerminalOutput(terminal.screenOutput()).includes('inspect the projection'),
      false,
    );

    exitMaka(terminal);
    await run;
  });

  test('inspects a historical Agent Graph run without starting a turn', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const requestedGraphIds: string[] = [];
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
      agentGraphHistory: {
        listEpochs: async () => ({
          epochs: [
            { epoch: 2, graphId: 'graph-2', createdAt: 2, current: true },
            { epoch: 1, graphId: 'graph-1', createdAt: 1, current: false },
          ],
          truncated: false,
        }),
        getSnapshot: async (_rootSessionId, graphId) => {
          requestedGraphIds.push(graphId);
          return historicalGraphSnapshot(graphId);
        },
      },
    });

    terminal.input('/graph history');
    terminal.input('\r');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Agent Graph History'),
    );
    terminal.input('\x1b[B');
    terminal.input('\r');
    await waitFor(() =>
      plainTerminalOutput(terminal.output()).includes('Agent Graph run #1 · History (read-only)'),
    );

    assert.deepEqual(requestedGraphIds, ['graph-1']);
    assert.deepEqual(driver.prompts, []);
    exitMaka(terminal);
    await run;
  });

  test('does not render a historical Agent Graph snapshot after shutdown', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const snapshotStarted = deferred<void>();
    const releaseSnapshot = deferred<void>();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
      agentGraphHistory: {
        listEpochs: async () => ({
          epochs: [
            { epoch: 2, graphId: 'graph-2', createdAt: 2, current: true },
            { epoch: 1, graphId: 'graph-1', createdAt: 1, current: false },
          ],
          truncated: false,
        }),
        getSnapshot: async (_rootSessionId, graphId) => {
          snapshotStarted.resolve();
          await releaseSnapshot.promise;
          return historicalGraphSnapshot(graphId);
        },
      },
    });

    terminal.input('/graph history');
    terminal.input('\r');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Agent Graph History'),
    );
    terminal.input('\x1b[B');
    terminal.input('\r');
    await snapshotStarted.promise;

    exitMaka(terminal);
    await run;
    releaseSnapshot.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.doesNotMatch(
      plainTerminalOutput(terminal.output()),
      /Agent Graph run #1 · History \(read-only\)/,
    );
  });

  test('rejects unsupported /thinking levels with usage instead of sending an update', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'gpt-5',
      connectionSlug: 'openai',
      providerType: 'openai',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/thinking off');
    terminal.input('\r');

    await waitFor(() =>
      plainTerminalOutput(terminal.output()).includes(
        'Usage: /thinking default|minimal|low|medium|high',
      ),
    );
    assert.deepEqual(driver.thinkingLevelUpdates, []);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('localizes generic model and thinking picker hints in Chinese', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'gpt-5',
      models: ['gpt-5', 'gpt-5-mini'],
      connectionSlug: 'openai',
      providerType: 'openai',
      permissionMode: 'ask',
      locale: 'zh',
      terminal,
    });

    terminal.input('/model');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('选择模型'));
    assert.match(plainTerminalOutput(terminal.screenOutput()), /↑↓ 选择 · Enter 确认 · Esc 关闭/u);
    terminal.input('\x1b');

    terminal.input('/thinking');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('选择思考级别'));
    assert.match(plainTerminalOutput(terminal.screenOutput()), /↑↓ 选择 · Enter 确认 · Esc 关闭/u);
    assert.doesNotMatch(
      plainTerminalOutput(terminal.screenOutput()),
      /enter select \/ esc close/iu,
    );

    terminal.input('\x1b');
    exitMaka(terminal);
    await run;
  });

  test('resumes a read-only session as Read only, and never marks Auto as current', async () => {
    // #1611 in the TUI: the resumed boundary is read-only, so the status line
    // must name it and the picker must not present Auto as "the option you are
    // already on" — selecting it replaces a read-only boundary with a writable
    // one, which is a permission change, not a confirmation.
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver(
      [fakeSessionSummary('session-2', '/repo')],
      new Map(),
      new Map([['session-2', 'explore' as PermissionMode]]),
    );
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      resumeSessionId: 'session-2',
    });

    await waitFor(() => driver.sessionIds.length === 1);
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Maka · Read only ·'),
    );

    terminal.input('/permissions');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Permissions'));
    const picker = plainTerminalOutput(terminal.screenOutput());
    assert.ok(picker.includes('Read only'), 'picker header names the boundary in force');
    assert.doesNotMatch(picker, /current ·/);

    // Selecting Auto is applied as the permission change it is.
    terminal.input('\r');
    await waitFor(() => driver.permissionModes.length === 1);
    assert.deepEqual(driver.permissionModes, ['ask']);
    await waitFor(() => terminal.output().includes('Permissions: Auto'));
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Maka · Auto ·'));

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('switches connection and model together from a cross-connection /model', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    driver.hostSummary = { model: 'gpt-5.5', llmConnectionSlug: 'openai' };
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'gpt-5.5',
      connectionId: 'connection-openai',
      connectionSlug: 'openai',
      providerType: 'openai',
      locale: 'en',
      modelChoices: [
        {
          connectionId: 'connection-openai',
          connectionSlug: 'openai',
          connectionName: 'OpenAI',
          providerType: 'openai',
          model: 'gpt-5.5',
          displayName: 'GPT 5.5 Preview',
          isDefaultConnection: true,
        },
        {
          connectionId: 'connection-zai',
          connectionSlug: 'zai',
          connectionName: 'Z.ai',
          providerType: 'openai',
          model: 'glm-5.2',
          displayName: 'GLM 5.2',
          isDefaultConnection: false,
        },
      ],
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('keep this context');
    terminal.input('\r');
    await waitFor(() => driver.prompts.length === 1);
    terminal.input('/model');
    terminal.input('\r');

    await waitFor(() => terminal.output().includes('Select Model'));
    await waitFor(() => terminal.output().includes('GLM 5.2'));
    assert.match(
      plainTerminalOutput(terminal.screenOutput()),
      /Switching models may rebuild the prompt cache; the next request may be slower/,
    );
    // The picker opens on the current model (gpt-5.5); move down to the choice on
    // the other connection and select it.
    terminal.input('\x1b[B');
    terminal.input('\r');
    await waitFor(() => driver.models.length === 1);

    assert.deepEqual(driver.models, ['glm-5.2']);
    assert.deepEqual(driver.modelConnections, ['zai']);
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes(
        'Model changed: gpt-5.5 (OpenAI · openai) → glm-5.2 (Z.ai · zai)',
      ),
    );
    // The status line now reflects both the new model and the new connection.
    await waitFor(() =>
      plainTerminalOutput(terminal.output()).includes('Maka · Auto · glm-5.2 · zai · /repo'),
    );

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('cross-connection /model search matches by every required criterion', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      // A current model/slug not among the choices, so no choice's model shows
      // up in the status line — a dropped choice truly leaves the visible list.
      model: 'legacy-curated-out',
      connectionSlug: 'ghost',
      providerType: 'openai',
      modelChoices: [
        {
          connectionSlug: 'alpha',
          connectionName: 'Aurora',
          providerType: 'openai',
          model: 'gpt-5.5',
          displayName: 'GPT 5.5 Preview',
          isDefaultConnection: true,
        },
        {
          connectionSlug: 'beta',
          connectionName: 'Boreal',
          providerType: 'zai',
          model: 'glm-max',
          displayName: 'GLM Max',
          isDefaultConnection: false,
        },
        {
          connectionSlug: 'gamma',
          connectionName: 'Crest',
          providerType: 'google',
          model: 'text-unicorn',
          isDefaultConnection: false,
        },
      ],
      permissionMode: 'ask',
      terminal,
    });

    await waitForTuiPaint(terminal);
    terminal.input('/model');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Select Model'));
    await waitFor(() => {
      const out = plainTerminalOutput(terminal.screenOutput());
      return (
        out.includes('GPT 5.5 Preview') && out.includes('GLM Max') && out.includes('text-unicorn')
      );
    });
    assert.doesNotMatch(
      plainTerminalOutput(terminal.screenOutput()),
      /Switching models may rebuild the prompt cache/,
    );
    // Each query isolates exactly one of the five match criteria named by #1098
    // (model id, connection name, connection slug, provider type, provider
    // label) and keeps only its matching choice. The fixture's three distinct
    // providers (openai / zai / google) let `zai` exercise the providerType
    // line alone (its label `Z.AI` is not a substring) and `gemini` exercise
    // the PROVIDER_DEFAULTS label line alone (its type `google` is not), so
    // deleting either line would fail its assertion. Ctrl+U (deleteToLineStart)
    // clears the search field in one event so the next criterion starts from
    // the full list again.
    const cases = [
      { query: 'preview', keep: 'GPT 5.5 Preview', drop: ['GLM Max', 'text-unicorn'] },
      { query: 'aurora', keep: 'GPT 5.5 Preview', drop: ['GLM Max', 'text-unicorn'] },
      { query: 'alpha', keep: 'GPT 5.5 Preview', drop: ['GLM Max', 'text-unicorn'] },
      { query: 'zai', keep: 'GLM Max', drop: ['GPT 5.5 Preview', 'text-unicorn'] },
      { query: 'gemini', keep: 'text-unicorn', drop: ['GPT 5.5 Preview', 'GLM Max'] },
      { query: 'glm-max', keep: 'GLM Max', drop: ['GPT 5.5 Preview', 'text-unicorn'] },
    ];
    for (const c of cases) {
      terminal.input(c.query);
      await waitFor(() => {
        const out = plainTerminalOutput(terminal.screenOutput());
        return out.includes(c.keep) && c.drop.every((d) => !out.includes(d));
      });
      terminal.input('\x15');
      await waitFor(() => {
        const out = plainTerminalOutput(terminal.screenOutput());
        return (
          out.includes('GPT 5.5 Preview') && out.includes('GLM Max') && out.includes('text-unicorn')
        );
      });
    }

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('switches models in a fresh conversation without a cache warning', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'gpt-5.5',
      connectionId: 'connection-openai',
      connectionSlug: 'openai',
      providerType: 'openai',
      modelChoices: [
        {
          connectionId: 'connection-openai',
          connectionSlug: 'openai',
          connectionName: 'OpenAI',
          providerType: 'openai',
          model: 'gpt-5.5',
          isDefaultConnection: true,
        },
        {
          connectionId: 'connection-openai',
          connectionSlug: 'openai',
          connectionName: 'OpenAI',
          providerType: 'openai',
          model: 'gpt-5.6',
          isDefaultConnection: true,
        },
      ],
      permissionMode: 'ask',
      terminal,
    });

    await waitForTuiPaint(terminal);
    terminal.input('/model');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('gpt-5.6'));
    assert.doesNotMatch(
      plainTerminalOutput(terminal.screenOutput()),
      /Switching models may rebuild the prompt cache/,
    );
    terminal.input('\x1b[B');
    terminal.input('\r');
    await waitFor(() => driver.models.length === 1);
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Model changed: gpt-5.5 → gpt-5.6'),
    );

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('names both connections when the model id stays the same', async () => {
    const terminal = new FakeTerminal();
    terminal.resize(120, 40);
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'shared-model',
      connectionId: 'connection-primary',
      connectionSlug: 'primary',
      providerType: 'openai',
      modelChoices: [
        {
          connectionId: 'connection-primary',
          connectionSlug: 'primary',
          connectionName: 'Primary',
          providerType: 'openai',
          model: 'shared-model',
          isDefaultConnection: true,
        },
        {
          connectionId: 'connection-relay',
          connectionSlug: 'relay',
          connectionName: 'Relay',
          providerType: 'openai',
          model: 'shared-model',
          isDefaultConnection: false,
        },
      ],
      permissionMode: 'ask',
      terminal,
    });

    await waitForTuiPaint(terminal);
    terminal.input('/model');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Select Model'));
    terminal.input('\x1b[B');
    terminal.input('\r');

    await waitFor(() => driver.modelConnections.length === 1);
    assert.deepEqual(driver.modelConnections, ['relay']);
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes(
        'Model changed: shared-model (Primary · primary) → shared-model (Relay · relay)',
      ),
    );

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('disambiguates same-name onboarded accounts and selects the exact slug', async () => {
    const terminal = new FakeTerminal();
    terminal.resize(180, 40);
    const driver = new SlashCommandDriver();
    const catalog: ConnectionCatalogSnapshot = {
      revision: 2,
      defaultTarget: { connectionId: 'openai-account-1', modelId: 'shared-model' },
      connections: [
        {
          connectionId: 'openai-account-1',
          revision: 1,
          slug: 'openai',
          name: 'OpenAI',
          providerType: 'openai',
          enabled: true,
          enabledModelIds: ['shared-model'],
          models: [{ id: 'shared-model' }],
        },
        {
          connectionId: 'openai-account-2',
          revision: 1,
          slug: 'openai-2',
          name: 'OpenAI',
          providerType: 'openai',
          enabled: true,
          enabledModelIds: ['shared-model'],
          models: [{ id: 'shared-model' }],
        },
      ],
    };
    const modelChoices = projectRuntimeHostModelChoices(catalog);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'shared-model',
      connectionSlug: 'openai',
      providerType: 'openai',
      modelChoices,
      permissionMode: 'ask',
      terminal,
    });

    await waitForTuiPaint(terminal);
    terminal.input('/model');
    terminal.input('\r');
    await waitFor(() => {
      const output = plainTerminalOutput(terminal.screenOutput());
      return output.includes('OpenAI · openai') && output.includes('OpenAI · openai-2');
    });
    terminal.input('\x1b[B');
    terminal.input('\r');

    await waitFor(() => driver.modelConnections.length === 1);
    assert.deepEqual(driver.modelConnections, ['openai-2']);
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes(
        'Model changed: shared-model (OpenAI · openai) → shared-model (OpenAI · openai-2)',
      ),
    );

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('disambiguates a connection name that collides with another fallback slug', () => {
    assert.deepEqual(
      [
        ...modelChoiceConnectionLabels([
          {
            connectionSlug: 'openai',
            connectionName: 'openai-2',
            providerType: 'openai',
            model: 'model-a',
            isDefaultConnection: true,
          },
          {
            connectionSlug: 'openai-2',
            connectionName: '   ',
            providerType: 'openai',
            model: 'model-b',
            isDefaultConnection: false,
          },
        ]),
      ],
      [
        ['openai-2', 'openai-2'],
        ['openai', 'openai-2 · openai'],
      ],
    );
  });

  test('keeps final account labels globally unique after formatting collisions', () => {
    const labels = modelChoiceConnectionLabels([
      {
        connectionId: 'connection-a',
        connectionSlug: 'openai',
        connectionName: 'OpenAI',
        providerType: 'openai',
        model: 'model-a',
        isDefaultConnection: true,
      },
      {
        connectionId: 'connection-b',
        connectionSlug: 'openai-2',
        connectionName: 'OpenAI',
        providerType: 'openai',
        model: 'model-b',
        isDefaultConnection: false,
      },
      {
        connectionId: 'connection-c',
        connectionSlug: 'relay',
        connectionName: 'OpenAI · openai',
        providerType: 'openai',
        model: 'model-c',
        isDefaultConnection: false,
      },
    ]);

    assert.equal(new Set(labels.values()).size, 3);
    assert.equal(labels.get('openai'), 'OpenAI · openai');
    assert.equal(labels.get('relay'), 'OpenAI · openai · relay');
  });

  test('ignores a delayed title refresh after switching sessions', async () => {
    const terminal = new FakeTerminal();
    const driver = new DeferredListSessionsDriver([
      fakeSessionSummary('session-1', '/repo', 'Old title'),
      fakeSessionSummary('session-2', '/repo', 'Current title'),
    ]);
    let notifyTitleChanged: ((sessionId: string) => void) | undefined;
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      subscribeSessionTitleChanges: (listener) => {
        notifyTitleChanged = listener;
        return () => {};
      },
    });

    notifyTitleChanged?.('session-1');
    await waitFor(() => driver.listCalls === 1);
    terminal.input('/session session-2');
    terminal.input('\r');
    await waitFor(() => terminal.titles.includes('Current title (Maka)'));

    driver.releaseList();
    await delay(0);
    assert.equal(
      terminal.titles.some((title) => title.includes('Old title')),
      false,
    );

    exitMaka(terminal);
    await run;
  });

  test('ignores a delayed title refresh after a manual rename', async () => {
    const terminal = new FakeTerminal();
    const driver = new DeferredListSessionsDriver([
      fakeSessionSummary('session-1', '/repo', 'Stale generated title'),
    ]);
    let notifyTitleChanged: ((sessionId: string) => void) | undefined;
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      subscribeSessionTitleChanges: (listener) => {
        notifyTitleChanged = listener;
        return () => {};
      },
    });

    notifyTitleChanged?.('session-1');
    await waitFor(() => driver.listCalls === 1);
    terminal.input('/rename Manual title');
    terminal.input('\r');
    await waitFor(() => terminal.titles.includes('Manual title (Maka)'));

    driver.releaseList();
    await delay(0);
    assert.equal(terminal.titles.at(-1), 'Manual title (Maka)');

    exitMaka(terminal);
    await run;
  });

  test('nests linked child sessions in the picker and allows opening one directly', async () => {
    const terminal = new FakeTerminal();
    const parent = fakeSessionSummary('parent-session', '/repo', 'Parent chat');
    const child = {
      ...fakeSessionSummary('child-session', '/repo', 'Local Read'),
      subagentParent: {
        kind: 'subagent' as const,
        parentSessionId: parent.id,
        spawnedBy: {
          parentRunId: 'parent-run',
          parentTurnId: 'parent-turn',
          toolCallId: 'tool-call',
        },
        lifecycle: 'foreground' as const,
      },
      subagentRuntime: {
        schemaVersion: 1 as const,
        definitionVersion: 1,
        agentId: 'local-read',
        agentName: 'Local Read',
        profile: 'local_read',
        toolNames: ['Read', 'Glob', 'Grep'],
      },
    };
    const driver = new SlashCommandDriver([parent, child]);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/session');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('↳ Local Read'));
    assert.match(plainTerminalOutput(terminal.screenOutput()), /Local Read.*subagent:local_read/);
    assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /\bactive\b/);

    terminal.input('\x1b[B');
    terminal.input('\r');
    await waitFor(() => driver.sessionIds.includes(child.id));

    exitMaka(terminal);
    await run;
  });

  test('shows localized live status badges in the Session picker', async () => {
    const terminal = new FakeTerminal(160, 30);
    const driver = new SlashCommandDriver([
      {
        ...fakeSessionSummary('session-running', '/repo', 'Running chat'),
        status: 'running',
        runningTurnIds: ['turn-live'],
      },
      {
        ...fakeSessionSummary('session-stale', '/repo', 'Stale running chat'),
        status: 'running',
        runningTurnIds: [],
      },
      {
        ...fakeSessionSummary('session-permission', '/repo', 'Permission chat'),
        status: 'waiting_for_user',
        blockedReason: 'permission_required',
      },
      {
        ...fakeSessionSummary('session-auth', '/repo', 'Auth chat'),
        status: 'blocked',
        blockedReason: 'auth',
      },
      {
        ...fakeSessionSummary('session-noise', '/repo', 'Retryable chat'),
        status: 'blocked',
        blockedReason: 'tool_failed',
      },
      {
        ...fakeSessionSummary('session-stopped', '/repo', 'Stopped chat'),
        status: 'aborted',
      },
    ]);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      locale: 'en',
      terminal,
    });

    terminal.input('/session');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('needs permission'));
    const output = plainTerminalOutput(terminal.screenOutput());
    assert.match(output, /Running chat.*session- · running/);
    assert.doesNotMatch(output, /Stale running chat.* · running/);
    assert.match(output, /Permission chat.*session- · needs permission/);
    assert.match(output, /Auth chat.*session- · needs sign-in/);
    assert.match(output, /Stopped chat.*session- · stopped/);
    assert.match(output, /Retryable chat.*session-/);
    assert.doesNotMatch(output, /waiting_for_user|permission_required|tool_failed/);

    terminal.input('\x1b');
    exitMaka(terminal);
    await run;
  });

  test('imports a foreign session from /session into a fresh handoff turn', async () => {
    const terminal = new FakeTerminal();
    // No Maka sessions, so the only picker row is the foreign one.
    const driver = new SlashCommandDriver([]);
    const summary = {
      source: 'claude-code' as const,
      id: 'fabc',
      title: 'Prior parser work',
      cwd: '/repo',
      updatedAtMs: Date.now(),
      transcriptPath: '/home/u/.claude/projects/-repo/fabc.jsonl',
    };
    let readDigestCalls = 0;
    const foreignSessions = {
      availableSources: async () => ['claude-code' as const],
      listSessions: async () => [summary],
      readDigest: async () => {
        readDigestCalls += 1;
        return {
          source: 'claude-code' as const,
          id: 'fabc',
          title: 'Prior parser work',
          cwd: '/repo',
          updatedAtMs: summary.updatedAtMs,
          userMessages: ['重构解析器'],
          assistantTexts: ['已修复并补测试'],
          filesTouched: ['/repo/parser.ts'],
          warnings: [],
        };
      },
    };
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      foreignSessions,
    });

    terminal.input('/session');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Resume Session Current'));
    // The foreign row is labeled by its title and marked as a resume-from row.
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Prior parser work'));
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('resume from Claude Code'));

    terminal.input('\r');
    await waitFor(() => readDigestCalls === 1);
    await waitFor(() => driver.startNewSessionCalls === 1);
    await waitFor(() => driver.prompts.length === 1);

    // The transcript shows a short human line; the model receives the full
    // untrusted handoff envelope.
    assert.equal(driver.displayPrompts[0], 'Resuming Claude Code session: Prior parser work');
    assert.match(driver.prompts[0]!, /<foreign-session-digest>/);
    assert.match(driver.prompts[0]!, /untrusted reference DATA/);
    assert.match(driver.prompts[0]!, /重构解析器/);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('surfaces a notice when the foreign-session scan fails', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver([]);
    const foreignSessions = {
      availableSources: async () => ['claude-code' as const],
      listSessions: async () => {
        throw new Error('corrupt index');
      },
      readDigest: async () => {
        throw new Error('unused');
      },
    };
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      foreignSessions,
    });

    terminal.input('/session');
    terminal.input('\r');
    // The scan failure is surfaced, not swallowed into an empty list.
    await waitFor(() =>
      plainTerminalOutput(terminal.output()).includes('读取外部对话失败：corrupt index'),
    );

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('restores switched session state from stored messages', async () => {
    // 120 cols: the status line fits every segment, so the usage segments this
    // test asserts (ctx, cache) are not priority-dropped (#3421).
    const terminal = new FakeTerminal(120);
    const driver = new SlashCommandDriver(
      [fakeSessionSummary('session-2', '/repo')],
      new Map([
        [
          'session-2',
          [
            storedUserMessage('user-1', 'turn-1', 'previous question'),
            storedAssistantMessage('assistant-1', 'turn-1', 'previous answer'),
            {
              type: 'token_usage',
              id: 'usage-1',
              turnId: 'turn-1',
              ts: 3,
              input: 100,
              output: 20,
              cacheHitInput: 20,
              cacheMissInput: 80,
              contextRemaining: 490_000,
            },
            {
              type: 'token_usage',
              id: 'usage-2',
              turnId: 'turn-1',
              ts: 4,
              input: 100,
              output: 20,
              cacheHitInput: 60,
              cacheMissInput: 40,
              contextRemaining: 480_000,
            },
          ],
        ],
      ]),
    );
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      modelContextWindow: 500_000,
      terminal,
    });

    terminal.input('/session session-2');
    terminal.input('\r');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('previous question'));
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('previous answer'));
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('ctx 20k/500k 4%'));
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('cache 40%'));
    const output = plainTerminalOutput(terminal.output());
    assert.equal(output.includes('Session: session-2'), false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('hydrates a resumed background Bash card from durable shell-run state', async () => {
    const terminal = new FakeTerminal();
    const ref = 'maka://runtime/background-tasks/bg-1';
    const driver = new SlashCommandDriver(
      [fakeSessionSummary('session-2', '/repo')],
      new Map([
        [
          'session-2',
          [
            {
              type: 'tool_call',
              id: 'tool-bg',
              turnId: 'turn-1',
              ts: 1,
              toolName: 'Bash',
              args: { command: 'build' },
            },
            {
              type: 'tool_result',
              id: 'result-bg',
              turnId: 'turn-1',
              ts: 2,
              toolUseId: 'tool-bg',
              isError: false,
              content: {
                kind: 'shell_run',
                ref,
                mode: 'pipes',
                status: 'running',
                cwd: '/repo',
                cmd: 'build',
                startedAt: 1_000,
                updatedAt: 2_000,
                revision: 2_000,
                output: pipeOutput('starting\n'),
              },
            },
          ] satisfies StoredMessage[],
        ],
      ]),
    );
    const reads: string[] = [];
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      listShellRunUpdates: async (sessionId) => {
        reads.push(sessionId);
        return [
          {
            sessionId,
            ownership: { kind: 'local' },
            sourceTurnId: 'turn-1',
            sourceToolCallId: 'tool-bg',
            result: {
              kind: 'shell_run',
              ref,
              mode: 'pipes',
              status: 'completed',
              cwd: '/repo',
              cmd: 'build',
              startedAt: 1_000,
              updatedAt: 5_000,
              completedAt: 5_000,
              exitCode: 0,
              revision: 5_000,
              output: pipeOutput('starting\ndone\n'),
            },
          },
        ];
      },
    });

    terminal.input('/session session-2');
    terminal.input('\r');

    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('(4s · 2 lines)'));
    assert.deepEqual(reads, ['session-2']);
    // Hydration is catch-up replay of durable state, not a live settle: the
    // card flips silently, with no Background task notice at the tail.
    assert.equal(plainTerminalOutput(terminal.output()).includes('Background task'), false);

    exitMaka(terminal);
    await run;
  });

  test('announces a live settle that arrives after hydration completes', async () => {
    const terminal = new FakeTerminal();
    const ref = 'maka://runtime/background-tasks/bg-1';
    const driver = new SlashCommandDriver(
      [fakeSessionSummary('session-2', '/repo')],
      new Map([
        [
          'session-2',
          [
            {
              type: 'tool_call',
              id: 'tool-bg',
              turnId: 'turn-1',
              ts: 1,
              toolName: 'Bash',
              args: { command: 'build' },
            },
            {
              type: 'tool_result',
              id: 'result-bg',
              turnId: 'turn-1',
              ts: 2,
              toolUseId: 'tool-bg',
              isError: false,
              content: {
                kind: 'shell_run',
                ref,
                mode: 'pipes',
                status: 'running',
                cwd: '/repo',
                cmd: 'build',
                startedAt: 1_000,
                updatedAt: 2_000,
                revision: 2_000,
                output: pipeOutput('starting\n'),
              },
            },
          ] satisfies StoredMessage[],
        ],
      ]),
    );
    let listener: ((update: ShellRunUpdate) => void) | undefined;
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      subscribeShellRunUpdates: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      // The run is still live at attach time, so catch-up only refreshes output.
      listShellRunUpdates: async (sessionId) => [
        {
          sessionId,
          ownership: { kind: 'local' },
          sourceTurnId: 'turn-1',
          sourceToolCallId: 'tool-bg',
          result: {
            kind: 'shell_run',
            ref,
            mode: 'pipes',
            status: 'running',
            cwd: '/repo',
            cmd: 'build',
            startedAt: 1_000,
            updatedAt: 3_000,
            revision: 3_000,
            output: pipeOutput('starting\nstill running\n'),
          },
        },
      ],
    });

    terminal.input('/session session-2');
    terminal.input('\r');

    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('running'));
    assert.equal(plainTerminalOutput(terminal.output()).includes('Background task'), false);

    // The settle lands through the live subscription after hydration: exactly
    // one notice fires.
    await waitFor(() => listener !== undefined);
    assert.ok(listener);
    listener({
      sessionId: 'session-2',
      ownership: { kind: 'local' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'tool-bg',
      result: {
        kind: 'shell_run',
        ref,
        mode: 'pipes',
        status: 'completed',
        cwd: '/repo',
        cmd: 'build',
        startedAt: 1_000,
        updatedAt: 5_000,
        completedAt: 5_000,
        exitCode: 0,
        revision: 5_000,
        output: pipeOutput('starting\nstill running\ndone\n'),
      },
    });

    await waitFor(() =>
      plainTerminalOutput(terminal.output()).includes('Background task completed: build'),
    );
    // Sentinel render: a duplicate announcement from the same update would be
    // in the cumulative output by the time the typed char paints.
    terminal.input('z');
    await waitFor(() => editorInputText(terminal) === 'z');
    const announcements =
      plainTerminalOutput(terminal.output()).split('Background task completed').length - 1;
    assert.equal(announcements, 1);

    exitMaka(terminal);
    await run;
  });

  test('shows every connection in Current while hiding other cwd sessions', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver([
      fakeSessionSummary('session-current', '/repo', 'Current chat'),
      {
        ...fakeSessionSummary('session-other-connection', '/repo', 'Other connection chat'),
        llmConnectionSlug: 'zai',
      },
      fakeSessionSummary('session-other', '/elsewhere', 'Other chat'),
    ]);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/session');
    terminal.input('\r');

    await waitFor(() => terminal.output().includes('Current chat'));
    const output = plainTerminalOutput(terminal.output());
    assert.equal(output.includes('Other connection chat'), true);
    assert.equal(output.includes('Other chat'), false);

    terminal.input('\x1b');
    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('adopts a resumed cwd and remembers the All scope for the TUI process', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver([
      fakeSessionSummary('session-current', '/repo', 'Current chat'),
      fakeSessionSummary('session-other', '/elsewhere', 'Other chat'),
    ]);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/session');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Current chat'));
    terminal.input('\t');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Other chat'));
    terminal.input('\x1b[B');
    terminal.input('\r');
    await waitFor(() => driver.sessionIds.includes('session-other'));
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('/elsewhere'));

    terminal.input('/session');
    terminal.input('\r');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Resume Session All'),
    );
    terminal.input('\t');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Resume Session Current'),
    );
    const currentOutput = plainTerminalOutput(terminal.screenOutput());
    assert.equal(currentOutput.includes('Other chat'), true);
    assert.equal(currentOutput.includes('Current chat'), false);

    terminal.input('\x1b');
    exitMaka(terminal);
    await run;
  });

  test('keeps live status visible for a session without a cwd but prevents resuming it', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver([
      fakeSessionSummary('session-current', '/repo', 'Current chat'),
      {
        ...fakeSessionSummary('session-legacy', '/repo', 'Legacy chat'),
        cwd: undefined,
        status: 'running',
        runningTurnIds: ['turn-live'],
      },
    ]);
    Object.defineProperty(driver, 'getSessionResumeAvailability', { value: undefined });
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/session');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Current chat'));
    terminal.input('\t');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Missing working directory'),
    );
    terminal.input('\x1b[B');
    terminal.input('\r');
    // Selection handling runs synchronously off the input dispatch; one
    // macrotask turn (which drains every queued microtask first) settles it.
    await delay(0);

    assert.match(
      plainTerminalOutput(terminal.screenOutput()),
      /Legacy chat.*session- · running Missing working directory/,
    );

    terminal.input('\x1b');
    exitMaka(terminal);
    await run;
    // Anchored after close: a wrongly-honored resume would show in sessionIds.
    assert.deepEqual(driver.sessionIds, []);
  });

  test('/new cancels hydration retries owned by the previous session', async () => {
    const terminal = new FakeTerminal();
    const driver = new RewindDriver([{ turnId: 'turn-2', label: 'second question' }]);
    let hydrationAttempts = 0;
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      listShellRunUpdates: async () => {
        hydrationAttempts += 1;
        throw new Error('transient hydration failure');
      },
    });

    terminal.input('/rewind');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('回到选定轮次'));
    terminal.input('\r');
    await waitFor(() => hydrationAttempts === 1);
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('refilled: turn-2'));

    terminal.input('\x03');
    terminal.input('/new');
    terminal.input('\r');
    await waitFor(() => driver.startNewSessionCalls === 1);
    const attemptsAfterReset = hydrationAttempts;
    // Real-timer negative window, derived from the hydration retry schedule
    // (first retry arms at 250ms): outliving that slot with no new attempt
    // proves /new's reset cleared the timer rather than letting it fire.
    await delay(300);
    assert.equal(hydrationAttempts, attemptsAfterReset);

    exitMaka(terminal);
    await run;
  });

  test('serializes a control command with prompts and shared session activity', async () => {
    const terminal = new FakeTerminal();
    const driver = new DeferredControlDriver();
    const activities = new SessionActivityRegistry();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      turnActivity: createTestTurnActivity(activities),
    });

    terminal.input('/model claude-opus-4-1');
    terminal.input('\r');
    await waitFor(() => driver.models.length === 1);
    const controlCompletion = activities.whenIdle('session-1');
    assert.ok(controlCompletion);

    let automationAcquired = false;
    const automationActivity = activities.acquire('session-1').then((lease) => {
      automationAcquired = true;
      return lease;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(automationAcquired, false);

    // While the model switch is in flight, typing + Enter must not send a
    // prompt. The submit gate runs synchronously off the input dispatch; one
    // macrotask turn (which drains every queued microtask first) settles it.
    terminal.input('blocked');
    terminal.input('\r');
    await delay(0);
    assert.deepEqual(driver.prompts, []);

    // After the switch completes, the previously typed prompt goes through.
    driver.releaseSetModel();
    await controlCompletion;
    const automationLease = await automationActivity;
    automationLease.release();
    // The control action's busy release settles through its promise
    // continuations; one macrotask turn runs strictly after them.
    await delay(0);
    terminal.input('\r');
    await waitFor(() => driver.prompts.length === 1);
    assert.deepEqual(driver.prompts, ['blocked']);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('keeps the sandbox boundary prompt visible when responding rejects', async () => {
    const terminal = new FakeTerminal();
    const driver = new RejectingSandboxBoundaryDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Allow access outside the workspace?'));

    terminal.input('y');
    await waitFor(() => driver.responses.length === 1);

    // Response rejected: the boundary prompt stays armed and can be retried.
    // The second response landing is the observable proof — an unarmed prompt
    // would swallow the 'n' instead of responding.
    terminal.input('n');
    await waitFor(() => driver.responses.length === 2);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('blocks prompts while the session list is loading', async () => {
    const terminal = new FakeTerminal();
    const driver = new DeferredListSessionsDriver([fakeSessionSummary('session-2')]);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/session');
    terminal.input('\r');
    await waitFor(() => driver.listCalls === 1);

    // While the list is still loading, a submitted prompt must not go through.
    // The submit gate runs synchronously off the input dispatch; one macrotask
    // turn (which drains every queued microtask first) settles it.
    terminal.input('hello');
    terminal.input('\r');
    await delay(0);
    assert.deepEqual(driver.prompts, []);

    driver.releaseList();
    // The rendered picker is the observable arming signal for the Escape.
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Existing chat'));

    terminal.input('\x1b');
    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('interrupts the running turn on double Escape', async () => {
    const terminal = new FakeTerminal();
    const driver = new InterruptibleTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);

    // Escape handling runs synchronously off the input dispatch; one macrotask
    // turn (which drains every queued microtask first) is a deterministic
    // settle for the single-Escape-does-not-stop check.
    terminal.input('\x1b');
    await delay(0);
    assert.equal(driver.stopCalls, 0);

    terminal.input('\x1b');
    await waitFor(() => driver.stopCalls === 1);
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Stopped: user_stop'));
    await waitFor(() => terminal.progressStates.at(-1) === false);

    // Idle double Escape opens the rewind picker, never a stop: the session is
    // between turns. This fake exposes no rewind targets, so it only shows a
    // notice, but the contract under test is that stopSession is not fired again.
    terminal.input('\x1b');
    terminal.input('\x1b');
    await delay(0);
    assert.equal(driver.stopCalls, 1);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('opens a rewind picker from /rewind and branches on select', async () => {
    const terminal = new FakeTerminal();
    const driver = new RewindDriver(
      [
        { turnId: 'turn-2', label: 'second question' },
        { turnId: 'turn-1', label: 'first question' },
      ],
      [
        storedUserMessage('user-1', 'turn-1', 'first question'),
        storedAssistantMessage('assistant-1', 'turn-1', 'first answer'),
      ],
    );
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/rewind');
    terminal.input('\r');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('回到选定轮次'));
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('second question'));
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('first question'));

    // The picker lists targets newest-first, so the default selection is turn-2.
    terminal.input('\r');
    await waitFor(() => driver.rewound.length === 1);
    assert.deepEqual(driver.rewound, ['turn-2']);
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('已回退到该轮之前'));
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('first answer'));
    // The rewound turn's prompt is refilled into the editor for an edit-and-resend.
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('refilled: turn-2'));

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('shows an in-progress notice while the rewind branch is being created', async () => {
    const terminal = new FakeTerminal();
    const driver = new DeferredRewindDriver(
      [{ turnId: 'turn-1', label: 'first question' }],
      [
        storedUserMessage('user-0', 'turn-0', 'earlier question'),
        storedAssistantMessage('assistant-0', 'turn-0', 'earlier answer'),
      ],
    );
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/rewind');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('first question'));

    terminal.input('\r');
    // The branch switch is still in flight, but the selection must already be
    // visibly accepted — control-busy otherwise renders nothing (#3383).
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('正在回退到该轮之前'));
    assert.deepEqual(driver.rewound, []);

    driver.gate.resolve();
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('已回退到该轮之前'));
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('refilled: turn-1'));
    // The in-progress notice is wiped together with the transcript it announced.
    await waitFor(
      () => plainTerminalOutput(terminal.screenOutput()).includes('正在回退到该轮之前') === false,
    );

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('keeps a draft typed while the rewind is in flight instead of overwriting it', async () => {
    const terminal = new FakeTerminal();
    const driver = new DeferredRewindDriver([{ turnId: 'turn-1', label: 'first question' }]);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/rewind');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('first question'));
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('正在回退到该轮之前'));

    // Typed while the branch switch is in flight: this is newer user work and
    // must win over the prompt refill (#3383). Enter stays swallowed by
    // disableSubmit, so the draft never becomes a turn.
    terminal.input('my draft');
    await waitFor(() => editorInputText(terminal) === 'my draft');
    terminal.input('\r');
    assert.deepEqual(driver.prompts, []);

    driver.gate.resolve();
    // The notice wraps across screen lines at 80 columns, so match against a
    // whitespace-collapsed copy instead of the raw output.
    const collapsedOutput = () => plainTerminalOutput(terminal.output()).replace(/\s+/g, '');
    await waitFor(() => collapsedOutput().includes('未覆盖'));
    await waitFor(() => editorInputText(terminal) === 'my draft');
    assert.equal(plainTerminalOutput(terminal.output()).includes('refilled: turn-1'), false);
    // The ↑ recovery promise must hold even though nothing was submitted in
    // this TUI process (a resumed session has no live-path history entry):
    // the rewound prompt is recorded explicitly on completion (#3475 review).
    // The first ↑ only jumps to line start while the cursor sits at col > 0;
    // the second one then enters history recall.
    terminal.input('\x1b[A');
    terminal.input('\x1b[A');
    await waitFor(() => editorInputText(terminal) === 'refilled: turn-1');

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('lets a bracketed paste still being buffered win over the prompt refill', async () => {
    const terminal = new FakeTerminal();
    const driver = new DeferredRewindDriver([{ turnId: 'turn-1', label: 'first question' }]);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/rewind');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('first question'));
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('正在回退到该轮之前'));

    // A bracketed paste starts while the branch switch is in flight and its end
    // marker has not arrived: getText() still reports empty, but the buffered
    // bytes are newer user input and must win over the refill (#3475 review).
    terminal.input('\x1b[200~pasted half');

    driver.gate.resolve();
    // The completion notice wraps across screen lines at 80 columns, so match a
    // whitespace-collapsed copy.
    await waitFor(() =>
      plainTerminalOutput(terminal.output()).replace(/\s+/g, '').includes('未覆盖'),
    );

    // Only now does the paste complete — after the refill decision was made.
    terminal.input(' rest\x1b[201~');
    await waitFor(() => editorInputText(terminal)?.includes('pasted half rest') ?? false);
    assert.equal(editorInputText(terminal)?.includes('refilled'), false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('refuses a rewind selection with a notice when another action claimed busy', async () => {
    const terminal = new FakeTerminal();
    const driver = new BusyAfterPickerOpenDriver([{ turnId: 'turn-1', label: 'first question' }]);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/rewind');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('first question'));

    // A Host-started turn claims busy while the picker is open (the same way a
    // Goal auto-continuation would). Selecting a target must then surface a
    // refusal instead of runControl's silent early return (#3383).
    driver.startBlockingTurn();
    await waitFor(() => terminal.progressStates.at(-1) === true);

    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('无法回退'));
    assert.deepEqual(driver.rewound, []);

    driver.turnGate.resolve();
    await waitFor(() => terminal.progressStates.at(-1) === false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('marks an inherited running Bash card detached after rewind', async () => {
    const terminal = new FakeTerminal();
    const ref = 'maka://runtime/background-tasks/bg-1';
    const branchMessages = [
      {
        type: 'tool_call',
        id: 'tool-bg',
        turnId: 'turn-1',
        ts: 1,
        toolName: 'Bash',
        args: { command: 'build' },
      },
      {
        type: 'tool_result',
        id: 'result-bg',
        turnId: 'turn-1',
        ts: 2,
        toolUseId: 'tool-bg',
        isError: false,
        content: {
          kind: 'shell_run',
          ref,
          mode: 'pipes',
          status: 'running',
          cwd: '/repo',
          cmd: 'build',
          startedAt: 1_000,
          updatedAt: 2_000,
          revision: 2_000,
          output: pipeOutput('still running\n'),
        },
      },
    ] satisfies StoredMessage[];
    const driver = new RewindDriver(
      [{ turnId: 'turn-2', label: 'second question' }],
      branchMessages,
      { ...fakeSessionSummary('session-branch'), parentSessionId: 'session-1' },
    );
    let listener: ((update: ShellRunUpdate) => void) | undefined;
    let hydrationAttempts = 0;
    let resolveHydration: ((updates: ShellRunUpdate[]) => void) | undefined;
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      subscribeShellRunUpdates: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      listShellRunUpdates: () => {
        hydrationAttempts += 1;
        if (hydrationAttempts === 1)
          return Promise.reject(new Error('transient hydration failure'));
        return new Promise((resolve) => {
          resolveHydration = resolve;
        });
      },
    });

    terminal.input('/rewind');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('回到选定轮次'));
    terminal.input('\r');

    await waitFor(() => hydrationAttempts === 1);
    assert.ok(listener);
    listener({
      sessionId: 'session-1',
      ownership: { kind: 'local' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'tool-bg',
      result: {
        kind: 'shell_run',
        ref,
        mode: 'pipes',
        status: 'running',
        cwd: '/repo',
        cmd: 'build',
        startedAt: 1_000,
        updatedAt: 4_000,
        revision: 4_000,
        output: pipeOutput('still running\nbuffered owner revision\n'),
      },
    });
    await waitFor(() => resolveHydration !== undefined);
    assert.ok(resolveHydration);
    resolveHydration([
      {
        sessionId: 'session-branch',
        ownership: {
          kind: 'source_owned',
          sourceSessionId: 'session-1',
          ownerSessionId: 'session-1',
        },
        sourceTurnId: 'turn-1',
        sourceToolCallId: 'tool-bg',
        result: {
          kind: 'shell_run',
          ref,
          mode: 'pipes',
          status: 'running',
          cwd: '/repo',
          cmd: 'build',
          startedAt: 1_000,
          updatedAt: 3_000,
          revision: 3_000,
          output: pipeOutput('still running\n'),
        },
      },
    ]);

    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('detached'));
    // The stale one-line hydration must not clobber the newer two-line local
    // output: the compact row reports the merged output's line count.
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('2 lines'));
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('1 line'), false);
    assert.equal(
      plainTerminalOutput(terminal.screenOutput()).includes('Ask Maka to stop this task'),
      false,
    );

    assert.ok(listener);
    listener({
      sessionId: 'session-1',
      ownership: { kind: 'local' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'tool-bg',
      result: {
        kind: 'shell_run',
        ref,
        mode: 'pipes',
        status: 'completed',
        cwd: '/repo',
        cmd: 'build',
        startedAt: 1_000,
        updatedAt: 5_000,
        completedAt: 5_000,
        exitCode: 0,
        revision: 5_000,
        output: pipeOutput('still running\nbuffered owner revision\ndone\n'),
      },
    });
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('3 lines'));
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('detached'), false);

    // The detached card's run resource was still `running`, so the owner's live
    // settle announces exactly once at the transcript tail — the `detached`
    // presentation status must not swallow the transition.
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Background task completed: build'),
    );
    assert.equal(
      plainTerminalOutput(terminal.screenOutput()).split('Background task completed: build')
        .length - 1,
      1,
    );

    exitMaka(terminal);
    await run;
  });

  test('rehydrates after buffer overflow instead of losing an evicted terminal update', async () => {
    const terminal = new FakeTerminal();
    const ref = 'maka://runtime/background-tasks/bg-overflow';
    const branchMessages = [
      {
        type: 'tool_call',
        id: 'tool-bg',
        turnId: 'turn-1',
        ts: 1,
        toolName: 'Bash',
        args: { command: 'build' },
      },
      {
        type: 'tool_result',
        id: 'result-bg',
        turnId: 'turn-1',
        ts: 2,
        toolUseId: 'tool-bg',
        isError: false,
        content: {
          kind: 'shell_run',
          ref,
          mode: 'pipes',
          status: 'running',
          cwd: '/repo',
          cmd: 'build',
          startedAt: 1_000,
          updatedAt: 2_000,
          revision: 2_000,
          output: pipeOutput('still running\n'),
        },
      },
    ] satisfies StoredMessage[];
    const driver = new RewindDriver(
      [{ turnId: 'turn-2', label: 'second question' }],
      branchMessages,
      { ...fakeSessionSummary('session-branch'), parentSessionId: 'session-1' },
    );
    let listener: ((update: ShellRunUpdate) => void) | undefined;
    const hydrationResolvers: Array<(updates: ShellRunUpdate[]) => void> = [];
    let hydrationAttempts = 0;
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      subscribeShellRunUpdates: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      listShellRunUpdates: () => {
        hydrationAttempts += 1;
        return new Promise((resolve) => {
          hydrationResolvers.push(resolve);
        });
      },
    });

    terminal.input('/rewind');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('回到选定轮次'));
    terminal.input('\r');
    await waitFor(() => hydrationAttempts === 1);
    assert.ok(listener);
    listener({
      sessionId: 'session-1',
      ownership: { kind: 'local' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'tool-bg',
      result: {
        kind: 'shell_run',
        ref,
        mode: 'pipes',
        status: 'completed',
        cwd: '/repo',
        cmd: 'build',
        startedAt: 1_000,
        updatedAt: 5_000,
        completedAt: 5_000,
        exitCode: 0,
        revision: 5_000,
        output: pipeOutput('done but evicted\n'),
      },
    });
    for (let index = 0; index < SHELL_RUN_UPDATE_BUFFER_MAX_ENTRIES; index += 1) {
      listener({
        sessionId: `unrelated-owner-${index}`,
        ownership: { kind: 'local' },
        sourceTurnId: 'turn-unrelated',
        sourceToolCallId: `tool-unrelated-${index}`,
        result: {
          kind: 'shell_run',
          ref: `maka://runtime/background-tasks/unrelated-${index}`,
          mode: 'pipes',
          status: 'running',
          cwd: '/repo',
          cmd: 'sleep 1',
          startedAt: 1_000,
          updatedAt: 3_000,
          revision: 3_000,
          output: pipeOutput(''),
        },
      });
    }

    const firstHydration = hydrationResolvers.shift();
    assert.ok(firstHydration);
    firstHydration([
      {
        sessionId: 'session-branch',
        ownership: {
          kind: 'source_owned',
          sourceSessionId: 'session-1',
          ownerSessionId: 'session-1',
        },
        sourceTurnId: 'turn-1',
        sourceToolCallId: 'tool-bg',
        result: {
          kind: 'shell_run',
          ref,
          mode: 'pipes',
          status: 'running',
          cwd: '/repo',
          cmd: 'build',
          startedAt: 1_000,
          updatedAt: 3_000,
          revision: 3_000,
          output: pipeOutput('stale snapshot\n'),
        },
      },
    ]);
    await waitFor(() => hydrationAttempts === 2);

    const authoritativeHydration = hydrationResolvers.shift();
    assert.ok(authoritativeHydration);
    authoritativeHydration([
      {
        sessionId: 'session-branch',
        ownership: {
          kind: 'source_owned',
          sourceSessionId: 'session-1',
          ownerSessionId: 'session-1',
        },
        sourceTurnId: 'turn-1',
        sourceToolCallId: 'tool-bg',
        result: {
          kind: 'shell_run',
          ref,
          mode: 'pipes',
          status: 'completed',
          cwd: '/repo',
          cmd: 'build',
          startedAt: 1_000,
          updatedAt: 5_000,
          completedAt: 5_000,
          exitCode: 0,
          revision: 5_000,
          output: pipeOutput('authoritative terminal state\n'),
        },
      },
    ]);

    // The authoritative settled card is the one that shows its 4s elapsed
    // time; the intermediate detached snapshot only carries a line count.
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('(4s · 1 line)'));
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('detached'), false);
    assert.equal(hydrationAttempts, 2);

    exitMaka(terminal);
    await run;
  });

  test('idle double Escape opens the rewind picker; a single Escape does not', async () => {
    const terminal = new FakeTerminal();
    const driver = new RewindDriver([{ turnId: 'turn-1', label: 'first question' }]);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    await waitFor(() =>
      plainTerminalOutput(terminal.output()).includes(
        'Maka · Auto · claude-sonnet-4-5 · claude-subscription · /repo',
      ),
    );

    // A single Escape falls through to the editor: no picker yet. Sentinel
    // render: a wrongly-opened picker would be in the cumulative output by the
    // time the typed char paints. The char resets the gesture either way, so
    // it is removed before the real double Escape below.
    terminal.input('\x1b');
    terminal.input('z');
    await waitFor(() => editorInputText(terminal) === 'z');
    assert.equal(plainTerminalOutput(terminal.output()).includes('回到选定轮次'), false);
    terminal.input('\x7f');
    await waitFor(() => editorInputText(terminal) === '');

    // A consecutive Escape pair completes the gesture and opens the picker.
    terminal.input('\x1b');
    terminal.input('\x1b');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('回到选定轮次'));

    // Cancel the picker so Ctrl-C reaches the runner rather than the overlay.
    terminal.input('\x1b');
    await waitFor(() => !plainTerminalOutput(terminal.screenOutput()).includes('回到选定轮次'));

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('does not open the rewind picker while the editor has a draft', async () => {
    const terminal = new FakeTerminal();
    const driver = new RewindDriver([{ turnId: 'turn-1', label: 'first question' }]);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    await waitFor(() =>
      plainTerminalOutput(terminal.output()).includes(
        'Maka · Auto · claude-sonnet-4-5 · claude-subscription · /repo',
      ),
    );

    // While a draft is present, Escape belongs to the editor, not the rewind
    // gesture. Two Escapes must not open the picker. Input dispatch is
    // synchronous, so no settling is needed between keys.
    terminal.input('draft in progress');
    await waitFor(() => editorInputText(terminal) === 'draft in progress');
    terminal.input('\x1b');
    terminal.input('\x1b');
    // Sentinel render: a wrongly-opened picker would be on screen by the time
    // the typed char paints.
    terminal.input('z');
    await waitFor(() => editorInputText(terminal)?.endsWith('z') === true);
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('回到选定轮次'), false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
    // Anchored after close: a wrongly-opened picker selection would show here.
    assert.deepEqual(driver.rewound, []);
  });

  test('a non-Escape key between two Escapes does not open the rewind picker', async () => {
    const terminal = new FakeTerminal();
    const driver = new RewindDriver([{ turnId: 'turn-1', label: 'first question' }]);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    await waitFor(() =>
      plainTerminalOutput(terminal.output()).includes(
        'Maka · Auto · claude-sonnet-4-5 · claude-subscription · /repo',
      ),
    );

    // The editor stays neutral (empty) throughout, but a left-arrow between the
    // two Escapes breaks the gesture: the two Escapes must be consecutive.
    // Input dispatch is synchronous, so no settling is needed between keys.
    terminal.input('\x1b');
    terminal.input('\x1b[D');
    terminal.input('\x1b');
    // Sentinel render: a wrongly-opened picker would be on screen by the time
    // the typed char paints.
    terminal.input('z');
    await waitFor(() => editorInputText(terminal) === 'z');
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('回到选定轮次'), false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('interrupts at most once while the stop is still settling', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlowStopDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);

    terminal.input('\x1b');
    terminal.input('\x1b');
    await waitFor(() => driver.stopCalls === 1);

    // The turn has not ended yet (runtime stop is still settling). Further
    // double-Escapes must be swallowed, not fire a second stopSession that
    // would append a duplicate abort note to the session log. Escape handling
    // runs synchronously off the input dispatch; one macrotask turn (which
    // drains every queued microtask first) is a deterministic settle.
    terminal.input('\x1b');
    terminal.input('\x1b');
    await delay(0);
    assert.equal(driver.stopCalls, 1);

    driver.endTurn();
    await waitFor(() => terminal.progressStates.at(-1) === false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('stops the running turn on Ctrl-C without closing Maka', async () => {
    const terminal = new FakeTerminal();
    const driver = new InterruptibleTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);

    terminal.input('\x03');
    await waitFor(() => driver.stopCalls === 1);
    await waitFor(() => terminal.progressStates.at(-1) === false);

    assert.equal(terminal.stopCalls, 0);
    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('exits on a second Ctrl-C while a turn interrupt is still in flight', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlowStopDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);

    terminal.input('\x03');
    await waitFor(() => driver.stopCalls === 1);
    assert.equal(terminal.stopCalls, 0);

    terminal.input('\x03');
    try {
      await Promise.race([
        run,
        delay(CLOSE_BUDGET_MS).then(() => {
          throw new Error('TUI did not close after a second Ctrl-C');
        }),
      ]);
      assert.equal(driver.stopCalls, 1);
      assert.equal(terminal.stopCalls, 1);
    } finally {
      driver.endTurn();
      if (terminal.stopCalls === 0) exitMaka(terminal);
      await run;
    }
  });

  test('keeps Escape as deny while a sandbox boundary prompt is pending', async () => {
    const terminal = new FakeTerminal();
    const driver = new SandboxBoundaryPromptDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => driver.boundaryRequests === 1);
    // The rendered prompt is the observable arming signal: only once it owns
    // input do the Escapes mean deny instead of an interrupt gesture.
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Allow access outside the workspace?'),
    );

    terminal.input('\x1b');
    terminal.input('\x1b');
    await waitFor(() => driver.boundaryResponses.length >= 1);

    // Both Escapes route to the boundary prompt, never to turn interruption.
    assert.equal(driver.boundaryResponses[0]?.decision, 'deny');
    assert.equal(driver.stopCalls, 0);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('clears the sandbox boundary prompt when the turn errors', async () => {
    const terminal = new FakeTerminal();
    const driver = new SandboxBoundaryThenErrorDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Allow access outside the workspace?'));
    driver.continueToError();
    await waitFor(() => terminal.output().includes('turn failed'));

    // The turn errored: the boundary prompt must be gone from the screen.
    assert.equal(
      plainTerminalOutput(terminal.screenOutput()).includes('Allow access outside the workspace?'),
      false,
    );

    // y must not trigger a response for the now-dead request.
    terminal.input('y');

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
    // Anchored after close: every queued input has been drained, so a response
    // for the dead request would show in respondCalls by now.
    assert.equal(driver.respondCalls, 0);
  });

  test('enables focus reporting only after raw mode, so no stray ^[[I leaks on launch', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    await waitFor(() => terminal.writes.includes('\x1b[?1004h'));
    assert.ok(terminal.titles.includes('Maka'));

    // Enabling focus reporting before raw mode makes the terminal's focus-in
    // reply (`\x1b[I`) echo onto the screen as `^[[I`. The enable must be written
    // strictly after start() (raw mode on), never before.
    assert.notEqual(terminal.startWriteIndex, null);
    const focusEnableIndex = terminal.writes.indexOf('\x1b[?1004h');
    assert.ok(
      focusEnableIndex >= terminal.startWriteIndex!,
      'focus reporting was enabled before raw mode; a stray ^[[I can leak on launch',
    );

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('delegates explicit Skill invocation to the Host while showing the typed prompt', async () => {
    {
      const terminal = new FakeTerminal();
      const driver = new HostSkillDriver({
        loaded: [{ id: 'alpha', name: 'Alpha' }],
        failed: [],
        receipts: [],
      });
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'claude-sonnet-4-5',
        connectionSlug: 'claude-subscription',
        permissionMode: 'ask',
        terminal,
        listSkills: async () => [
          { ref: 'project:alpha', id: 'alpha', name: 'Alpha', description: 'Alpha skill' },
        ],
      });

      terminal.input('/skill:alpha 帮我整理');
      terminal.input('\r');
      await waitFor(() => driver.prompts.length === 1);

      assert.equal(
        driver.displayPrompts[0],
        '/skill:alpha 帮我整理',
        'human-facing prompt keeps the typed tokens',
      );
      assert.equal(driver.prompts[0], '/skill:alpha 帮我整理');

      // The transcript render trails the send by a tick — wait for it.
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('/skill:alpha 帮我整理'));
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('已加载技能：Alpha'));

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(CLOSE_BUDGET_MS).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    }
  });

  test('does not create a turn when every skill token fails to resolve', async () => {
    {
      const terminal = new FakeTerminal();
      const driver = new HostSkillDriver({
        loaded: [],
        failed: [{ request: 'nope', reason: 'not_found' }],
        receipts: [],
      });
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'claude-sonnet-4-5',
        connectionSlug: 'claude-subscription',
        permissionMode: 'ask',
        terminal,
        listSkills: async () => [],
      });

      terminal.input('/skill:nope hi');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes(
          '未能加载技能 /skill:nope（未找到）；未发起模型请求。',
        ),
      );
      assert.equal(driver.prompts.length, 0);

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(CLOSE_BUDGET_MS).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    }
  });

  test('does not create a turn when distinct skill requests exceed the preparation limit', async () => {
    {
      const terminal = new FakeTerminal();
      const driver = new HostSkillDriver({
        loaded: [],
        failed: [{ reason: 'too_many_requests', requestLimit: 50 }],
        receipts: [],
      });
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'claude-sonnet-4-5',
        connectionSlug: 'claude-subscription',
        permissionMode: 'ask',
        terminal,
        listSkills: async () => [],
      });
      const prompt = [
        '/skill:alpha',
        ...Array.from({ length: 50 }, (_, index) => `/skill:missing-${index}`),
        '帮我整理',
      ].join(' ');

      terminal.input(prompt);
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes(
          '请求超过 50 个上限（调用请求过多）；未发起模型请求。',
        ),
      );
      assert.equal(driver.prompts.length, 0);

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(CLOSE_BUDGET_MS).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    }
  });

  describe('/recap command', () => {
    // The bug this guards against: the idle-return recap is triggered BY the
    // very prompt that ends the idle gap, and that prompt's own turn runs for
    // the several seconds the recap call is in flight. A staleness check that
    // re-samples any turn-count signal after generate() resolves would see
    // that count already moved (because of that triggering prompt) and would
    // discard every idle recap unconditionally. The fix samples `promptSeq`
    // (bumped once per submitted prompt, including the triggering one)
    // synchronously on entry to runRecap, so only a prompt submitted *after*
    // entry — a genuinely later one — makes the result stale.
    test('an idle-triggered recap is discarded when a later prompt supersedes it before it resolves', async (t) => {
      const terminal = new FakeTerminal();
      const driver = new RewindDriver([
        { turnId: 'turn-1', label: 'first' },
        { turnId: 'turn-2', label: 'second' },
        { turnId: 'turn-3', label: 'third' },
      ]);
      const gate = deferred<void>();
      let calls = 0;
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'claude-sonnet-4-5',
        connectionSlug: 'claude-subscription',
        permissionMode: 'ask',
        terminal,
        recap: {
          generate: async () => {
            calls++;
            await gate.promise;
            return { ok: true, text: 'stale recap result', raw: 'stale recap result' };
          },
        },
      });

      const submit = async (prompt: string, expectedPromptCount: number) => {
        terminal.input(prompt);
        terminal.input('\r');
        await waitFor(() => driver.prompts.length === expectedPromptCount);
        await waitFor(() => terminal.progressStates.at(-1) === false);
      };

      // Fake a return-from-idle gap: freeze/advance Date just long enough for
      // submitPrompt to synchronously capture a qualifying idleMs, then
      // restore the real clock immediately — everything below (waitFor, the
      // in-flight generate() gate) depends on real elapsed time.
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      t.mock.timers.tick(AUTO_RECAP_IDLE_MS + 1_000);
      terminal.input('first prompt after idle');
      terminal.input('\r');
      t.mock.timers.reset();

      await waitFor(() => calls === 1); // idle auto-recap fired; generate() is in flight
      await waitFor(() => driver.prompts.length === 1);
      await waitFor(() => terminal.progressStates.at(-1) === false);

      // Submitted while the idle recap's generate() call is still pending:
      // this bumps promptSeq past the value runRecap captured on entry.
      await submit('a later prompt', 2);

      gate.resolve();
      // Sentinel render: a wrongly-rendered recap would be in the cumulative
      // output by the time the typed char paints (the recap continuation
      // settles on microtasks before that render lands).
      terminal.input('z');
      await waitFor(() => editorInputText(terminal) === 'z');
      assert.equal(
        plainTerminalOutput(terminal.output()).includes('Recap: stale recap result'),
        false,
        'an idle recap superseded by a later prompt must be dropped silently',
      );

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(CLOSE_BUDGET_MS).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });

    // PR #1182 review fix: recapInFlight must be set synchronously, before any
    // await, so two /recap submissions with no await between them (unlike the
    // "already running" test above, which waits for the first generate() call
    // to start before submitting the second) cannot both pass the
    // `recapInFlight` check before either sets it.
    test('two /recap commands submitted back-to-back with no await between them only start one generate() call', async () => {
      const terminal = new FakeTerminal();
      const driver = new RewindDriver([{ turnId: 'turn-1', label: 'first prompt' }]);
      const gate = deferred<void>();
      let calls = 0;
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'claude-sonnet-4-5',
        connectionSlug: 'claude-subscription',
        permissionMode: 'ask',
        terminal,
        recap: {
          generate: async () => {
            calls++;
            await gate.promise;
            return { ok: true, text: 'first recap result', raw: 'first recap result' };
          },
        },
      });

      terminal.input('/recap');
      terminal.input('\r');
      terminal.input('/recap');
      terminal.input('\r');

      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes('Recap already running.'),
      );
      assert.equal(
        calls,
        1,
        'the in-flight lock must be held synchronously so a second /recap racing before the first await sees it',
      );

      gate.resolve();
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes('Recap: first recap result'),
      );

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(CLOSE_BUDGET_MS).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });

    // PR #1182 review fix: a recap must be scoped to the session it started
    // for. /session, /new, and rewind never bump promptSeq (only submitted
    // prompts do), so the promptSeq staleness check alone cannot catch a
    // session switch — the fix compares sessionIds directly instead.
    test('a recap result is discarded when the active session switches away while generate() is in flight', async () => {
      const terminal = new FakeTerminal();
      const driver = new RewindDriver([{ turnId: 'turn-1', label: 'first prompt' }]);
      const gate = deferred<void>();
      let calls = 0;
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'claude-sonnet-4-5',
        connectionSlug: 'claude-subscription',
        permissionMode: 'ask',
        terminal,
        recap: {
          generate: async () => {
            calls++;
            await gate.promise;
            return { ok: true, text: 'session A recap', raw: 'session A recap' };
          },
        },
      });

      terminal.input('/recap');
      terminal.input('\r');
      await waitFor(() => calls === 1); // generate() is in flight for session-1

      // Switch the active session directly on the fake driver while
      // generate() is still pending — mirrors /session, /new, or a rewind
      // landing mid-recap.
      await driver.switchSession('session-2');

      gate.resolve();
      // Sentinel render: a wrongly-rendered recap would be in the cumulative
      // output by the time the typed char paints (the recap continuation
      // settles on microtasks before that render lands).
      terminal.input('z');
      await waitFor(() => editorInputText(terminal) === 'z');
      assert.equal(
        plainTerminalOutput(terminal.output()).includes('Recap:'),
        false,
        'a recap started in a session that has since been switched away from must be dropped silently',
      );

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(CLOSE_BUDGET_MS).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });

    // PR #1182 review fix: lastActivityAt must only refresh for a prompt that
    // actually opens a turn. Before the fix it refreshed at submitPrompt's
    // entry (ahead of the slash-command check), so a slash command typed on
    // the way back from idle (e.g. /help) would silently consume the idle
    // gap the next real prompt needed to trigger an auto-recap.
    test('a slash command submitted on the way back from idle does not consume the idle gap for the next real prompt', async (t) => {
      const terminal = new FakeTerminal();
      const driver = new RewindDriver([
        { turnId: 'turn-1', label: 'first' },
        { turnId: 'turn-2', label: 'second' },
        { turnId: 'turn-3', label: 'third' },
      ]);
      let calls = 0;
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'claude-sonnet-4-5',
        connectionSlug: 'claude-subscription',
        permissionMode: 'ask',
        terminal,
        recap: {
          generate: async () => {
            calls++;
            return { ok: true, text: 'recap after help', raw: 'recap after help' };
          },
        },
      });

      // Freeze/advance Date to simulate a qualifying idle gap, then submit a
      // slash command FIRST — it must not refresh lastActivityAt — followed
      // by a real prompt while the clock is still frozen at the same instant.
      // If /help had wrongly refreshed the idle clock, the real prompt's
      // idleMs would measure ~0 (both reads hit the same frozen Date) instead
      // of the full gap, and the auto-recap below would never fire.
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      t.mock.timers.tick(AUTO_RECAP_IDLE_MS + 1_000);

      terminal.input('/help');
      terminal.input('\r');
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('Commands'));

      terminal.input('a real prompt');
      terminal.input('\r');
      t.mock.timers.reset();

      await waitFor(() => driver.prompts.length === 1);
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes('Recap: recap after help'),
      );
      assert.equal(calls, 1);

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(CLOSE_BUDGET_MS).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });
  });

  describe('slash commands during a running turn', () => {
    test('/recap answers locally instead of steering into the model', async () => {
      const terminal = new FakeTerminal();
      const driver = new SteeringTurnDriver();
      driver.rewindTargets = [{ turnId: 'turn-1', label: 'first' }];
      let calls = 0;
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'm',
        connectionSlug: 'c',
        permissionMode: 'bypass',
        terminal,
        recap: {
          generate: async () => {
            calls += 1;
            return { ok: true, text: 'mid-turn recap', raw: 'mid-turn recap' };
          },
        },
      });

      terminal.input('start the work');
      terminal.input('\r');
      await waitFor(() => terminal.progressStates.at(-1) === true);

      // The recap uses the independent session.recap.generate call behind its
      // own in-flight lock, so it can answer while the turn is running;
      // steering "/recap" into the model would read as a confused instruction.
      terminal.input('/recap');
      terminal.input('\r');
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('Recap: mid-turn recap'));
      assert.equal(calls, 1);
      assert.deepEqual(driver.steered, []);

      terminal.input('\x1b');
      terminal.input('\x1b');
      await waitFor(() => terminal.progressStates.at(-1) === false);
      // Interrupt refills the editor with the cleared queue; clear it before /exit.
      terminal.input('\x03');
      terminal.input('/exit');
      terminal.input('\r');
      await run;
    });

    test('/resume refuses with a clear message instead of steering into the model', async () => {
      const terminal = new FakeTerminal();
      const driver = new SteeringTurnDriver();
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'm',
        connectionSlug: 'c',
        permissionMode: 'bypass',
        terminal,
      });

      terminal.input('start the work');
      terminal.input('\r');
      await waitFor(() => terminal.progressStates.at(-1) === true);

      // A safe-boundary resume mutates the session behind the turn's back; it
      // must be refused loudly, never steered into the model as "/resume".
      terminal.input('/resume');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes(
          'Cannot run /resume while a turn is running',
        ),
      );
      assert.deepEqual(driver.steered, []);

      terminal.input('\x1b');
      terminal.input('\x1b');
      await waitFor(() => terminal.progressStates.at(-1) === false);
      terminal.input('\x03');
      terminal.input('/exit');
      terminal.input('\r');
      await run;
    });

    test('/resume parked by the host is informational, not a red error', async () => {
      const terminal = new FakeTerminal();
      const driver = new SlashCommandDriver();
      driver.parkedResumeReason = 'resume_feature_disabled';
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'm',
        connectionSlug: 'c',
        permissionMode: 'bypass',
        terminal,
      });

      // Attach a session first so the driver actually has one to resume.
      terminal.input('/session');
      terminal.input('\r');
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('Resume Session'));
      terminal.input('\r');
      await waitFor(() => driver.sessionIds.length === 1);

      terminal.input('/resume');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes(
          'Safe-boundary resume is not enabled on this runtime',
        ),
      );
      assert.equal(driver.resumeCalls, 1);

      terminal.input('/exit');
      terminal.input('\r');
      await run;
    });

    test('/resume with no interrupted run explains there is nothing to resume', async () => {
      const terminal = new FakeTerminal();
      const driver = new SlashCommandDriver();
      driver.parkedResumeReason = 'resume_candidate_missing';
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'm',
        connectionSlug: 'c',
        permissionMode: 'bypass',
        terminal,
      });

      terminal.input('/session');
      terminal.input('\r');
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('Resume Session'));
      terminal.input('\r');
      await waitFor(() => driver.sessionIds.length === 1);

      terminal.input('/resume');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes(
          'Nothing to resume: no interrupted run exists in this session.',
        ),
      );

      terminal.input('/exit');
      terminal.input('\r');
      await run;
    });

    test('/resume keeps genuine parked recovery failures red', async () => {
      const terminal = new FakeTerminal();
      const driver = new SlashCommandDriver();
      driver.parkedResumeReason = 'safety_check_failed';
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'm',
        connectionSlug: 'c',
        permissionMode: 'bypass',
        terminal,
      });

      terminal.input('/session');
      terminal.input('\r');
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('Resume Session'));
      terminal.input('\r');
      await waitFor(() => driver.sessionIds.length === 1);

      terminal.input('/resume');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes(
          'Error: Safe-boundary resume parked: safety_check_failed',
        ),
      );

      terminal.input('/exit');
      terminal.input('\r');
      await run;
    });

    for (const reason of [
      'continuation_authority_unavailable',
      'safety_observation_unavailable',
    ] as const) {
      test(`/resume keeps ${reason} red`, async () => {
        const terminal = new FakeTerminal();
        const driver = new SlashCommandDriver();
        driver.parkedResumeReason = reason;
        const run = runMakaPiTui({
          title: 'Maka',
          driver,
          cwd: '/repo',
          model: 'm',
          connectionSlug: 'c',
          permissionMode: 'bypass',
          terminal,
        });

        terminal.input('/session');
        terminal.input('\r');
        await waitFor(() => plainTerminalOutput(terminal.output()).includes('Resume Session'));
        terminal.input('\r');
        await waitFor(() => driver.sessionIds.length === 1);

        terminal.input('/resume');
        terminal.input('\r');
        await waitFor(() =>
          plainTerminalOutput(terminal.output()).includes(
            `Error: Safe-boundary resume parked: ${reason}`,
          ),
        );

        terminal.input('/exit');
        terminal.input('\r');
        await run;
      });
    }
    test('/model refuses instead of opening the picker behind the running turn', async () => {
      const terminal = new FakeTerminal();
      const driver = new SteeringTurnDriver();
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'm',
        connectionSlug: 'c',
        permissionMode: 'bypass',
        terminal,
      });

      terminal.input('start the work');
      terminal.input('\r');
      await waitFor(() => terminal.progressStates.at(-1) === true);

      terminal.input('/model');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes(
          'Cannot run /model while a turn is running',
        ),
      );
      assert.deepEqual(driver.steered, []);

      terminal.input('\x1b');
      terminal.input('\x1b');
      await waitFor(() => terminal.progressStates.at(-1) === false);
      terminal.input('\x03');
      terminal.input('/exit');
      terminal.input('\r');
      await run;
    });

    test('/session <id> mid-turn detaches from the running Turn instead of refusing', async () => {
      const terminal = new FakeTerminal();
      const driver = new DetachingSwitchDriver([
        storedUserMessage('user-s2', 'turn-old-2', 'history from session two'),
        storedAssistantMessage('assistant-s2', 'turn-old-2', 'prior answer'),
      ]);
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'm',
        connectionSlug: 'c',
        permissionMode: 'bypass',
        terminal,
      });

      terminal.input('start the long task');
      terminal.input('\r');
      await waitFor(() => terminal.progressStates.at(-1) === true);

      // The escape hatch a second TUI needs (#3380): switching Sessions
      // mid-turn detaches the view and leaves the Host-owned Turn running,
      // instead of refusing (trapping the client) or stopping the Turn.
      terminal.input('/session session-2');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes('Detached from the running Turn'),
      );
      assert.equal(driver.stopCalls, 0);
      assert.deepEqual(driver.sessionIds, ['session-2']);
      // The adopted Session's history replaced the old transcript.
      assert.match(plainTerminalOutput(terminal.screenOutput()), /history from session two/);

      // Late events from the abandoned Turn never reach the adopted
      // transcript — neither as content nor as a synthesized failure about
      // the stream ending without a completion event.
      driver.emit({
        type: 'text_delta',
        id: 'delta-leak',
        turnId: 'turn-1',
        messageId: 'assistant-old',
        ts: 2,
        text: 'LEAK-OLD-DELTA',
      });
      driver.releaseOldTurn();
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('attached replay done'));
      const after = plainTerminalOutput(terminal.output());
      assert.doesNotMatch(after, /LEAK-OLD-DELTA/);
      assert.doesNotMatch(after, /without a completion event/);
      assert.equal(driver.stopCalls, 0);
      // The orphaned drain released the runner, and only then did the freshly
      // attached Turn of session-2 start and complete.
      await waitFor(() => terminal.progressStates.at(-1) === false);

      // A follow-up prompt lands on the adopted Session.
      terminal.input('next step');
      terminal.input('\r');
      await waitFor(() => driver.displayPrompts.includes('next step'));
      assert.deepEqual(driver.sessionIds, ['session-2']);

      terminal.input('/exit');
      terminal.input('\r');
      await run;
    });

    test('/session mid-turn opens the picker and Escape closes it without arming an interrupt', async () => {
      const terminal = new FakeTerminal();
      const driver = new DetachingSwitchDriver([]);
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'm',
        connectionSlug: 'c',
        permissionMode: 'bypass',
        terminal,
      });

      terminal.input('start the long task');
      terminal.input('\r');
      await waitFor(() => terminal.progressStates.at(-1) === true);

      terminal.input('/session');
      terminal.input('\r');
      await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Resume Session'));
      assert.doesNotMatch(
        plainTerminalOutput(terminal.output()),
        /Cannot run \/session while a turn is running/,
      );

      // Escape belongs to the overlay while it is open: closing it must not
      // arm the double-Escape interrupt — a second Escape would otherwise
      // abort the very Turn the user is navigating away from (#3380).
      terminal.input('\x1b');
      await waitFor(() => !plainTerminalOutput(terminal.screenOutput()).includes('Resume Session'));
      await delay(50);
      assert.equal(driver.stopCalls, 0);
      assert.equal(terminal.progressStates.at(-1), true);

      // Settle the parked Turn normally, then leave.
      driver.releaseOldTurn();
      await waitFor(() => terminal.progressStates.at(-1) === false);
      terminal.input('/exit');
      terminal.input('\r');
      await run;
    });

    test('a failed mid-turn /session leaves the running Turn fully live', async () => {
      const terminal = new FakeTerminal();
      const driver = new DetachingSwitchDriver([]);
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'm',
        connectionSlug: 'c',
        permissionMode: 'bypass',
        terminal,
      });

      terminal.input('start the long task');
      terminal.input('\r');
      await waitFor(() => terminal.progressStates.at(-1) === true);

      // A rejected switch must not orphan the in-flight drain: the error is
      // reported, nothing was switched, and the Turn keeps streaming into the
      // same transcript.
      driver.failNextSwitch = true;
      terminal.input('/session does-not-exist');
      terminal.input('\r');
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('session not found'));
      assert.equal(driver.stopCalls, 0);
      assert.equal(terminal.progressStates.at(-1), true);

      driver.emit({
        type: 'text_delta',
        id: 'delta-after-failure',
        turnId: 'turn-1',
        messageId: 'assistant-old',
        ts: 3,
        text: 'still streaming after failure',
      });
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes('still streaming after failure'),
      );

      driver.releaseOldTurn();
      await waitFor(() => terminal.progressStates.at(-1) === false);
      terminal.input('/exit');
      terminal.input('\r');
      await run;
    });

    test('a second mid-turn /session while a detach is in flight is ignored', async () => {
      const terminal = new FakeTerminal();
      const driver = new DetachingSwitchDriver([
        storedUserMessage('user-s2', 'turn-old-2', 'history from session two'),
        storedAssistantMessage('assistant-s2', 'turn-old-2', 'prior answer'),
      ]);
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'm',
        connectionSlug: 'c',
        permissionMode: 'bypass',
        terminal,
      });

      terminal.input('start the long task');
      terminal.input('\r');
      await waitFor(() => terminal.progressStates.at(-1) === true);

      // Park the first switch inside driver.switchSession, then fire a second
      // /session while `detaching` is still held: re-entry would clear the
      // flag early, reopen the interrupt window, and double-apply adoption.
      let releaseSwitch!: () => void;
      driver.holdSwitch = new Promise<void>((resolve) => {
        releaseSwitch = resolve;
      });
      terminal.input('/session session-2');
      terminal.input('\r');
      await waitFor(() => driver.switchEntries >= 1);
      terminal.input('/session session-2');
      terminal.input('\r');
      releaseSwitch();

      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes('Detached from the running Turn'),
      );
      assert.equal(driver.stopCalls, 0);
      assert.deepEqual(driver.sessionIds, ['session-2']);
      // Exactly one detach notice: the second switch never ran.
      const notices = plainTerminalOutput(terminal.output()).match(
        /Detached from the running Turn/g,
      );
      assert.equal(notices?.length, 1);

      driver.releaseOldTurn();
      await waitFor(() => terminal.progressStates.at(-1) === false);
      terminal.input('/exit');
      terminal.input('\r');
      await run;
    });

    test('a Turn that attaches after a mid-turn detach does not adopt abandoned metadata', async () => {
      const terminal = new FakeTerminal();
      const driver = new DetachingSwitchDriver([
        storedUserMessage('user-s2', 'turn-old-2', 'history from session two'),
        storedAssistantMessage('assistant-s2', 'turn-old-2', 'prior answer'),
      ]);
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'm',
        connectionSlug: 'c',
        permissionMode: 'bypass',
        terminal,
      });

      terminal.input('start the long task');
      terminal.input('\r');
      await waitFor(() => terminal.progressStates.at(-1) === true);

      terminal.input('/session session-2');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes('Detached from the running Turn'),
      );
      assert.match(plainTerminalOutput(terminal.screenOutput()), /history from session two/);

      driver.releaseOldTurn();
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('attached replay done'));
      await waitFor(() => terminal.progressStates.at(-1) === false);

      // The Host keeps running the abandoned Session's Turn and announces a
      // successor on it. That Turn belongs to a Session this client left, so
      // neither its transcript nor its metadata may reach the adopted view.
      driver.announceStartedTurn({
        sessionId: 'session-1',
        turnId: 'turn-abandoned',
        events: (async function* () {})(),
        messages: [storedUserMessage('user-abandoned', 'turn-abandoned', 'ABANDONED MESSAGE')],
        summary: fakeSessionSummary('session-1', '/abandoned-cwd', 'ABANDONED TITLE'),
      });
      await delay(0);
      assert.equal(terminal.titles.includes('ABANDONED TITLE (Maka)'), false);
      assert.equal(terminal.titles.at(-1), 'Existing chat (Maka)');
      assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /\/abandoned-cwd/);
      assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /ABANDONED MESSAGE/);

      terminal.input('/exit');
      terminal.input('\r');
      await run;
    });

    test('unknown slash-prefixed text still steers into the running turn', async () => {
      const terminal = new FakeTerminal();
      const driver = new SteeringTurnDriver();
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'm',
        connectionSlug: 'c',
        permissionMode: 'bypass',
        terminal,
      });

      terminal.input('start the work');
      terminal.input('\r');
      await waitFor(() => terminal.progressStates.at(-1) === true);

      // `/skill:<name>` is not a catalog command; mid-turn it stays prompt
      // text for the running turn, exactly like any other steered message.
      terminal.input('/skill:review');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.screenOutput()).includes('Steering: /skill:review'),
      );
      assert.deepEqual(driver.steered, ['/skill:review']);

      terminal.input('\x1b');
      terminal.input('\x1b');
      await waitFor(() => terminal.progressStates.at(-1) === false);
      terminal.input('\x03');
      terminal.input('/exit');
      terminal.input('\r');
      await run;
    });
  });

  describe('/goal command', () => {
    const armedGoal: GoalProjection = {
      goalId: 'goal-1',
      revision: 3,
      sessionId: 'session-1',
      condition: 'Ship the feature',
      status: 'active',
      setAt: Date.now() - 60_000,
      iterations: 2,
      maxIterations: 50,
      consecutiveNoProgress: 0,
      blockCap: 8,
      tokenBudget: 100_000,
      tokensSpent: 12_000,
      lastReason: 'tests still failing',
      achievedAt: null,
      pausedAt: null,
    };

    test('/goal prints the live goal summary and the status line carries the indicator', async () => {
      const terminal = new FakeTerminal();
      const driver = new SlashCommandDriver();
      driver.goal = armedGoal;
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'claude-sonnet-4-5',
        connectionSlug: 'claude-subscription',
        permissionMode: 'ask',
        terminal,
      });

      // The startup read must pick the goal up before any turn runs, and the
      // status line must show the loop while it burns tokens.
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('goal 2/50'));

      terminal.input('/goal');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes('Goal: Ship the feature'),
      );
      const output = plainTerminalOutput(terminal.output());
      assert.match(output, /Status: active · 2\/50 iterations/);
      assert.match(output, /Tokens: 12k \/ 100k/);
      assert.match(output, /Last evaluator note: tests still failing/);
      // No model turn was burned to answer a status question.
      assert.equal(driver.prompts.length, 0);

      // A host-pushed transition (e.g. the abort auto-pause after Ctrl+C)
      // reaches the status line without any user action.
      driver.pushGoal({
        ...armedGoal,
        status: 'paused',
        revision: 4,
        pausedAt: Date.now(),
      });
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('goal paused 2/50'));

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(CLOSE_BUDGET_MS).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });

    test('/goal during a running turn answers locally instead of steering into the model', async () => {
      const terminal = new FakeTerminal();
      const driver = new SteeringTurnDriver();
      driver.goal = armedGoal;
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'm',
        connectionSlug: 'c',
        permissionMode: 'bypass',
        terminal,
      });

      terminal.input('start the work');
      terminal.input('\r');
      await waitFor(() => terminal.progressStates.at(-1) === true);

      // The primary use case: inspect the loop while it is burning tokens.
      // Steering "/goal" into the model would confuse it and spend a turn on
      // a status question.
      terminal.input('/goal');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes('Goal: Ship the feature'),
      );
      assert.deepEqual(driver.steered, []);

      terminal.input('\x1b');
      terminal.input('\x1b');
      await waitFor(() => terminal.progressStates.at(-1) === false);
      // Interrupt refills the editor with the cleared queue; clear it before /exit.
      terminal.input('\x03');
      terminal.input('/exit');
      terminal.input('\r');
      await run;
    });

    test('/goal pause during a running turn refuses with a clear message instead of steering', async () => {
      const terminal = new FakeTerminal();
      const driver = new SteeringTurnDriver();
      driver.goal = armedGoal;
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'm',
        connectionSlug: 'c',
        permissionMode: 'bypass',
        terminal,
      });

      terminal.input('start the work');
      terminal.input('\r');
      await waitFor(() => terminal.progressStates.at(-1) === true);

      terminal.input('/goal pause');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes(
          'Cannot control the goal while a turn or another action is running',
        ),
      );
      // Neither steered into the model nor applied behind the turn's back.
      assert.deepEqual(driver.steered, []);

      terminal.input('\x1b');
      terminal.input('\x1b');
      await waitFor(() => terminal.progressStates.at(-1) === false);
      terminal.input('\x03');
      terminal.input('/exit');
      terminal.input('\r');
      await run;
    });

    test('/goal pause|resume|clear control the loop and print confirmations', async () => {
      const terminal = new FakeTerminal(160, 24);
      const driver = new SlashCommandDriver();
      driver.goal = armedGoal;
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'claude-sonnet-4-5',
        connectionSlug: 'claude-subscription',
        permissionMode: 'ask',
        terminal,
      });

      // Attaching to a session whose goal is running announces the loop —
      // recovery never resumes a token-burning loop silently.
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes('Autonomous goal is running (2/50)'),
      );

      terminal.input('/goal pause');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes('Goal paused. /goal resume continues it'),
      );
      assert.deepEqual(driver.controlledGoalActions, ['pause']);
      // The self-initiated pause must not also print the auto-pause notice,
      // and the status line followed the pushed projection.
      assert.equal(plainTerminalOutput(terminal.output()).includes('Goal paused (2/50)'), false);
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('goal paused 2/50'));

      terminal.input('/goal resume');
      terminal.input('\r');
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('Goal resumed.'));

      terminal.input('/goal clear');
      terminal.input('\r');
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('Goal cleared.'));
      assert.deepEqual(driver.controlledGoalActions, ['pause', 'resume', 'clear']);
      // A cleared goal is terminal: the status-line segment disappears from
      // the live screen (scrollback keeps earlier frames).
      await waitFor(() => !plainTerminalOutput(terminal.screenOutput()).includes('goal 2/50'));

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(CLOSE_BUDGET_MS).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });

    test('a host-pushed pause announces itself with resume/clear guidance', async () => {
      const terminal = new FakeTerminal(160, 24);
      const driver = new SlashCommandDriver();
      driver.goal = armedGoal;
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'claude-sonnet-4-5',
        connectionSlug: 'claude-subscription',
        permissionMode: 'ask',
        terminal,
      });
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('goal 2/50'));

      // Ctrl+C on a goal continuation turn aborts it and the runtime
      // auto-pauses the goal; the pushed projection must surface that.
      driver.pushGoal({
        ...armedGoal,
        status: 'paused',
        revision: 4,
        pausedAt: Date.now(),
        lastReason: 'Goal-associated turn was aborted.',
      });
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes(
          'Goal paused (2/50). Goal-associated turn was aborted. /goal resume continues it, /goal clear stops it.',
        ),
      );

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(CLOSE_BUDGET_MS).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });

    test('a settled /goal pause does not suppress a later host-initiated pause notice', async () => {
      const terminal = new FakeTerminal(160, 24);
      const driver = new SlashCommandDriver();
      driver.goal = armedGoal;
      // The host can answer the control RPC before the subscription push folds
      // the transition; the suppression flag must settle with the command
      // instead of lingering for the push handler.
      driver.deferGoalControlPush = true;
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'claude-sonnet-4-5',
        connectionSlug: 'claude-subscription',
        permissionMode: 'ask',
        terminal,
      });
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('goal 2/50'));

      terminal.input('/goal pause');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes('Goal paused. /goal resume continues it'),
      );

      // The trailing push of the command's own pause folds onto the settled
      // projection: no duplicate auto-pause notice.
      driver.pushGoal({ ...armedGoal, status: 'paused', revision: 4, pausedAt: Date.now() });
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('goal paused 2/50'));
      assert.equal(plainTerminalOutput(terminal.output()).includes('Goal paused (2/50).'), false);

      terminal.input('/goal resume');
      terminal.input('\r');
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('Goal resumed.'));

      // A later host-initiated pause of the same goal (e.g. the Ctrl+C
      // auto-pause) must announce itself.
      driver.pushGoal({
        ...armedGoal,
        status: 'paused',
        revision: 6,
        pausedAt: Date.now(),
        lastReason: 'Goal-associated turn was aborted.',
      });
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes(
          'Goal paused (2/50). Goal-associated turn was aborted.',
        ),
      );

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(CLOSE_BUDGET_MS).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });

    test('resuming into a session with a live goal announces the auto-continuing loop', async () => {
      const terminal = new FakeTerminal(160, 24);
      const driver = new SlashCommandDriver([fakeSessionSummary('session-2', '/repo')]);
      // Before the switch, the driver has no attached session — the init-time
      // check sees nothing; the notice must come from the switch seam.
      driver.goal = null;
      driver.goalsBySessionId.set('session-2', armedGoal);
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'claude-sonnet-4-5',
        connectionSlug: 'claude-subscription',
        permissionMode: 'ask',
        terminal,
        resumeSessionId: 'session-2',
      });

      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes('Autonomous goal is running (2/50)'),
      );

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(CLOSE_BUDGET_MS).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });

    test('/goal control pre-validates impossible transitions', async () => {
      const terminal = new FakeTerminal();
      const driver = new SlashCommandDriver();
      driver.goal = armedGoal;
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'claude-sonnet-4-5',
        connectionSlug: 'claude-subscription',
        permissionMode: 'ask',
        terminal,
      });
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('goal 2/50'));

      terminal.input('/goal resume');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes('Cannot resume: the goal is active.'),
      );
      assert.deepEqual(driver.controlledGoalActions, []);

      // The host's transition rules are mirrored client-side: pause requires
      // active|waiting, clear rejects a terminal record.
      driver.pushGoal({ ...armedGoal, status: 'paused', revision: 4, pausedAt: Date.now() });
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('goal paused 2/50'));
      terminal.input('/goal pause');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes('Cannot pause: the goal is paused.'),
      );

      driver.pushGoal({ ...armedGoal, status: 'cleared', revision: 5 });
      terminal.input('/goal clear');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes('Cannot clear: the goal is cleared.'),
      );
      assert.deepEqual(driver.controlledGoalActions, []);

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(CLOSE_BUDGET_MS).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });

    test('/goal with no goal armed says so, and a bad subcommand shows usage', async () => {
      const terminal = new FakeTerminal();
      const driver = new SlashCommandDriver();
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'claude-sonnet-4-5',
        connectionSlug: 'claude-subscription',
        permissionMode: 'ask',
        terminal,
      });

      terminal.input('/goal');
      terminal.input('\r');
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('No goal set.'));

      terminal.input('/goal later');
      terminal.input('\r');
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('Usage: /goal'));

      terminal.input('/goal pause');
      terminal.input('\r');
      await waitFor(
        () => plainTerminalOutput(terminal.output()).split('No goal set.').length - 1 === 2,
      );
      assert.deepEqual(driver.controlledGoalActions, []);

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(CLOSE_BUDGET_MS).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });
  });

  test('"quit now" and "请 exit" are sent as ordinary prompts, not the exit word', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('quit now');
    terminal.input('\r');
    await waitFor(() => driver.prompts.length === 1);
    assert.equal(driver.prompts[0], 'quit now');

    terminal.input('请 exit');
    terminal.input('\r');
    await waitFor(() => driver.prompts.length === 2);
    assert.equal(driver.prompts[1], '请 exit');

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('/side submits in a temporary Session and one empty Ctrl-C closes it', async () => {
    const terminal = new FakeTerminal();
    const driver = new SideConversationDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/side explain this choice');
    terminal.input('\r');
    await waitFor(() => driver.prompts.length === 1);

    assert.deepEqual(driver.openedFrom, ['session-1']);
    assert.deepEqual(driver.promptSessionIds, ['side-1']);
    assert.deepEqual(driver.prompts, ['explain this choice']);

    await waitFor(() => terminal.progressStates.at(-1) === false);
    terminal.input('\x03');
    await waitFor(() => driver.closedSides.length === 1);
    assert.deepEqual(driver.closedSides, [
      { sideSessionId: 'side-1', parentSessionId: 'session-1' },
    ]);
    assert.equal(driver.getSessionId(), 'session-1');

    terminal.input('continue main');
    terminal.input('\r');
    await waitFor(() => driver.prompts.length === 2);
    assert.deepEqual(driver.promptSessionIds, ['side-1', 'session-1']);

    exitMaka(terminal);
    await run;
  });

  test('/side detaches from a running parent Turn without stopping it', async () => {
    const terminal = new FakeTerminal();
    const driver = new RunningParentSideConversationDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('main work');
    terminal.input('\r');
    await driver.parentStarted.promise;
    terminal.input('/side inspect while main runs');
    terminal.input('\r');
    await waitFor(() => driver.prompts.length === 2);

    assert.deepEqual(driver.prompts, ['main work', 'inspect while main runs']);
    assert.deepEqual(driver.promptSessionIds, ['session-1', 'side-1']);
    assert.equal(driver.stopCalls, 0);

    await waitFor(() => terminal.progressStates.at(-1) === false);
    terminal.input('\x03');
    await waitFor(() => driver.closedSides.length === 1);
    exitMaka(terminal);
    await run;
  });

  test('one empty Ctrl-C interrupts and closes a running side conversation', async () => {
    const terminal = new FakeTerminal();
    const driver = new RunningSideConversationDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/side keep checking');
    terminal.input('\r');
    await driver.sideStarted.promise;
    terminal.input('\x03');

    await waitFor(() => driver.closedSides.length === 1);
    assert.equal(driver.stopCalls, 1);
    assert.equal(driver.getSessionId(), 'session-1');

    exitMaka(terminal);
    await run;
  });

  test('preserves legacy editor undo before a side conversation exists', async () => {
    const terminal = new FakeTerminal();
    const driver = new SideConversationDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    try {
      terminal.input('draft');
      await waitFor(() => editorInputText(terminal) === 'draft');
      terminal.input('\x1f');
      await waitFor(() => editorInputText(terminal) === '');
      assert.equal(driver.getSessionId(), 'session-1');
    } finally {
      exitMaka(terminal);
      await run;
    }
  });

  test('Ctrl+/ toggles side views, preserves drafts, and projects parent status in English', async () => {
    const terminal = new FakeTerminal();
    const driver = new SideConversationDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      locale: 'zh',
      terminal,
    });

    terminal.input('/side');
    terminal.input('\r');
    await waitFor(() => driver.getSessionId() === 'side-1');
    terminal.input('side draft');
    terminal.input('\x1f');
    await waitFor(() => driver.getSessionId() === 'session-1');
    assert.equal(editorInputText(terminal), '');

    terminal.input('parent draft');
    terminal.input('\x1b[47;5u');
    await waitFor(() => driver.getSessionId() === 'side-1');
    assert.equal(editorInputText(terminal), 'side draft');

    driver.publishParentStatus('needs_approval');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes(
        'Side from main thread · main needs approval · Ctrl+/ to switch · Ctrl+C to close',
      ),
    );

    exitMaka(terminal);
    await run;
  });

  test('closing an empty side conversation restores the retained parent draft', async () => {
    const terminal = new FakeTerminal();
    const driver = new SideConversationDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/side');
    terminal.input('\r');
    await waitFor(() => driver.getSessionId() === 'side-1');
    terminal.input('\x1f');
    await waitFor(() => driver.getSessionId() === 'session-1');
    terminal.input('parent draft');
    terminal.input('\x1f');
    await waitFor(() => driver.getSessionId() === 'side-1');
    assert.equal(editorInputText(terminal), '');

    terminal.input('\x03');
    await waitFor(() => editorInputText(terminal) === 'parent draft');
    assert.equal(driver.getSessionId(), 'session-1');

    exitMaka(terminal);
    await run;
  });

  test('does not report main closed when the parent observer cannot open', async () => {
    const terminal = new FakeTerminal();
    const driver = new FailingParentObserverSideConversationDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/side');
    terminal.input('\r');
    await waitFor(() => driver.getSessionId() === 'side-1');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes(
        'Side from main thread · Ctrl+/ to switch · Ctrl+C to close',
      ),
    );
    assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /main closed/u);

    exitMaka(terminal);
    await run;
  });

  test('Ctrl+/ detaches from a running side Turn without stopping it', async () => {
    const terminal = new FakeTerminal();
    const driver = new RunningSideConversationDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/side keep checking');
    terminal.input('\r');
    await driver.sideStarted.promise;
    terminal.input('\x1f');
    await waitFor(() => driver.getSessionId() === 'session-1');

    assert.equal(driver.stopCalls, 0);
    exitMaka(terminal);
    await run;
  });

  test('/session outside the pair discards its retained side conversation', async () => {
    const terminal = new FakeTerminal();
    const driver = new SideConversationDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/side');
    terminal.input('\r');
    await waitFor(() => driver.getSessionId() === 'side-1');
    terminal.input('\x1f');
    await waitFor(() => driver.getSessionId() === 'session-1');
    terminal.input('/session session-2');
    terminal.input('\r');
    await waitFor(() => driver.discardedSides.length === 1);

    assert.deepEqual(driver.discardedSides, ['side-1']);
    assert.equal(driver.getSessionId(), 'session-2');

    exitMaka(terminal);
    await run;
  });

  test('relocates a moved session before resuming it at startup', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver([
      fakeSessionSummary('session-2', '/repo/old', 'Moved chat'),
    ]);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo/current-shell',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      resumeSessionId: 'session-2',
      resumeCwd: '../new-worktree',
    });

    await waitFor(() => driver.sessionIds.length === 1);

    assert.deepEqual(driver.sessionSwitchOptions, [{ relocateCwd: '../new-worktree' }]);

    exitMaka(terminal);
    await run;
  });

  test('tells a legacy Session exactly how to choose an account', async () => {
    const terminal = new FakeTerminal(160, 24);
    const { llmConnectionId: _legacyConnectionId, ...legacy } = fakeSessionSummary('session-2');
    const driver = new SlashCommandDriver([legacy]);
    const run = runMakaPiTui({
      title: 'Maka',
      locale: 'en',
      driver,
      cwd: '/repo',
      model: legacy.model,
      connectionSlug: legacy.llmConnectionSlug,
      connectionIdentities: [
        { connectionId: 'connection-openrouter', connectionSlug: 'openrouter', enabled: true },
      ],
      modelChoices: [
        {
          connectionId: 'connection-openrouter',
          connectionSlug: 'openrouter',
          connectionName: 'OpenRouter',
          providerType: 'openrouter',
          model: legacy.model,
          isDefaultConnection: true,
        },
      ],
      permissionMode: 'ask',
      terminal,
      resumeSessionId: legacy.id,
    });

    await waitFor(() => driver.sessionIds.length === 1);
    await waitForTuiPaint(terminal);
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('one-time account confirmation'),
    );
    const output = plainTerminalOutput(terminal.screenOutput());
    assert.match(output, /one-time account confirmation/);
    assert.match(output, /Run \/model/);
    assert.match(output, /run \/setup for API-key connections/);

    exitMaka(terminal);
    await run;
  });

  test('reports a deleted original account and recovers only through an exact model pick', async () => {
    const terminal = new FakeTerminal();
    const deleted = {
      ...fakeSessionSummary('session-2'),
      llmConnectionId: 'connection-a',
      llmConnectionSlug: 'shared',
      model: 'shared-model',
    };
    const driver = new SlashCommandDriver([deleted]);
    const run = runMakaPiTui({
      title: 'Maka',
      locale: 'en',
      driver,
      cwd: '/repo',
      model: deleted.model,
      connectionId: deleted.llmConnectionId,
      connectionSlug: deleted.llmConnectionSlug,
      connectionIdentities: [
        { connectionId: 'connection-b', connectionSlug: 'shared', enabled: true },
      ],
      modelChoices: [
        {
          connectionId: 'connection-b',
          connectionSlug: 'shared',
          connectionName: 'Replacement',
          providerType: 'openai',
          model: 'shared-model',
          isDefaultConnection: true,
        },
      ],
      permissionMode: 'ask',
      terminal,
      resumeSessionId: deleted.id,
    });

    await waitFor(() => driver.sessionIds.length === 1);
    await waitForTuiPaint(terminal);
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('The original account was deleted'),
    );
    const recoveryNotice = plainTerminalOutput(terminal.screenOutput());
    assert.match(recoveryNotice, /Run \/model/);
    assert.match(recoveryNotice, /run \/setup for API-key connections/);
    terminal.input('/model');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Replacement'));
    assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /Replacement · current/);
    terminal.input('\r');
    await waitFor(() => driver.modelConnectionIds.length === 1);
    assert.deepEqual(driver.modelConnectionIds, ['connection-b']);

    exitMaka(terminal);
    await run;
  });

  test('refreshes connection identities after setup before adopting the new model', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    driver.hostSummary = {
      llmConnectionId: 'connection-b',
      llmConnectionSlug: 'new-account',
      model: 'gpt-5.5',
    };
    const newConnectionChoice: ModelChoice = {
      connectionId: 'connection-b',
      connectionSlug: 'new-account',
      connectionName: 'New account',
      providerType: 'openai',
      model: 'gpt-5.5',
      isDefaultConnection: true,
    };
    const saveCalls: OnboardingSaveInput[] = [];
    const run = runMakaPiTui({
      title: 'Maka',
      locale: 'en',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionId: 'connection-a',
      connectionSlug: 'existing-account',
      providerType: 'anthropic',
      connectionIdentities: [
        { connectionId: 'connection-a', connectionSlug: 'existing-account', enabled: true },
      ],
      modelChoices: [
        {
          connectionId: 'connection-a',
          connectionSlug: 'existing-account',
          connectionName: 'Existing account',
          providerType: 'anthropic',
          model: 'claude-sonnet-4-5',
          isDefaultConnection: true,
        },
      ],
      permissionMode: 'ask',
      terminal,
      onboarding: fakeOnboardingSurface({
        verify: async () => ({ kind: 'ok', models: [{ id: 'gpt-5.5' }] }),
        save: async (input) => {
          saveCalls.push(input);
          const refresh = {
            kind: 'ok' as const,
            modelChoices: [newConnectionChoice],
            connectionIdentities: [
              { connectionId: 'connection-a', connectionSlug: 'existing-account', enabled: true },
              { connectionId: 'connection-b', connectionSlug: 'new-account', enabled: true },
            ],
          };
          return {
            kind: 'ok' as const,
            connection: {
              connectionId: 'connection-b',
              revision: 1,
              slug: 'new-account',
              providerType: 'openai' as const,
            },
            refresh,
          };
        },
      }),
    });

    await waitForTuiPaint(terminal);
    terminal.input('/setup');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Set Up Provider'));
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('API key'));
    terminal.input('sk-test');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('3/3'));
    terminal.input(' ');
    terminal.input('\r');
    await waitFor(() => saveCalls.length === 1);
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Models enabled'));
    terminal.input('\r');
    await waitFor(() => !plainTerminalOutput(terminal.screenOutput()).includes('Models enabled'));

    terminal.input('/model');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('New account'));
    terminal.input('\r');
    await waitFor(() => driver.modelConnectionIds.length === 1);
    assert.deepEqual(driver.modelConnectionIds, ['connection-b']);

    terminal.input('hello');
    terminal.input('\r');
    await waitFor(() => driver.prompts.length === 1 && driver.streamPulls === 1);
    await waitForTuiPaint(terminal);
    assert.doesNotMatch(
      plainTerminalOutput(terminal.screenOutput()),
      /The original account was deleted/,
    );

    exitMaka(terminal);
    await run;
  });

  test('resumes an active Host turn from its atomic transcript and continues live output', async () => {
    const terminal = new FakeTerminal();
    const driver = new ActiveResumeDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      resumeSessionId: 'session-2',
    });

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Hello world'));
    await waitFor(() => terminal.progressStates.at(-1) === false);
    assert.deepEqual(driver.prompts, []);

    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('adopts a Host-started successor after the visible turn reaches its boundary', async () => {
    const terminal = new FakeTerminal();
    const driver = new HostSuccessorDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      listShellRunUpdates: (sessionId) => driver.listShellRunUpdates(sessionId),
    });

    terminal.input('first');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);
    driver.publishSuccessor();
    driver.probeFirstTurn();
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('First still active'));
    assert.equal(driver.successorPulls, 0);
    assert.equal(plainTerminalOutput(terminal.output()).includes('Second answer'), false);

    driver.finishFirstTurn();
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Second answer'));
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('(4s · 2 lines)'));
    await waitFor(() => terminal.progressStates.at(-1) === false);
    assert.deepEqual(driver.prompts, ['first']);
    // Every attached Turn hydrates background ShellRun state, the visible one
    // this client submitted included.
    assert.deepEqual(driver.shellRunReads, ['session-1', 'session-1']);

    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('reports a resume failure and continues with the fresh session', async () => {
    const terminal = new FakeTerminal();
    const driver = new FailingSwitchSessionDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      resumeSessionId: 'missing-session',
    });

    await waitFor(() =>
      plainTerminalOutput(terminal.output()).includes('Could not resume session missing-session'),
    );
    // The notice line-wraps at the terminal width, so normalize whitespace
    // before matching instead of asserting on a single unbroken line.
    const normalized = plainTerminalOutput(terminal.output()).replace(/\s+/g, ' ');
    assert.match(
      normalized,
      /Could not resume session missing-session: session not found\. Starting fresh\./,
    );

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('exits when the selected execution location cannot safely start fresh', async () => {
    const terminal = new FakeTerminal();
    const driver = new FailingSwitchSessionDriver();
    const exits: Array<{ code: number; error?: Error }> = [];

    await runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/client-only',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      resumeSessionId: 'remote-session',
      resumeFailure: 'exit',
      onProcessExit: (code, error) => exits.push({ code, ...(error ? { error } : {}) }),
    });
    process.exitCode = undefined;

    assert.equal(exits[0]?.code, 1);
    assert.match(exits[0]?.error?.message ?? '', /Could not resume session remote-session/);
  });
});

function editorInputText(terminal: FakeTerminal): string | undefined {
  const lines = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
  const inputRows = findInputSurfaceRows(lines);
  if (!inputRows) return undefined;
  const [topEditorBorderIndex, bottomEditorBorderIndex] = inputRows;
  return lines
    .slice(topEditorBorderIndex + 1, bottomEditorBorderIndex)
    .join('\n')
    .trim();
}

/** Like waitFor, but with a caller-chosen deadline for slower convergence. */
async function waitForUpTo(predicate: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  assert.equal(predicate(), true);
}

function exitMaka(_terminal: FakeTerminal): void {
  const previousExitCode = process.exitCode;
  process.emit('SIGTERM');
  process.exitCode = previousExitCode;
}

class ThrowingFocusReportTerminal extends FakeTerminal {
  override write(data: string): void {
    if (data === '\x1b[?1004h') throw new Error('focus reporting failed');
    super.write(data);
  }
}

/**
 * The parts of `MakaSessionDriver` every fake in this file answers the same
 * way. A driver here exists to vary one behaviour; without a shared base each
 * of them restates the whole interface, and a change to it has to be made a
 * dozen times over.
 *
 * Subclasses supply what a Turn is made of — `preparePrompt` and the event
 * stream it hands back — and override only the members their scenario bends.
 */
abstract class FakeSessionDriver implements MakaSessionDriver {
  startedTurnListener: ((turn: MakaAttachedSessionTurn) => void) | undefined;
  hostSummary: Partial<SessionSummary> = {};
  protected sessionId = 'session-1';

  abstract preparePrompt(
    prompt: string,
    options?: MakaPreparePromptOptions,
  ): Promise<MakaPreparedSessionTurn>;

  abstract promptEvents(prompt: string, turnId?: string): AsyncIterable<SessionEvent>;

  submitMessage(
    text: string,
    options: MakaSubmitMessageOptions,
  ): Promise<TurnMessageSubmitResult | undefined> {
    return admitMessageAsTurn(this, text, options);
  }

  subscribeStartedTurns(listener: (turn: MakaAttachedSessionTurn) => void): () => void {
    this.startedTurnListener = listener;
    return () => {
      if (this.startedTurnListener === listener) this.startedTurnListener = undefined;
    };
  }

  async queryCancelledMessages(): Promise<{ cancelledMessageIds: string[] }> {
    return { cancelledMessageIds: [] };
  }

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async *compactSession(): AsyncIterable<SessionEvent> {}

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_response: SandboxBoundaryResponse): Promise<void> {}
  async renameSession(_name: string): Promise<string | void> {}
  async setModel(_model: string, _connectionSlug?: string, _connectionId?: string): Promise<void> {}
  async setPermissionMode(_mode: PermissionMode): Promise<void> {}
  async setThinkingLevel(_level: ThinkingLevel | undefined): Promise<void> {}

  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    return switchResult(fakeSessionSummary(sessionId));
  }

  async listRewindTargets(): Promise<RewindTarget[]> {
    return [];
  }

  async rewindToTurn(_turnId: string): Promise<MakaSessionRewindResult> {
    throw new Error('rewind not supported in this fake');
  }

  startNewSession(): Promise<void> {
    return Promise.resolve();
  }

  getSessionId(): string | null {
    return this.sessionId;
  }
}

class RejectingStopDriver extends FakeSessionDriver {
  submitMessage(
    text: string,
    options: MakaSubmitMessageOptions,
  ): Promise<TurnMessageSubmitResult | undefined> {
    return admitMessageAsTurn(this, text, options);
  }

  subscribeStartedTurns(listener: (turn: MakaAttachedSessionTurn) => void): () => void {
    this.startedTurnListener = listener;
    return () => {
      if (this.startedTurnListener === listener) this.startedTurnListener = undefined;
    };
  }

  async queryCancelledMessages(): Promise<{ cancelledMessageIds: string[] }> {
    return { cancelledMessageIds: [] };
  }

  stopCalls = 0;

  preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    return prepareTestPrompt(this, prompt);
  }

  async *promptEvents(_prompt: string): AsyncIterable<never> {}

  async stop(): Promise<void> {
    this.stopCalls += 1;
    throw new Error('stop failed');
  }
}

class SandboxBoundaryPromptDriver extends FakeSessionDriver {
  readonly boundaryResponses: SandboxBoundaryResponse[] = [];
  boundaryRequests = 0;
  stopCalls = 0;
  private boundaryResponseWaiter: (() => void) | null = null;

  constructor(
    private readonly paths: readonly string[] = ['/outside'],
    private readonly beforeBoundaryAck: (index: number) => Promise<void> = async () => {},
    private readonly beforeBoundaryRequest: (index: number) => Promise<void> = async () => {},
  ) {
    super();
  }

  preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    return prepareTestPrompt(this, prompt);
  }

  async *promptEvents(_prompt: string): AsyncIterable<SessionEvent> {
    for (const [index, path] of this.paths.entries()) {
      await this.beforeBoundaryRequest(index);
      this.boundaryRequests += 1;
      yield {
        type: 'sandbox_boundary_request',
        id: `event-boundary-${index + 1}`,
        turnId: 'turn-1',
        ts: index + 1,
        requestId: `boundary-${index + 1}`,
        toolUseId: `tool-${index + 1}`,
        justification: `Read ${path}.`,
        expansion: {
          filesystem: {
            entries: [{ path, access: 'read', scope: 'exact' }],
          },
        },
      };
    }
    for (const index of this.paths.keys()) {
      while (this.boundaryResponses.length <= index) {
        await new Promise<void>((resolve) => {
          this.boundaryResponseWaiter = resolve;
        });
      }
      const response = this.boundaryResponses[index]!;
      await this.beforeBoundaryAck(index);
      yield {
        type: 'sandbox_boundary_decision_ack',
        id: `event-boundary-decision-${index + 1}`,
        turnId: 'turn-1',
        ts: this.paths.length + index + 1,
        requestId: response.requestId,
        toolUseId: `tool-${index + 1}`,
        decision: response.decision,
        status: response.decision === 'allow' ? 'approved' : 'denied',
        revision: response.decision === 'allow' ? index + 1 : index,
      };
    }
    yield {
      type: 'complete',
      id: 'event-complete',
      turnId: 'turn-1',
      ts: this.paths.length * 2 + 1,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  async respondToSandboxBoundary(response: SandboxBoundaryResponse): Promise<void> {
    this.boundaryResponses.push(response);
    const waiter = this.boundaryResponseWaiter;
    this.boundaryResponseWaiter = null;
    waiter?.();
  }
  async renameSession(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setThinkingLevel(): Promise<void> {}
  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    return switchResult(fakeSessionSummary(sessionId));
  }

  async listRewindTargets(): Promise<RewindTarget[]> {
    return [];
  }
  async rewindToTurn(): Promise<MakaSessionRewindResult> {
    throw new Error('rewind not supported in this fake');
  }
  startNewSession(): Promise<void> {
    return Promise.resolve();
  }
  getSessionId(): string {
    return 'session-1';
  }
}

class UserQuestionPromptDriver extends FakeSessionDriver {
  readonly responses: UserQuestionResponse[] = [];
  stopCalls = 0;
  private release: (() => void) | undefined;

  preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    return prepareTestPrompt(this, prompt);
  }
  async *promptEvents(_prompt: string): AsyncIterable<SessionEvent> {
    yield {
      type: 'user_question_request',
      id: 'event-question',
      turnId: 'turn-1',
      ts: 1,
      requestId: 'question-1',
      toolUseId: 'tool-1',
      questions: [
        {
          question: 'Choose an approach',
          options: [{ label: 'Extend', description: 'Reuse the seam' }, { label: 'Separate' }],
        },
        { question: 'Keep the default', options: [{ label: 'Yes' }, { label: 'No' }] },
        { question: 'Anything else', options: [{ label: 'Nothing' }, { label: 'More detail' }] },
      ],
    };
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    yield { type: 'complete', id: 'complete-1', turnId: 'turn-1', ts: 2, stopReason: 'end_turn' };
  }
  async respondToUserQuestion(response: UserQuestionResponse): Promise<void> {
    this.responses.push(response);
    this.release?.();
  }
  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.release?.();
  }
  async rewindToTurn(): Promise<MakaSessionRewindResult> {
    throw new Error('rewind not supported');
  }
  startNewSession(): Promise<void> {
    return Promise.resolve();
  }
  getSessionId(): string {
    return 'session-1';
  }
}

class InterruptibleTurnDriver extends FakeSessionDriver {
  stopCalls = 0;
  readonly prompts: string[] = [];
  private releaseTurn: (() => void) | null = null;

  preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    this.prompts.push(prompt);
    return prepareTestPrompt(this, prompt);
  }

  /** Bumped when the drain first pulls the Turn's stream. */
  streamPulls = 0;

  async *promptEvents(_prompt: string): AsyncIterable<SessionEvent> {
    this.streamPulls += 1;
    // The turn parks like a real long-running provider call until stop() aborts it.
    await new Promise<void>((resolve) => {
      this.releaseTurn = resolve;
    });
    yield {
      type: 'abort',
      id: 'event-abort',
      turnId: 'turn-1',
      ts: 1,
      reason: 'user_stop',
    };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.releaseTurn?.();
    this.releaseTurn = null;
  }

  async respondToSandboxBoundary(_response: SandboxBoundaryResponse): Promise<void> {}
  async renameSession(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setThinkingLevel(): Promise<void> {}
  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    return switchResult(fakeSessionSummary(sessionId));
  }

  async listRewindTargets(): Promise<RewindTarget[]> {
    return [];
  }
  async rewindToTurn(): Promise<MakaSessionRewindResult> {
    throw new Error('rewind not supported in this fake');
  }
  startNewSession(): Promise<void> {
    return Promise.resolve();
  }
  getSessionId(): string {
    return 'session-1';
  }
}

// A parking turn plus an in-memory steering/followup mirror, so the runner's
// keybindings (Enter steer, Alt+Enter queue, Alt+↑ retract, Esc Esc refill) can
// be exercised end-to-end without a real runtime.
class SteeringTurnDriver extends FakeSessionDriver {
  stopCalls = 0;
  goal: GoalProjection | null = null;
  readonly steered: string[] = [];
  readonly queuedMessages: string[] = [];
  readonly turnOrchestrations: Array<MakaPreparePromptOptions['turnOrchestration']> = [];
  nextSubmitError: Error | undefined;
  submitGate: Promise<void> | undefined;
  startedTurnMessages: StoredMessage[] = [];
  hostSummary: Partial<SessionSummary> = {};
  retractCalls = 0;
  rewindTargets: RewindTarget[] = [];
  private steering: Array<{ messageId: string; text: string }> = [];
  private followup: Array<{ messageId: string; text: string }> = [];
  private pendingEvents: SessionEvent[] = [];
  private wakeTurn: (() => void) | null = null;
  private turnOpen = false;
  private turnEnded = false;
  private eventSeq = 0;

  preparePrompt(
    prompt: string,
    options: MakaPreparePromptOptions = {},
  ): Promise<MakaPreparedSessionTurn> {
    const turnId = options.turnId ?? 'turn-1';
    this.turnOrchestrations.push(options.turnOrchestration);
    return Promise.resolve({
      sessionId: this.sessionId,
      turnId,
      events: this.promptEvents(prompt, turnId),
    });
  }

  getGoal(): GoalProjection | null {
    return this.goal;
  }

  // Queue contents travel on ONE path, exactly like the runtime: enqueues
  // emit a `queue_update` through the parked turn stream; the outcome only
  // says `queued`.
  private emitQueueUpdate(): void {
    this.eventSeq += 1;
    this.pendingEvents.push({
      type: 'queue_update',
      id: `queue-update-${this.eventSeq}`,
      turnId: 'turn-1',
      ts: this.eventSeq,
      steering: this.steering.map((entry) => entry.text),
      followup: this.followup.map((entry) => entry.text),
    });
    this.wakeTurn?.();
    this.wakeTurn = null;
  }

  async *promptEvents(_prompt: string, turnId: string): AsyncIterable<SessionEvent> {
    this.turnOpen = true;
    this.turnEnded = false;
    for (;;) {
      while (this.pendingEvents.length > 0) yield this.pendingEvents.shift()!;
      if (this.turnEnded) break;
      await new Promise<void>((resolve) => {
        this.wakeTurn = resolve;
      });
    }
    this.turnOpen = false;
    yield { type: 'abort', id: 'event-abort', turnId, ts: 1, reason: 'user_stop' };
    yield { type: 'complete', id: 'event-complete', turnId, ts: 2, stopReason: 'user_stop' };
  }

  async submitMessage(text: string, options: MakaSubmitMessageOptions): Promise<undefined> {
    // Stays in place: a gate set by a test holds every Message that arrives
    // while the Host has not answered the first one.
    await this.submitGate;
    if (this.nextSubmitError) {
      const error = this.nextSubmitError;
      this.nextSubmitError = undefined;
      throw error;
    }
    if (!this.turnOpen) {
      const turn = await this.preparePrompt(text, {
        turnId: options.messageId,
        ...(options.modelText !== undefined ? { modelText: options.modelText } : {}),
        ...(options.turnOrchestration ? { turnOrchestration: options.turnOrchestration } : {}),
      });
      queueMicrotask(() =>
        this.startedTurnListener?.({
          ...turn,
          messages: this.startedTurnMessages,
          summary: { ...fakeSessionSummary(turn.sessionId), ...this.hostSummary },
        }),
      );
      return undefined;
    }
    if (options.placement === 'current_turn') {
      this.steered.push(text);
      this.steering.push({ messageId: options.messageId, text });
    } else {
      this.queuedMessages.push(text);
      this.followup.push({ messageId: options.messageId, text });
    }
    this.emitQueueUpdate();
    return undefined;
  }

  subscribeStartedTurns(listener: (turn: MakaAttachedSessionTurn) => void): () => void {
    this.startedTurnListener = listener;
    return () => {
      if (this.startedTurnListener === listener) this.startedTurnListener = undefined;
    };
  }

  async retractQueued(): Promise<{ text: string; messageIds: readonly string[] }> {
    this.retractCalls += 1;
    const retracted = [...this.steering, ...this.followup];
    const joined = retracted.map((entry) => entry.text).join('\n\n');
    this.steering = [];
    this.followup = [];
    this.emitQueueUpdate();
    this.wakeTurn?.();
    this.wakeTurn = null;
    return { text: joined, messageIds: retracted.map((entry) => entry.messageId) };
  }

  // Simulates the runtime consuming the steering queue at a step boundary
  // before any queue_update reaches the CLI, leaving the render mirror stale.
  consumeSteering(): void {
    this.steering = [];
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    // The runtime clears its queues on stop; mirror that here.
    this.steering = [];
    this.followup = [];
    this.turnEnded = true;
    this.wakeTurn?.();
    this.wakeTurn = null;
  }

  async listRewindTargets(): Promise<RewindTarget[]> {
    return this.rewindTargets;
  }
}

class FailingOrchestrationDriver extends SteeringTurnDriver {
  override preparePrompt(): Promise<MakaPreparedSessionTurn> {
    return Promise.reject(new Error('admission failed'));
  }
}

class SlowStopDriver extends FakeSessionDriver {
  stopCalls = 0;
  readonly prompts: string[] = [];
  private releaseTurn: (() => void) | null = null;

  preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    this.prompts.push(prompt);
    return prepareTestPrompt(this, prompt);
  }

  async *promptEvents(_prompt: string): AsyncIterable<SessionEvent> {
    await new Promise<void>((resolve) => {
      this.releaseTurn = resolve;
    });
    yield {
      type: 'abort',
      id: 'event-abort',
      turnId: 'turn-1',
      ts: 1,
      reason: 'user_stop',
    };
  }

  // stop() records the request but leaves the turn parked, mimicking a runtime
  // stopSession that has not finished aborting yet.
  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  endTurn(): void {
    this.releaseTurn?.();
    this.releaseTurn = null;
  }
}

class ToolOutputDriver extends FakeSessionDriver {
  preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    return prepareTestPrompt(this, prompt);
  }

  async *promptEvents(_prompt: string): AsyncIterable<SessionEvent> {
    yield {
      type: 'tool_start',
      id: 'event-tool-start',
      turnId: 'turn-1',
      ts: 1,
      toolUseId: 'tool-1',
      toolName: 'Bash',
      args: { command: 'npm test' },
    };
    yield {
      type: 'tool_result',
      id: 'event-tool-result',
      turnId: 'turn-1',
      ts: 2,
      toolUseId: 'tool-1',
      isError: false,
      content: {
        kind: 'terminal',
        cwd: '/repo',
        cmd: 'npm test',
        status: 'completed',
        exitCode: 0,
        // `expanded-tail` is the FIRST line, so the compact tail (last ~5 lines)
        // hides it; expanding reveals the full output including this head line.
        output: pipeOutput(
          `expanded-tail\n${Array.from({ length: 30 }, (_, i) => `row-${i}`).join('\n')}`,
        ),
      },
    };
    yield {
      type: 'complete',
      id: 'event-complete',
      turnId: 'turn-1',
      ts: 3,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_response: SandboxBoundaryResponse): Promise<void> {}
  async renameSession(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setThinkingLevel(): Promise<void> {}
  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    return switchResult(fakeSessionSummary(sessionId));
  }
  async listRewindTargets(): Promise<RewindTarget[]> {
    return [];
  }
  async rewindToTurn(): Promise<MakaSessionRewindResult> {
    throw new Error('rewind not supported in this fake');
  }
  startNewSession(): Promise<void> {
    return Promise.resolve();
  }
  getSessionId(): string {
    return 'session-1';
  }
}

// #4011: an 80-line thinking block renders in full when expanded, so one
// Ctrl+T pushes its head above the 24-row viewport into scrollback.
class ThinkingDriver extends ToolOutputDriver {
  override async *promptEvents(_prompt: string): AsyncIterable<SessionEvent> {
    yield {
      type: 'thinking_delta',
      id: 'event-thinking-1',
      turnId: 'turn-1',
      ts: 1,
      messageId: 'message-1',
      text: Array.from({ length: 80 }, (_, i) => `reason-row-${i}`).join('\n'),
    };
    yield {
      type: 'complete',
      id: 'event-complete',
      turnId: 'turn-1',
      ts: 2,
      stopReason: 'end_turn',
    };
  }
}

class BackgroundShellRunDriver extends ToolOutputDriver {
  override async *promptEvents(_prompt: string): AsyncIterable<SessionEvent> {
    yield {
      type: 'tool_start',
      id: 'event-tool-start',
      turnId: 'turn-1',
      ts: 1,
      toolUseId: 'tool-bg',
      toolName: 'Bash',
      args: { command: 'build' },
    };
    yield {
      type: 'tool_result',
      id: 'event-tool-result',
      turnId: 'turn-1',
      ts: 2,
      toolUseId: 'tool-bg',
      isError: false,
      content: {
        kind: 'shell_run',
        ref: 'maka://runtime/background-tasks/bg-1',
        mode: 'pipes',
        status: 'running',
        cwd: '/repo',
        cmd: 'build',
        startedAt: 1_000,
        updatedAt: 2_000,
        revision: 2_000,
        output: pipeOutput(),
      },
    };
    yield {
      type: 'complete',
      id: 'event-complete',
      turnId: 'turn-1',
      ts: 3,
      stopReason: 'end_turn',
    };
  }
}

// #1135: an off-screen running Bash card settles while off-screen. The settle
// is delivered via subscribeShellRunUpdates (see the test). The driver only
// sets up the off-screen running card and a late visible tool.
class OffscreenSettleDriver extends ToolOutputDriver {
  override async *promptEvents(_prompt: string): AsyncIterable<SessionEvent> {
    yield {
      type: 'tool_start',
      id: 'event-early-start',
      turnId: 'turn-1',
      ts: 1,
      toolUseId: 'tool-early',
      toolName: 'Bash',
      args: { command: 'early-build' },
    };
    yield {
      type: 'tool_result',
      id: 'event-early-result',
      turnId: 'turn-1',
      ts: 2,
      toolUseId: 'tool-early',
      isError: false,
      content: {
        kind: 'shell_run',
        ref: 'maka://runtime/background-tasks/bg-1',
        mode: 'pipes' as const,
        status: 'running',
        cwd: '/repo',
        cmd: 'early-build',
        startedAt: 1_000,
        updatedAt: 2_000,
        revision: 2_000,
        output: pipeOutput(),
      },
    };
    yield {
      type: 'text_delta',
      id: 'event-filler',
      turnId: 'turn-1',
      ts: 3,
      messageId: 'message-1',
      text: Array.from({ length: 30 }, (_, i) => `filler-${i}`).join('\n\n'),
    };
    yield {
      type: 'tool_start',
      id: 'event-late-start',
      turnId: 'turn-1',
      ts: 4,
      toolUseId: 'tool-late',
      toolName: 'Bash',
      args: { command: 'late-build' },
    };
    yield {
      type: 'tool_result',
      id: 'event-late-result',
      turnId: 'turn-1',
      ts: 5,
      toolUseId: 'tool-late',
      isError: false,
      content: {
        kind: 'terminal',
        cwd: '/repo',
        cmd: 'late-build',
        status: 'completed',
        exitCode: 0,
        output: pipeOutput('late-build done'),
      },
    };
    yield {
      type: 'complete',
      id: 'event-complete',
      turnId: 'turn-1',
      ts: 6,
      stopReason: 'end_turn',
    };
  }
}

// #1135: an assistant reply grows past the viewport boundary. The entry
// straddles scrollback and viewport — its scrollback prefix is frozen but the
// visible tail must keep updating.
class StreamingPastViewportDriver extends ToolOutputDriver {
  override async *promptEvents(_prompt: string): AsyncIterable<SessionEvent> {
    // First delta: ~30 paragraphs fill a 24-row viewport.
    yield {
      type: 'text_delta',
      id: 'event-text-1',
      turnId: 'turn-1',
      ts: 1,
      messageId: 'message-1',
      text: Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n\n'),
    };
    // Second delta: a unique marker appended to the same entry.
    yield {
      type: 'text_delta',
      id: 'event-text-2',
      turnId: 'turn-1',
      ts: 2,
      messageId: 'message-1',
      text: '\n\nUNIQUE-TAIL-MARKER',
    };
    yield {
      type: 'complete',
      id: 'event-complete',
      turnId: 'turn-1',
      ts: 3,
      stopReason: 'end_turn',
    };
  }
}

function pipeOutput(stdout = '', stderr = '') {
  return {
    mode: 'pipes' as const,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    redacted: false,
  };
}

class SlashCommandDriver extends FakeSessionDriver {
  /** Model-facing text (options.modelText when set, else the typed prompt). */
  readonly prompts: string[] = [];
  /** Human-facing typed prompt for every prepared turn. */
  readonly displayPrompts: string[] = [];
  readonly models: string[] = [];
  readonly modelConnections: Array<string | undefined> = [];
  readonly modelConnectionIds: Array<string | undefined> = [];
  readonly permissionModes: PermissionMode[] = [];
  readonly thinkingLevelUpdates: Array<ThinkingLevel | undefined> = [];
  readonly orchestrationModes: OrchestrationMode[] = [];
  readonly turnOrchestrations: Array<MakaPreparePromptOptions['turnOrchestration']> = [];
  readonly sessionIds: string[] = [];
  readonly sessionSwitchOptions: Array<MakaSessionSwitchOptions | undefined> = [];
  readonly renames: string[] = [];
  readonly moves: string[] = [];
  startNewSessionCalls = 0;
  resumeCalls = 0;
  /** When set, resumeLatest throws SafeBoundaryResumeParkedError with this reason. */
  parkedResumeReason: TurnResumeParkReason | undefined;
  contextDiagnosticsRequests = 0;
  goal: GoalProjection | null = null;
  readonly goalListeners = new Set<(goal: GoalProjection | null) => void>();
  contextDiagnostics: ContextDiagnostics = {
    status: 'unavailable',
    reason: 'no_completed_request',
  };
  protected sessionId = 'session-1';
  protected orchestrationMode: OrchestrationMode = 'default';
  /**
   * What the ACTIVE session's boundary says, as the real driver derives it
   * (#1611). Undefined until a session is resumed, matching a driver that has
   * no boundary to read yet.
   */
  protected activeBoundaryDisplayMode: PermissionMode | undefined;

  constructor(
    private readonly sessions: SessionSummary[] = [fakeSessionSummary('session-2', '/repo')],
    private readonly sessionMessages: ReadonlyMap<string, readonly StoredMessage[]> = new Map(),
    private readonly boundaryDisplayModeBySession: ReadonlyMap<string, PermissionMode> = new Map(),
  ) {
    super();
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this.sessions;
  }

  async getContextDiagnostics(): Promise<ContextDiagnostics> {
    this.contextDiagnosticsRequests += 1;
    return this.contextDiagnostics;
  }

  getGoal(): GoalProjection | null {
    return this.goal;
  }

  subscribeGoalChanges(listener: (goal: GoalProjection | null) => void): () => void {
    this.goalListeners.add(listener);
    return () => this.goalListeners.delete(listener);
  }

  /** Simulates a host-pushed goal projection change. */
  pushGoal(goal: GoalProjection | null): void {
    this.goal = goal;
    for (const listener of this.goalListeners) listener(goal);
  }

  /** Records control actions and applies them to the local goal like the host would. */
  readonly controlledGoalActions: Array<'pause' | 'resume' | 'clear'> = [];
  /**
   * When true, controlGoal resolves without pushing the projection first —
   * the response-before-push ordering a slow subscription stream can produce.
   */
  deferGoalControlPush = false;
  /** Per-session goal projections applied when switchSession adopts a session. */
  readonly goalsBySessionId = new Map<string, GoalProjection | null>();

  controlGoal(action: 'pause' | 'resume' | 'clear'): Promise<GoalProjection | null> {
    this.controlledGoalActions.push(action);
    const goal = this.goal;
    if (!goal) return Promise.resolve(null);
    const next: GoalProjection =
      action === 'clear'
        ? { ...goal, status: 'cleared', revision: goal.revision + 1 }
        : action === 'pause'
          ? { ...goal, status: 'paused', revision: goal.revision + 1, pausedAt: Date.now() }
          : { ...goal, status: 'active', revision: goal.revision + 1, pausedAt: null };
    if (this.deferGoalControlPush) {
      this.goal = next;
    } else {
      this.pushGoal(next);
    }
    return Promise.resolve(next);
  }

  preparePrompt(
    prompt: string,
    options: MakaPreparePromptOptions = {},
  ): Promise<MakaPreparedSessionTurn> {
    const turnId = options.turnId ?? 'turn-1';
    const modelText = options.modelText ?? prompt;
    this.displayPrompts.push(prompt);
    this.prompts.push(modelText);
    this.turnOrchestrations.push(options.turnOrchestration);
    return Promise.resolve({
      sessionId: this.sessionId,
      turnId,
      events: this.promptEvents(modelText, turnId),
    });
  }

  async getSessionResumeAvailability(session: SessionSummary): Promise<SessionResumeAvailability> {
    return session.cwd
      ? { available: true }
      : { available: false, reason: 'Missing working directory' };
  }

  /** Bumped when the drain first pulls the Turn's stream. */
  streamPulls = 0;

  async *promptEvents(_prompt: string, turnId = 'turn-1'): AsyncIterable<SessionEvent> {
    this.streamPulls += 1;
    yield {
      type: 'complete',
      id: 'event-complete',
      turnId,
      ts: 1,
      stopReason: 'end_turn',
    };
  }

  async *compactSession(): AsyncIterable<SessionEvent> {
    yield {
      type: 'complete',
      id: 'event-compact-complete',
      turnId: 'turn-compact',
      ts: 1,
      stopReason: 'end_turn',
    };
  }

  async *resumeLatest(): AsyncIterable<SessionEvent> {
    this.resumeCalls += 1;
    if (this.parkedResumeReason !== undefined) {
      throw new SafeBoundaryResumeParkedError(this.parkedResumeReason);
    }
    yield {
      type: 'text_complete',
      id: 'event-resume-text',
      turnId: 'turn-resume',
      ts: 1,
      messageId: 'message-resume',
      text: 'resumed safely',
    };
    yield {
      type: 'complete',
      id: 'event-resume-complete',
      turnId: 'turn-resume',
      ts: 2,
      stopReason: 'end_turn',
    };
  }

  async setModel(model: string, connectionSlug?: string, connectionId?: string): Promise<void> {
    this.models.push(model);
    this.modelConnections.push(connectionSlug);
    this.modelConnectionIds.push(connectionId);
  }
  async renameSession(name: string): Promise<string> {
    this.renames.push(name);
    return name;
  }
  async moveSession(cwd: string): Promise<MakaSessionMoveResult> {
    this.moves.push(cwd);
    return {
      previousCwd: '/repo',
      cwd,
      changed: true,
      oldCwdDirty: true,
    };
  }
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionModes.push(mode);
    this.activeBoundaryDisplayMode = mode;
  }
  async setThinkingLevel(level: ThinkingLevel | undefined): Promise<void> {
    this.thinkingLevelUpdates.push(level);
  }
  async setOrchestrationMode(mode: OrchestrationMode): Promise<void> {
    this.orchestrationModes.push(mode);
    this.orchestrationMode = mode;
  }
  async switchSession(
    sessionId: string,
    options?: MakaSessionSwitchOptions,
  ): Promise<MakaSessionSwitchResult> {
    this.sessionIds.push(sessionId);
    this.sessionSwitchOptions.push(options);
    this.sessionId = sessionId;
    const summary = this.sessions.find((session) => session.id === sessionId);
    const nextSummary = summary ?? fakeSessionSummary(sessionId);
    this.orchestrationMode = nextSummary.orchestrationMode ?? 'default';
    this.activeBoundaryDisplayMode = this.boundaryDisplayModeBySession.get(nextSummary.id);
    if (this.goalsBySessionId.has(sessionId)) {
      this.goal = this.goalsBySessionId.get(sessionId) ?? null;
    }
    return switchResult(nextSummary, [...(this.sessionMessages.get(nextSummary.id) ?? [])]);
  }
  async rewindToTurn(_turnId: string): Promise<MakaSessionRewindResult> {
    throw new Error('rewind not supported in this fake');
  }
  async startNewSession(): Promise<void> {
    this.startNewSessionCalls += 1;
    this.sessionId = 'session-new';
    this.activeBoundaryDisplayMode = undefined;
  }
  getSessionId(): string | null {
    return this.sessionId;
  }
  getOrchestrationMode(): OrchestrationMode {
    return this.orchestrationMode;
  }
  getPermissionMode(): PermissionMode {
    return this.activeBoundaryDisplayMode ?? 'ask';
  }
}

class UserCommandDriver extends SlashCommandDriver {
  readonly commands: string[] = [];

  async runUserCommand(command: string) {
    this.commands.push(command);
    return {
      commandId: `user-command-${this.commands.length}`,
      result: {
        kind: 'shell_run' as const,
        ref: `maka://runtime/background-tasks/user-command-${this.commands.length}`,
        mode: 'pipes' as const,
        status: 'completed' as const,
        cwd: '/repo',
        cmd: command,
        startedAt: 1,
        updatedAt: 2,
        completedAt: 2,
        exitCode: 0,
        revision: 1,
        output: pipeOutput(command),
      },
      takeRacedUpdate: () => undefined,
    };
  }
}

class RunningUserCommandDriver extends SlashCommandDriver {
  readonly commands: string[] = [];
  stopUserCommandCalls = 0;
  readonly #transcriptListeners = new Set<
    (
      sessionId: string,
      turnId: string,
      messages: StoredMessage[],
      reason: MakaTranscriptReplacementReason,
    ) => void
  >();

  async runUserCommand(command: string) {
    this.commands.push(command);
    return {
      commandId: `user-command-${this.commands.length}`,
      result: {
        kind: 'shell_run' as const,
        ref: `maka://runtime/background-tasks/user-command-${this.commands.length}`,
        mode: 'pipes' as const,
        status: 'running' as const,
        cwd: '/repo',
        cmd: command,
        startedAt: 1,
        updatedAt: 1,
        revision: 1,
        output: pipeOutput(''),
      },
      takeRacedUpdate: () => undefined,
    };
  }

  async stopUserCommands(): Promise<void> {
    this.stopUserCommandCalls += 1;
  }

  subscribeTranscriptReplacements(
    listener: (
      sessionId: string,
      turnId: string,
      messages: StoredMessage[],
      reason: MakaTranscriptReplacementReason,
    ) => void,
  ): () => void {
    this.#transcriptListeners.add(listener);
    return () => this.#transcriptListeners.delete(listener);
  }

  publishReconnect(): void {
    for (const listener of this.#transcriptListeners) {
      listener('session-1', 'turn-1', [], 'reconnect');
    }
  }
}

class RejectingUserCommandStopDriver extends RunningUserCommandDriver {
  override async stopUserCommands(): Promise<void> {
    this.stopUserCommandCalls += 1;
    if (this.stopUserCommandCalls === 1) throw new Error('host_draining');
  }
}

class HostSkillDriver extends SlashCommandDriver {
  constructor(private readonly skillInvocation: SkillInvocationResult) {
    super();
  }

  /** Nothing the Host could resolve, so it opens no Turn for this Message. */
  #refuses(): boolean {
    return this.skillInvocation.loaded.length === 0 && this.skillInvocation.failed.length > 0;
  }

  // The Host answers a refused invocation with a `blocked` disposition rather
  // than a Turn; the driver hands that back as the submit result.
  override async submitMessage(
    text: string,
    options: MakaSubmitMessageOptions,
  ): Promise<TurnMessageSubmitResult | undefined> {
    if (this.#refuses()) {
      return { disposition: 'blocked', skillInvocation: this.skillInvocation };
    }
    // Admitted: the receipt for what was resolved rides the answer, which is
    // the client's only sight of it.
    const admitted = await super.submitMessage(text, options);
    return admitted?.disposition === 'turn_started'
      ? { ...admitted, skillInvocation: this.skillInvocation }
      : admitted;
  }

  override async preparePrompt(
    prompt: string,
    options: MakaPreparePromptOptions = {},
  ): Promise<MakaPreparedSessionTurn> {
    // `turn.start` still refuses outright; its only caller is headless
    // `maka run`, which reports the refusal as an ordinary failure.
    if (this.#refuses()) throw new Error(skillInvocationBlockedMessage(this.skillInvocation));
    return super.preparePrompt(prompt, options);
  }
}

class SideConversationDriver extends SlashCommandDriver {
  readonly openedFrom: string[] = [];
  readonly closedSides: Array<{ sideSessionId: string; parentSessionId: string }> = [];
  readonly promptSessionIds: string[] = [];
  readonly discardedSides: string[] = [];
  parentStatusListener:
    | ((status: MakaSideConversationParentStatus | undefined) => void)
    | undefined;

  override preparePrompt(
    prompt: string,
    options: MakaPreparePromptOptions = {},
  ): Promise<MakaPreparedSessionTurn> {
    this.promptSessionIds.push(this.sessionId);
    return super.preparePrompt(prompt, options);
  }

  async openSideConversation() {
    const parentSessionId = this.sessionId;
    this.openedFrom.push(parentSessionId);
    this.sessionId = 'side-1';
    return {
      summary: {
        ...fakeSessionSummary('side-1'),
        labels: ['mode:side_conversation'],
        parentSessionId,
        branchOfTurnId: 'turn-settled',
      },
      messages: [],
      parentSessionId,
      sideSessionId: 'side-1',
    };
  }

  async closeSideConversation(sideSessionId: string, parentSessionId: string) {
    this.closedSides.push({ sideSessionId, parentSessionId });
    this.sessionId = parentSessionId;
    return { ...switchResult(fakeSessionSummary(parentSessionId)), cleanup: 'removed' as const };
  }

  async observeSideConversationParent(
    _parentSessionId: string,
    listener: (status: MakaSideConversationParentStatus | undefined) => void,
  ) {
    this.parentStatusListener = listener;
    return async () => {
      if (this.parentStatusListener === listener) this.parentStatusListener = undefined;
    };
  }

  publishParentStatus(status: MakaSideConversationParentStatus | undefined): void {
    this.parentStatusListener?.(status);
  }

  async discardSideConversation(sideSessionId: string) {
    this.discardedSides.push(sideSessionId);
    return 'removed' as const;
  }
}

class FailingParentObserverSideConversationDriver extends SideConversationDriver {
  override async observeSideConversationParent(
    _parentSessionId: string,
    _listener: (status: MakaSideConversationParentStatus | undefined) => void,
  ): Promise<() => Promise<void>> {
    throw new Error('parent observer unavailable');
  }
}

class RunningParentSideConversationDriver extends SideConversationDriver {
  readonly parentStarted = deferred<void>();
  readonly #releaseParent = deferred<void>();
  stopCalls = 0;

  override async *promptEvents(prompt: string, turnId = 'turn-1'): AsyncIterable<SessionEvent> {
    if (prompt === 'main work') {
      this.parentStarted.resolve();
      await this.#releaseParent.promise;
    }
    yield {
      type: 'complete',
      id: `event-complete-${turnId}`,
      turnId,
      ts: 1,
      stopReason: 'end_turn',
    };
  }

  override async openSideConversation() {
    this.#releaseParent.resolve();
    return super.openSideConversation();
  }

  override async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

class RunningSideConversationDriver extends SideConversationDriver {
  readonly sideStarted = deferred<void>();
  readonly #releaseSide = deferred<void>();
  stopCalls = 0;

  override async *promptEvents(prompt: string, turnId = 'turn-1'): AsyncIterable<SessionEvent> {
    if (prompt === 'keep checking') {
      this.sideStarted.resolve();
      await this.#releaseSide.promise;
    }
    yield {
      type: 'complete',
      id: `event-complete-${turnId}`,
      turnId,
      ts: 1,
      stopReason: 'end_turn',
    };
  }

  override async stop(): Promise<void> {
    this.stopCalls += 1;
    this.#releaseSide.resolve();
  }
}

class FailingSwitchSessionDriver extends SlashCommandDriver {
  async switchSession(_sessionId: string): Promise<MakaSessionSwitchResult> {
    throw new Error('session not found');
  }
}

class ActiveResumeDriver extends SlashCommandDriver {
  override async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    const switched = await super.switchSession(sessionId);
    const turnId = 'turn-active';
    return {
      ...switched,
      messages: [
        storedUserMessage('user-active', turnId, 'Question'),
        storedAssistantMessage('assistant-active', turnId, 'Hello'),
      ],
      activeTurn: {
        sessionId,
        turnId,
        events: (async function* () {
          yield {
            type: 'text_delta',
            id: 'delta-active',
            turnId,
            messageId: 'assistant-active',
            ts: 2,
            text: ' world',
          } satisfies SessionEvent;
          yield {
            type: 'text_complete',
            id: 'text-active',
            turnId,
            messageId: 'assistant-active',
            ts: 3,
            text: 'Hello world',
          } satisfies SessionEvent;
          yield {
            type: 'complete',
            id: 'complete-active',
            turnId,
            ts: 4,
            stopReason: 'end_turn',
          } satisfies SessionEvent;
        })(),
      },
    };
  }
}

// A parking first Turn on session-1 plus a switchable session-2, for the
// mid-turn /session detach tests (#3380). The parked stream ends only when
// the test releases it or stop() lands — a detach leaves it running, exactly
// like a Host-owned Turn surviving a client that switches away. Later prompts
// (submitted after switching) complete immediately.
class DetachingSwitchDriver extends SlashCommandDriver {
  stopCalls = 0;

  /** Pushes a Host-started Turn the way the real started-turn stream would. */
  announceStartedTurn(turn: MakaAttachedSessionTurn): void {
    this.startedTurnListener?.(turn);
  }

  /** When set, the next switchSession rejects — a failed detach must leave
   *  the running drain fully live. */
  failNextSwitch = false;
  /** When set, the next switchSession parks until released — a second
   *  mid-turn /session arriving while the first is still in flight. */
  holdSwitch: Promise<void> | undefined;
  switchEntries = 0;
  private pendingEvents: SessionEvent[] = [];
  private wakeTurn: (() => void) | null = null;
  private turnEnded = false;
  private promptCount = 0;

  constructor(sessionTwoMessages: StoredMessage[]) {
    super([fakeSessionSummary('session-2', '/repo')], new Map([['session-2', sessionTwoMessages]]));
  }

  /** Queues an event onto the parked first-session Turn. */
  emit(event: SessionEvent): void {
    this.pendingEvents.push(event);
    this.wakeTurn?.();
    this.wakeTurn = null;
  }

  /** Ends the parked stream the way a Host does when its Turn settles. */
  releaseOldTurn(): void {
    this.turnEnded = true;
    this.wakeTurn?.();
    this.wakeTurn = null;
  }

  override async *promptEvents(_prompt: string, turnId = 'turn-1'): AsyncIterable<SessionEvent> {
    this.promptCount += 1;
    if (this.promptCount > 1) {
      yield { type: 'complete', id: `complete-${turnId}`, turnId, ts: 9, stopReason: 'end_turn' };
      return;
    }
    for (;;) {
      while (this.pendingEvents.length > 0) yield this.pendingEvents.shift()!;
      if (this.turnEnded) break;
      await new Promise<void>((resolve) => {
        this.wakeTurn = resolve;
      });
    }
    yield { type: 'abort', id: 'abort-old', turnId, ts: 8, reason: 'user_stop' };
    yield { type: 'complete', id: 'complete-old', turnId, ts: 9, stopReason: 'user_stop' };
  }

  override async stop(): Promise<void> {
    this.stopCalls += 1;
    this.turnEnded = true;
    this.wakeTurn?.();
    this.wakeTurn = null;
  }

  // session-2 carries a live Turn, so adopting it hands back an activeTurn —
  // the reattach path the runner must start once the orphaned drain unwinds.
  override async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    this.switchEntries += 1;
    if (this.failNextSwitch) {
      this.failNextSwitch = false;
      throw new Error('session not found');
    }
    if (this.holdSwitch) {
      const gate = this.holdSwitch;
      this.holdSwitch = undefined;
      await gate;
    }
    const switched = await super.switchSession(sessionId);
    if (sessionId !== 'session-2') return switched;
    const attachedTurnId = 'turn-attached-2';
    return {
      ...switched,
      activeTurn: {
        sessionId,
        turnId: attachedTurnId,
        events: (async function* () {
          yield {
            type: 'text_complete',
            id: 'text-attached',
            turnId: attachedTurnId,
            messageId: 'assistant-attached',
            ts: 3,
            text: 'attached replay done',
          } satisfies SessionEvent;
          yield {
            type: 'complete',
            id: 'complete-attached',
            turnId: attachedTurnId,
            ts: 4,
            stopReason: 'end_turn',
          } satisfies SessionEvent;
        })(),
      },
    };
  }
}

class HostSuccessorDriver extends SlashCommandDriver {
  readonly #probeFirst = deferred<void>();
  #finishFirst: (() => void) | undefined;
  successorPulls = 0;
  readonly shellRunReads: string[] = [];

  override async *promptEvents(_prompt: string, turnId = 'turn-1'): AsyncIterable<SessionEvent> {
    await this.#probeFirst.promise;
    yield {
      type: 'text_delta',
      id: 'text-delta-first',
      turnId,
      messageId: 'assistant-first',
      ts: 1,
      text: 'First still active',
    };
    yield {
      type: 'text_complete',
      id: 'text-complete-first',
      turnId,
      messageId: 'assistant-first',
      ts: 2,
      text: 'First still active',
    };
    await new Promise<void>((resolve) => {
      this.#finishFirst = resolve;
    });
    yield { type: 'complete', id: 'complete-first', turnId, ts: 3, stopReason: 'end_turn' };
  }

  publishSuccessor(): void {
    const turnId = 'turn-second';
    const driver = this;
    this.startedTurnListener?.({
      sessionId: this.getSessionId()!,
      turnId,
      messages: [
        storedUserMessage('user-second', turnId, 'Second question'),
        {
          type: 'tool_call',
          id: 'tool-bg',
          turnId,
          ts: 1,
          toolName: 'Bash',
          args: { command: 'build' },
        },
        {
          type: 'tool_result',
          id: 'result-bg',
          turnId,
          ts: 2,
          toolUseId: 'tool-bg',
          isError: false,
          content: {
            kind: 'shell_run',
            ref: 'maka://runtime/background-tasks/bg-successor',
            mode: 'pipes',
            status: 'running',
            cwd: '/repo',
            cmd: 'build',
            startedAt: 1_000,
            updatedAt: 2_000,
            revision: 2_000,
            output: pipeOutput('starting\n'),
          },
        },
        storedAssistantMessage('assistant-second', turnId, 'Second'),
      ],
      summary: fakeSessionSummary(this.getSessionId()!),
      events: (async function* () {
        driver.successorPulls += 1;
        yield {
          type: 'text_delta',
          id: 'delta-second',
          turnId,
          messageId: 'assistant-second',
          ts: 2,
          text: ' answer',
        } satisfies SessionEvent;
        yield {
          type: 'complete',
          id: 'complete-second',
          turnId,
          ts: 3,
          stopReason: 'end_turn',
        } satisfies SessionEvent;
      })(),
    });
  }

  probeFirstTurn(): void {
    this.#probeFirst.resolve();
  }

  listShellRunUpdates(sessionId: string): Promise<ShellRunUpdate[]> {
    this.shellRunReads.push(sessionId);
    return Promise.resolve([
      {
        sessionId,
        ownership: { kind: 'local' },
        sourceTurnId: 'turn-second',
        sourceToolCallId: 'tool-bg',
        result: {
          kind: 'shell_run',
          ref: 'maka://runtime/background-tasks/bg-successor',
          mode: 'pipes',
          status: 'completed',
          cwd: '/repo',
          cmd: 'build',
          startedAt: 1_000,
          updatedAt: 5_000,
          completedAt: 5_000,
          exitCode: 0,
          revision: 5_000,
          output: pipeOutput('starting\ndone\n'),
        },
      },
    ]);
  }

  finishFirstTurn(): void {
    this.#finishFirst?.();
    this.#finishFirst = undefined;
  }
}

class FirstSessionPreparedDriver extends SlashCommandDriver {
  readonly streamStarted = deferred<void>();
  readonly releaseStream = deferred<void>();
  private prepared = false;

  override getSessionId(): string | null {
    return this.prepared ? this.sessionId : null;
  }

  async preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    this.prepared = true;
    this.sessionId = 'session-first';
    return {
      sessionId: this.sessionId,
      turnId: 'turn-first',
      events: this.events(prompt),
    };
  }

  private async *events(prompt: string): AsyncIterable<SessionEvent> {
    this.prompts.push(prompt);
    this.streamStarted.resolve();
    await this.releaseStream.promise;
    yield {
      type: 'complete',
      id: 'event-complete',
      turnId: 'turn-first',
      ts: 1,
      stopReason: 'end_turn',
    };
  }
}

class HangingCloseDriver extends SlashCommandDriver {
  stopCalls = 0;
  private resolveStop: (() => void) | null = null;

  override async stop(): Promise<void> {
    this.stopCalls += 1;
    await new Promise<void>((resolve) => {
      this.resolveStop = resolve;
    });
  }

  releaseStop(): void {
    this.resolveStop?.();
    this.resolveStop = null;
  }
}

class LongTranscriptDriver extends SlashCommandDriver {
  override async *promptEvents(_prompt: string): AsyncIterable<SessionEvent> {
    yield {
      type: 'text_complete',
      id: 'event-text-complete',
      turnId: 'turn-1',
      ts: 1,
      messageId: 'message-1',
      text: Array.from({ length: 40 }, (_, index) => `filler line ${index + 1}`).join('\n'),
    };
    yield {
      type: 'complete',
      id: 'event-complete',
      turnId: 'turn-1',
      ts: 2,
      stopReason: 'end_turn',
    };
  }
}

class DeferredControlDriver extends FakeSessionDriver {
  readonly prompts: string[] = [];
  readonly models: string[] = [];
  private resolveSetModel: (() => void) | null = null;

  preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    return prepareTestPrompt(this, prompt);
  }

  async *promptEvents(prompt: string): AsyncIterable<SessionEvent> {
    this.prompts.push(prompt);
    yield {
      type: 'complete',
      id: 'event-complete',
      turnId: 'turn-1',
      ts: 1,
      stopReason: 'end_turn',
    };
  }

  async setModel(model: string): Promise<void> {
    this.models.push(model);
    await new Promise<void>((resolve) => {
      this.resolveSetModel = resolve;
    });
  }

  releaseSetModel(): void {
    this.resolveSetModel?.();
    this.resolveSetModel = null;
  }

  async renameSession(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setThinkingLevel(): Promise<void> {}
  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    return switchResult(fakeSessionSummary(sessionId));
  }

  async listRewindTargets(): Promise<RewindTarget[]> {
    return [];
  }
  async rewindToTurn(): Promise<MakaSessionRewindResult> {
    throw new Error('rewind not supported in this fake');
  }
  startNewSession(): Promise<void> {
    return Promise.resolve();
  }
  getSessionId(): string {
    return 'session-1';
  }
}

class RejectingSandboxBoundaryDriver extends FakeSessionDriver {
  readonly responses: SandboxBoundaryResponse[] = [];

  preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    return prepareTestPrompt(this, prompt);
  }

  async *promptEvents(_prompt: string): AsyncIterable<SessionEvent> {
    yield {
      type: 'sandbox_boundary_request',
      id: 'event-boundary',
      turnId: 'turn-1',
      ts: 1,
      requestId: 'boundary-1',
      toolUseId: 'tool-1',
      justification: 'Read /outside.',
      expansion: {
        filesystem: {
          entries: [{ path: '/outside', access: 'read', scope: 'exact' }],
        },
      },
    };
    // The turn stays parked while the boundary request is unresolved.
    await new Promise<void>(() => {});
  }

  async respondToSandboxBoundary(response: SandboxBoundaryResponse): Promise<void> {
    this.responses.push(response);
    throw new Error('sandbox boundary response rejected');
  }

  async renameSession(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setThinkingLevel(): Promise<void> {}
  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    return switchResult(fakeSessionSummary(sessionId));
  }

  async listRewindTargets(): Promise<RewindTarget[]> {
    return [];
  }
  async rewindToTurn(): Promise<MakaSessionRewindResult> {
    throw new Error('rewind not supported in this fake');
  }
  startNewSession(): Promise<void> {
    return Promise.resolve();
  }
  getSessionId(): string {
    return 'session-1';
  }
}

class DeferredListSessionsDriver extends SlashCommandDriver {
  listCalls = 0;
  private resolveList: (() => void) | null = null;

  override async listSessions(): Promise<SessionSummary[]> {
    this.listCalls += 1;
    await new Promise<void>((resolve) => {
      this.resolveList = resolve;
    });
    return super.listSessions();
  }

  releaseList(): void {
    this.resolveList?.();
    this.resolveList = null;
  }
}

class SandboxBoundaryThenErrorDriver extends FakeSessionDriver {
  respondCalls = 0;
  private resolveContinue: (() => void) | null = null;

  preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    return prepareTestPrompt(this, prompt);
  }

  async *promptEvents(_prompt: string): AsyncIterable<SessionEvent> {
    yield {
      type: 'sandbox_boundary_request',
      id: 'event-boundary',
      turnId: 'turn-1',
      ts: 1,
      requestId: 'boundary-1',
      toolUseId: 'tool-1',
      justification: 'Read /outside.',
      expansion: {
        filesystem: {
          entries: [{ path: '/outside', access: 'read', scope: 'exact' }],
        },
      },
    };
    await new Promise<void>((resolve) => {
      this.resolveContinue = resolve;
    });
    throw new Error('turn failed');
  }

  continueToError(): void {
    this.resolveContinue?.();
    this.resolveContinue = null;
  }

  async respondToSandboxBoundary(_response: SandboxBoundaryResponse): Promise<void> {
    this.respondCalls += 1;
  }

  async renameSession(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setThinkingLevel(): Promise<void> {}
  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    return switchResult(fakeSessionSummary(sessionId));
  }

  async listRewindTargets(): Promise<RewindTarget[]> {
    return [];
  }
  async rewindToTurn(): Promise<MakaSessionRewindResult> {
    throw new Error('rewind not supported in this fake');
  }
  startNewSession(): Promise<void> {
    return Promise.resolve();
  }
  getSessionId(): string {
    return 'session-1';
  }
}

class RewindDriver extends SlashCommandDriver {
  readonly rewound: string[] = [];

  constructor(
    private readonly targets: RewindTarget[],
    private readonly branchMessages: readonly StoredMessage[] = [],
    private readonly branchSummary: SessionSummary = fakeSessionSummary('session-branch'),
  ) {
    super();
  }

  override async listRewindTargets(): Promise<RewindTarget[]> {
    return this.targets;
  }

  override async rewindToTurn(turnId: string): Promise<MakaSessionRewindResult> {
    this.rewound.push(turnId);
    this.sessionId = this.branchSummary.id;
    return {
      ...switchResult(this.branchSummary, [...this.branchMessages]),
      prompt: `refilled: ${turnId}`,
    };
  }
}

class DeferredRewindDriver extends RewindDriver {
  readonly gate = deferred<void>();

  override async rewindToTurn(turnId: string): Promise<MakaSessionRewindResult> {
    await this.gate.promise;
    return super.rewindToTurn(turnId);
  }
}

/**
 * Holds `busy` from underneath an open picker: publishSuccessor-style, a
 * Host-started turn begins (and blocks on `turnGate`) while the rewind picker
 * is already open, so a selection lands on runControl's busy early return.
 */
class BusyAfterPickerOpenDriver extends RewindDriver {
  readonly turnGate = deferred<void>();
  #startedTurnListener: ((turn: MakaAttachedSessionTurn) => void) | undefined;

  subscribeStartedTurns(listener: (turn: MakaAttachedSessionTurn) => void): () => void {
    this.#startedTurnListener = listener;
    return () => {
      if (this.#startedTurnListener === listener) this.#startedTurnListener = undefined;
    };
  }

  startBlockingTurn(): void {
    const gate = this.turnGate;
    this.#startedTurnListener?.({
      sessionId: this.getSessionId()!,
      turnId: 'turn-host',
      messages: [
        storedUserMessage('user-host', 'turn-host', 'host question'),
        storedAssistantMessage('assistant-host', 'turn-host', 'host answer'),
      ],
      summary: fakeSessionSummary(this.getSessionId()!),
      events: (async function* () {
        await gate.promise;
        yield {
          type: 'complete',
          id: 'complete-host',
          turnId: 'turn-host',
          ts: 3,
          stopReason: 'end_turn',
        } satisfies SessionEvent;
      })(),
    });
  }
}

function switchResult(
  summary: SessionSummary,
  messages: StoredMessage[] = [],
): MakaSessionSwitchResult {
  return { summary, messages };
}

interface HostAdmittingDriver {
  preparePrompt(
    prompt: string,
    options?: MakaPreparePromptOptions,
  ): Promise<MakaPreparedSessionTurn>;
  startedTurnListener: ((turn: MakaAttachedSessionTurn) => void) | undefined;
  hostSummary: Partial<SessionSummary>;
}

/**
 * Emulates Runtime Host admission: an idle Session turns the submitted Message
 * into a Turn the TUI then attaches to. `hostSummary` is what the Host reports
 * for that Session, so a test whose TUI runs on a non-default model points it
 * there instead of letting the default summary rewrite the status line.
 */
/**
 * The Host admitting a Message as a fresh Turn: it answers the submit with
 * `turn_started`, and the Turn itself arrives separately through the
 * started-Turn subscription. That push carries Session state, NOT this
 * Message's admission — anything the client learns about the admission has to
 * come back through the answer, which is why the receipt is stripped here.
 */
async function admitMessageAsTurn(
  driver: HostAdmittingDriver,
  text: string,
  options: MakaSubmitMessageOptions,
): Promise<TurnMessageSubmitResult> {
  const { skillInvocation: _admissionReceipt, ...turn } = await driver.preparePrompt(text, {
    turnId: options.messageId,
    ...(options.modelText !== undefined ? { modelText: options.modelText } : {}),
    ...(options.turnOrchestration ? { turnOrchestration: options.turnOrchestration } : {}),
  });
  queueMicrotask(() =>
    driver.startedTurnListener?.({
      ...turn,
      messages: [],
      summary: { ...fakeSessionSummary(turn.sessionId), ...driver.hostSummary },
    }),
  );
  return { disposition: 'turn_started', turnId: turn.turnId };
}

function fakeSessionSummary(
  sessionId: string,
  cwd = '/repo',
  name = 'Existing chat',
): SessionSummary {
  return {
    id: sessionId,
    cwd,
    name,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'claude-subscription',
    connectionLocked: false,
    model: 'claude-sonnet-4-5',
    permissionMode: 'ask',
  };
}

function storedUserMessage(id: string, turnId: string, text: string): StoredMessage {
  return {
    type: 'user',
    id,
    turnId,
    ts: 1,
    text,
  };
}

function storedAssistantMessage(id: string, turnId: string, text: string): StoredMessage {
  return {
    type: 'assistant',
    id,
    turnId,
    ts: 2,
    text,
    modelId: 'claude-sonnet-4-5',
  };
}

async function runSignalExitProbe(
  signalToSend: NodeJS.Signals,
  hangOuterCleanup = false,
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
}> {
  const runnerUrl = new URL('../pi-tui-runner.js', import.meta.url).href;
  const cliUrl = new URL('../cli-core.js', import.meta.url).href;
  const terminalUrl = new URL('./tui-terminal-mock.js', import.meta.url).href;
  const childSource = `
    import { runMakaPiTui } from ${JSON.stringify(runnerUrl)};
    import { beginMakaCliExit } from ${JSON.stringify(cliUrl)};
    import { FakeTerminal } from ${JSON.stringify(terminalUrl)};

    class ReportingTerminal extends FakeTerminal {
      stop() {
        process.stdout.write('TERMINAL_STOP\\n');
        super.stop();
      }
    }

    const terminal = new ReportingTerminal();
    const turnActivity = {
      activities: {},
    };
    const driver = {
      async preparePrompt() { throw new Error('unused'); },
      async *compactSession() {},
      async stop() {},
      async listSessions() { return []; },
      async respondToSandboxBoundary() {},
      async renameSession() {},
      async setModel() {},
      async setPermissionMode() {},
      async setThinkingLevel() {},
      async switchSession() { throw new Error('unused'); },
      async listRewindTargets() { return []; },
      async rewindToTurn() { throw new Error('unused'); },
      startNewSession() {},
      getSessionId() { return null; },
    };
    const hold = setInterval(() => {}, 1_000);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'test-model',
      connectionSlug: 'test-connection',
      permissionMode: 'ask',
      terminal,
      turnActivity,
      onProcessExit: (exitCode) => beginMakaCliExit(exitCode),
    });
    process.stdout.write('READY\\n');
    await run;
    process.stdout.write('CLOSED\\n');
    if (${hangOuterCleanup}) await new Promise(() => {});
    clearInterval(hold);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let signalSent = false;
  // Cold-start guard: spawning Node and synchronously importing the TUI stack
  // (runner, driver, shell-run manager) can take well over 5 s on a loaded CI
  // runner before READY is ever flushed, so the pre-READY budget must be a
  // generous backstop against a child that never becomes ready, not a tight
  // deadline. The precise budget starts once READY arrives, below.
  let killTimer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (!signalSent && stdout.includes('READY')) {
      signalSent = true;
      child.kill(signalToSend);
      // Time the kill against the signal handling window, not the child's
      // startup: the post-signal path is synchronous (terminal restore, TUI
      // stop, resolve, exit), so a few seconds is ample once READY is in; the
      // 3s exit grace (beginMakaCliExit) plus the pre-READY startup must not
      // share a single 5s budget or a slow CI runner gets SIGKILLed before the
      // graceful exit it is asserting.
      clearTimeout(killTimer);
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }
  });

  const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
  clearTimeout(killTimer);
  return { code, signal, stdout };
}

async function runFatalExitProbe(
  kind: 'uncaughtException' | 'unhandledRejection',
  hangOuterCleanup = false,
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const runnerUrl = new URL('../pi-tui-runner.js', import.meta.url).href;
  const cliUrl = new URL('../cli-core.js', import.meta.url).href;
  const terminalUrl = new URL('./tui-terminal-mock.js', import.meta.url).href;
  const trigger =
    kind === 'uncaughtException'
      ? "setImmediate(() => { throw new Error('fatal probe'); });"
      : "void Promise.reject(new Error('fatal probe'));";
  const childSource = `
    import { runMakaPiTui } from ${JSON.stringify(runnerUrl)};
    import { beginMakaCliExit, formatMakaCliFatalError } from ${JSON.stringify(cliUrl)};
    import { FakeTerminal } from ${JSON.stringify(terminalUrl)};

    class ReportingTerminal extends FakeTerminal {
      stop() {
        process.stdout.write('TERMINAL_STOP\\n');
        super.stop();
      }
    }

    const terminal = new ReportingTerminal();
    const turnActivity = {
      activities: {},
    };
    const driver = {
      async preparePrompt() { throw new Error('unused'); },
      async *compactSession() {},
      async stop() {},
      async listSessions() { return []; },
      async respondToSandboxBoundary() {},
      async renameSession() {},
      async setModel() {},
      async setPermissionMode() {},
      async setThinkingLevel() {},
      async switchSession() { throw new Error('unused'); },
      async listRewindTargets() { return []; },
      async rewindToTurn() { throw new Error('unused'); },
      startNewSession() {},
      getSessionId() { return null; },
    };
    const hold = setInterval(() => {}, 1_000);
    let fatalError;
    try {
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'test-model',
        connectionSlug: 'test-connection',
        permissionMode: 'ask',
        terminal,
        turnActivity,
        onProcessExit: (exitCode, error) => {
          if (error) process.stderr.write(\`${'${formatMakaCliFatalError(error)}'}\\n\`);
          beginMakaCliExit(exitCode);
        },
      });
      process.stdout.write('READY\\n');
      ${trigger}
      await run;
    } catch (error) {
      fatalError = error;
    }
    process.stdout.write('CLOSED\\n');
    if (${hangOuterCleanup}) await new Promise(() => {});
    if (fatalError) process.stderr.write(\`${'${formatMakaCliFatalError(fatalError)}'}\\n\`);
    clearInterval(hold);
  `;
  const nodeArgs = kind === 'unhandledRejection' ? ['--unhandled-rejections=warn'] : [];
  const child = spawn(process.execPath, [...nodeArgs, '--input-type=module', '-e', childSource], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let childReady = false;
  // Same two-budget scheme as runSignalExitProbe: a generous 30 s pre-READY
  // backstop for cold starts on loaded CI runners, then a tight 5 s budget
  // for the post-READY fatal path (which is synchronous and needs at most the
  // 3 s exit grace from beginMakaCliExit).
  let killTimer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    // Same reasoning as runSignalExitProbe: the fatal trigger fires right
    // after READY, and the process needs the 3s exit grace after that; on a
    // slow CI runner the pre-READY startup must not eat into that budget.
    if (!childReady && stdout.includes('READY')) {
      childReady = true;
      clearTimeout(killTimer);
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
  clearTimeout(killTimer);
  return { code, signal, stdout, stderr };
}
