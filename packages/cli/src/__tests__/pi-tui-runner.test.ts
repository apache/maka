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
import {
  type QueueEnqueueOutcome,
  type SessionEvent,
  type ShellRunUpdate,
} from '@maka/core/events';
import { type SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import { type SessionSummary, type StoredMessage } from '@maka/core/session';
import { type ThinkingLevel } from '@maka/core/model-thinking';
import { type UserQuestionResponse } from '@maka/core/user-question';
import type { SkillInvocationResult } from '@maka/core/skill-invocation';
import { SessionActivityRegistry } from '@maka/runtime/goal-turn-lifecycle';
import { type ContextDiagnostics } from '@maka/runtime/context-diagnostics';
import type {
  MakaPreparePromptOptions,
  MakaPreparedSessionTurn,
  MakaAttachedSessionTurn,
  MakaSessionMoveResult,
  MakaSessionDriver,
  MakaSessionRewindResult,
  MakaSessionSwitchOptions,
  MakaSessionSwitchResult,
  RewindTarget,
  SessionResumeAvailability,
} from '../session-driver.js';
import { SkillInvocationBlockedError } from '../session-driver.js';
import { listApiKeyOnboardableProviders } from '../onboarding-catalog.js';
import type {
  MakaOnboardingSurface,
  MakaPiTuiTurnActivitySurface,
  ModelChoice,
  OnboardingProviderEntry,
  OnboardingSaveResult,
  OnboardingVerifyResult,
} from '../pi-tui-contracts.js';
import type { ModelInfo, ProviderType } from '@maka/core/llm-connections';
import {
  resolveTaskbarProgress,
  runMakaPiTui as runMakaPiTuiImpl,
  type MakaPiTuiInput,
} from '../pi-tui-runner.js';
import { AUTO_RECAP_IDLE_MS } from '../session-recap.js';
import { BUSY_SPINNER_FRAMES } from '../tui-attention.js';
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

/** Catalog API-key providers as wizard entries with no existing connection —
 *  the default `/setup` provider list for tests that don't need 已设置 state. */
function defaultOnboardingProviders(): OnboardingProviderEntry[] {
  return listApiKeyOnboardableProviders().map((provider) => ({
    ...provider,
    hasConnection: false,
    enabledModelIds: [],
  }));
}

interface FakeOnboardingOpts {
  providers?: OnboardingProviderEntry[];
  verify?: (input: {
    providerType: ProviderType;
    apiKey?: string;
  }) => Promise<OnboardingVerifyResult>;
  save?: (input: {
    providerType: ProviderType;
    apiKey?: string;
    enabledModelIds: readonly string[];
    models: readonly ModelInfo[];
  }) => Promise<OnboardingSaveResult>;
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
    save: opts.save ?? (async () => ({ kind: 'ok', modelChoices: [] })),
  };
}

describe('Maka Pi TUI runner', () => {
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
    await waitFor(() => driver.prompts.length === 1);
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
    assert.ok(totalCommands > autocompleteSuggestionLines(screen).length);
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
      return autocompleteSuggestionLines(current).length === totalCommands;
    });
    screen = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
    assert.equal(
      screen.some((line) => /^\s*\(\d+\/\d+\)\s*$/.test(line)),
      false,
    );
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
      terminal,
      onboarding: fakeOnboardingSurface({
        verify: async (input) => {
          verifyCalls.push(input.apiKey ?? '');
          return verifyCalls.length === 1
            ? { kind: 'error', text: 'HTTP 401 Unauthorized' }
            : { kind: 'ok', models: [{ id: 'gpt-5.5' }] };
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
    terminal.input('sk-bad');
    terminal.input('\r');
    await waitFor(() => verifyCalls.length === 1);
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), '验证失败') !== null;
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
        return latestPlainLineContaining(terminal.writes.join(''), 'Onboarding 不可用') !== null;
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
        save: async () => ({ kind: 'ok', modelChoices: [] }),
      },
    });

    await waitForTuiPaint(terminal);
    terminal.input('/setup');
    terminal.input('\r');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('storage read failed'),
    );
    assert.doesNotMatch(
      plainTerminalOutput(terminal.screenOutput()),
      /没有可配置的 API key 类供应商/,
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
        return latestPlainLineContaining(terminal.writes.join(''), '验证') !== null;
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
    resolveFirst({ kind: 'error', text: 'HTTP 401 Unauthorized' });
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

  test('wizard ignores a save result from an abandoned attempt', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const saveCalls: Array<{ enabledModelIds: readonly string[] }> = [];
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
            : Promise.resolve<OnboardingSaveResult>({ kind: 'ok', modelChoices: [] });
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
        return latestPlainLineContaining(terminal.writes.join(''), '保存') !== null;
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
    // A's save now resolves ok. It must not show success or refresh choices.
    resolveFirstSave({ kind: 'ok', modelChoices: [] });
    // Sentinel render: typing into the key field forces a repaint that lands
    // after A's settled save continuation, so a wrongly-shown success frame
    // would be in this exact frame.
    terminal.input('sk-z');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('sk-z'));
    assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /已启用/);

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(CLOSE_BUDGET_MS).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('save refreshes the running model choices even when the user backs out during saving', async () => {
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
    // The save completes after the user left. The running TUI's ready model
    // choices are still authoritatively refreshed — abandoning the wizard only
    // drops the in-frame success UI, not the background state sync.
    resolveFirstSave({
      kind: 'ok',
      modelChoices: [
        {
          connectionSlug: 'openai',
          connectionName: 'OpenAI',
          providerType: 'openai',
          model: 'gpt-5.5-new',
          isDefaultConnection: true,
        },
      ],
    });
    // The refresh (`modelChoices = result.modelChoices`) lands in the save
    // promise's first continuation; one macrotask turn runs strictly after
    // every queued microtask, so the choices are applied by the time it fires.
    await delay(0);
    terminal.input('/model');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('gpt-5.5-new'));
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

  test('waits to start a visible turn until shared session activity releases', async () => {
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
    await delay(0);
    assert.deepEqual(driver.prompts, []);

    heartbeat.release();
    await waitFor(() => driver.prompts.length === 1);
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
    await delay(0);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await run;
    heartbeat.release();
    await delay(0);

    assert.deepEqual(driver.prompts, []);
    assert.equal(activities.whenIdle('session-1'), undefined);
  });

  test('flows a transcript taller than the viewport into scrollback, untruncated and un-paged', async () => {
    const terminal = new FakeTerminal();
    const driver = new LongTranscriptDriver();
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

    // No in-app pager: the removed scroll indicator and its PgUp/PgDn hint never
    // appear. History is scrolled through the terminal's own scrollback instead.
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
    // Only the followup that was still queued comes back into the editor; the
    // consumed steering text must not be resurrected from the stale mirror.
    await waitFor(() => {
      const screen = plainTerminalOutput(terminal.screenOutput());
      return screen.includes('still queued') && !screen.includes('already consumed');
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

  test('a fallback enqueue during a long turn is never dropped and flushes into the next turn', async () => {
    const terminal = new FakeTerminal();
    // Every enqueue reports `fallback` — the runtime never has a live owner.
    const driver = new FallbackSteeringDriver();
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

    terminal.input('second thought');
    terminal.input('\r'); // steer → fallback → CLI-held pending
    terminal.input('and afterwards');
    terminal.input('\x1b\r'); // Alt+Enter → fallback → CLI-held pending
    await waitFor(() => {
      const screen = plainTerminalOutput(terminal.screenOutput());
      return (
        screen.includes('Steering: second thought') && screen.includes('Queued: and afterwards')
      );
    });

    // The old bounded poll gave up after ~2s of busy (about 20 attempts at the
    // 100ms retry cadence) and silently dropped the text. Waiting for the
    // driver to observe the retries crossing that budget — instead of guessing
    // elapsed time — proves the CLI is still retrying under any scheduler load.
    await waitForUpTo(() => driver.steerAttempts > 22 && driver.queueAttempts > 22, 30_000);
    const screen = plainTerminalOutput(terminal.screenOutput());
    assert.equal(screen.includes('Steering: second thought'), true);
    assert.equal(screen.includes('Queued: and afterwards'), true);
    assert.deepEqual(driver.prompts, ['start the work']);

    // The turn boundary flushes the undelivered texts into the next turn.
    driver.endTurn();
    await waitFor(() => driver.prompts.length === 2);
    assert.equal(driver.prompts[1], 'second thought\n\nand afterwards');

    await waitForUpTo(() => driver.parked, 1_000);
    driver.endTurn();
    await waitFor(() => terminal.progressStates.at(-1) === false);
    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('a fallback steer retries the same enqueue and lands once the owner appears', async () => {
    const terminal = new FakeTerminal();
    const driver = new FallbackSteeringDriver();
    driver.steerFallbacks = 2; // the owner appears after ~200ms of retries
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

    terminal.input('late owner');
    terminal.input('\r'); // steer → fallback, retried until it lands
    await waitForUpTo(() => driver.steered.includes('late owner'), 1_000);
    // Landed as a steer of the RUNNING turn — no fresh turn was opened.
    assert.deepEqual(driver.prompts, ['start the work']);
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Steering: late owner'),
    );

    driver.endTurn();
    await waitFor(() => terminal.progressStates.at(-1) === false);
    // Nothing left to flush: the text was delivered mid-turn, not re-queued.
    assert.deepEqual(driver.prompts, ['start the work']);
    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('a turn boundary waits for an unresolved enqueue before deciding whether to flush it', async () => {
    const terminal = new FakeTerminal();
    const driver = new DeferredAdmissionDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'm',
      connectionSlug: 'c',
      permissionMode: 'bypass',
      terminal,
    });

    terminal.input('start');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);
    await waitForUpTo(() => driver.parked, 1_000);
    terminal.input('late admission');
    terminal.input('\r');
    await waitFor(() => driver.steerCalls === 1);

    driver.endTurn();
    await waitFor(() => driver.completedTurns === 1);
    assert.deepEqual(driver.prompts, ['start']);
    driver.releaseAdmission({ kind: 'fallback' });
    await waitForUpTo(() => driver.prompts.length === 2, 1_000);
    assert.equal(driver.prompts[1], 'late admission');

    await waitForUpTo(() => driver.parked, 1_000);
    driver.endTurn();
    await waitFor(() => terminal.progressStates.at(-1) === false);
    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('a queued retry settling at the turn boundary is not also flushed as a new turn', async () => {
    const terminal = new FakeTerminal();
    const driver = new DeferredRetryDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'm',
      connectionSlug: 'c',
      permissionMode: 'bypass',
      terminal,
    });

    terminal.input('start');
    terminal.input('\r');
    await waitFor(() => terminal.progressStates.at(-1) === true);
    terminal.input('lands on retry');
    terminal.input('\r');
    await waitForUpTo(() => driver.steerCalls === 2, 1_000);

    driver.endTurn();
    driver.releaseRetry();
    await waitFor(() => terminal.progressStates.at(-1) === false);
    assert.deepEqual(driver.prompts, ['start']);
    assert.deepEqual(driver.delivered, ['lands on retry']);

    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('interrupt refills CLI-held fallback text into the editor', async () => {
    const terminal = new FakeTerminal();
    const driver = new FallbackSteeringDriver();
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

    terminal.input('rescue me');
    terminal.input('\r'); // steer → fallback → CLI-held pending
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Steering: rescue me'),
    );

    terminal.input('\x1b');
    terminal.input('\x1b'); // interrupt
    await waitFor(() => terminal.progressStates.at(-1) === false);
    // The CLI-held text comes back for re-editing; the pending bar clears.
    await waitFor(() => {
      const screen = plainTerminalOutput(terminal.screenOutput());
      return screen.includes('rescue me') && !screen.includes('Steering: rescue me');
    });

    terminal.input('\x03'); // clear the refilled draft
    terminal.input('/exit');
    terminal.input('\r');
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

  test('an aborted turn never auto-opens the flush turn; undelivered text becomes a draft', async () => {
    const terminal = new FakeTerminal();
    const driver = new FallbackSteeringDriver(); // enqueues always fall back
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

    terminal.input('next thing');
    terminal.input('\x1b\r'); // Alt+Enter → fallback → CLI-held pending
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('Queued: next thing'),
    );

    // The turn ends as ABORTED on its own (not via the CLI interrupt path):
    // the boundary flush must not open a turn the user just stopped.
    driver.abortNextTurn = true;
    driver.endTurn();
    await waitFor(() => terminal.progressStates.at(-1) === false);
    // The undelivered text is an editable draft, not a queued line.
    await waitFor(() => {
      const screen = plainTerminalOutput(terminal.screenOutput());
      return screen.includes('next thing') && !screen.includes('Queued: next thing');
    });

    terminal.input('\x03'); // clear the preserved draft
    terminal.input('/exit');
    terminal.input('\r');
    await run;
    // Anchored after close: a wrongly-opened flush turn would have landed in
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
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'gpt-5.5',
      connectionSlug: 'openai',
      providerType: 'openai',
      modelChoices: [
        {
          connectionSlug: 'openai',
          connectionName: 'OpenAI',
          providerType: 'openai',
          model: 'gpt-5.5',
          isDefaultConnection: true,
        },
        {
          connectionSlug: 'zai',
          connectionName: 'Z.ai',
          providerType: 'openai',
          model: 'glm-5.2',
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
    await waitFor(() => terminal.output().includes('glm-5.2'));
    assert.match(
      plainTerminalOutput(terminal.screenOutput()),
      /切换模型可能需要重建提示缓存；下一次请求可能更慢或成本更高/,
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
        'Model changed: gpt-5.5 (OpenAI) → glm-5.2 (Z.ai)',
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
          isDefaultConnection: true,
        },
        {
          connectionSlug: 'beta',
          connectionName: 'Boreal',
          providerType: 'zai',
          model: 'glm-max',
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
      return out.includes('gpt-5.5') && out.includes('glm-max') && out.includes('text-unicorn');
    });
    assert.doesNotMatch(
      plainTerminalOutput(terminal.screenOutput()),
      /切换模型可能需要重建提示缓存/,
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
      { query: 'gpt', keep: 'gpt-5.5', drop: ['glm-max', 'text-unicorn'] },
      { query: 'aurora', keep: 'gpt-5.5', drop: ['glm-max', 'text-unicorn'] },
      { query: 'alpha', keep: 'gpt-5.5', drop: ['glm-max', 'text-unicorn'] },
      { query: 'zai', keep: 'glm-max', drop: ['gpt-5.5', 'text-unicorn'] },
      { query: 'gemini', keep: 'text-unicorn', drop: ['gpt-5.5', 'glm-max'] },
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
        return out.includes('gpt-5.5') && out.includes('glm-max') && out.includes('text-unicorn');
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
      connectionSlug: 'openai',
      providerType: 'openai',
      modelChoices: [
        {
          connectionSlug: 'openai',
          connectionName: 'OpenAI',
          providerType: 'openai',
          model: 'gpt-5.5',
          isDefaultConnection: true,
        },
        {
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
      /切换模型可能需要重建提示缓存/,
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
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'shared-model',
      connectionSlug: 'primary',
      providerType: 'openai',
      modelChoices: [
        {
          connectionSlug: 'primary',
          connectionName: 'Primary',
          providerType: 'openai',
          model: 'shared-model',
          isDefaultConnection: true,
        },
        {
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
        'Model changed: shared-model (Primary) → shared-model (Relay)',
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
        permissionCeiling: 'ask' as const,
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
    assert.match(
      plainTerminalOutput(terminal.screenOutput()),
      /Local Read.*subagent:local_read active/,
    );

    terminal.input('\x1b[B');
    terminal.input('\r');
    await waitFor(() => driver.sessionIds.includes(child.id));

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
    const terminal = new FakeTerminal();
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

  test('shows a session without a cwd in All but prevents resuming it', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver([
      fakeSessionSummary('session-current', '/repo', 'Current chat'),
      { ...fakeSessionSummary('session-legacy', '/repo', 'Legacy chat'), cwd: undefined },
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
      /Legacy chat.*Missing working directory/,
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
    assert.deepEqual(driver.shellRunReads, ['session-1']);

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

class RejectingStopDriver implements MakaSessionDriver {
  stopCalls = 0;

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    return prepareTestPrompt(this, prompt);
  }

  async *promptEvents(_prompt: string): AsyncIterable<never> {}
  async *compactSession(): AsyncIterable<never> {}

  async stop(): Promise<void> {
    this.stopCalls += 1;
    throw new Error('stop failed');
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
  startNewSession(): void {}
  getSessionId(): string {
    return 'session-1';
  }
}

class SandboxBoundaryPromptDriver implements MakaSessionDriver {
  readonly boundaryResponses: SandboxBoundaryResponse[] = [];
  boundaryRequests = 0;
  stopCalls = 0;
  private boundaryResponseWaiter: (() => void) | null = null;

  constructor(
    private readonly paths: readonly string[] = ['/outside'],
    private readonly beforeBoundaryAck: (index: number) => Promise<void> = async () => {},
    private readonly beforeBoundaryRequest: (index: number) => Promise<void> = async () => {},
  ) {}

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    return prepareTestPrompt(this, prompt);
  }

  async *compactSession(): AsyncIterable<never> {}

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
  startNewSession(): void {}
  getSessionId(): string {
    return 'session-1';
  }
}

class UserQuestionPromptDriver implements MakaSessionDriver {
  readonly responses: UserQuestionResponse[] = [];
  stopCalls = 0;
  private release: (() => void) | undefined;

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }
  preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    return prepareTestPrompt(this, prompt);
  }
  async *compactSession(): AsyncIterable<never> {}
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
    throw new Error('rewind not supported');
  }
  startNewSession(): void {}
  getSessionId(): string {
    return 'session-1';
  }
}

class InterruptibleTurnDriver implements MakaSessionDriver {
  stopCalls = 0;
  readonly prompts: string[] = [];
  private releaseTurn: (() => void) | null = null;

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    this.prompts.push(prompt);
    return prepareTestPrompt(this, prompt);
  }

  async *compactSession(): AsyncIterable<never> {}

  async *promptEvents(_prompt: string): AsyncIterable<SessionEvent> {
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
  startNewSession(): void {}
  getSessionId(): string {
    return 'session-1';
  }
}

// A parking turn plus an in-memory steering/followup mirror, so the runner's
// keybindings (Enter steer, Alt+Enter queue, Alt+↑ retract, Esc Esc refill) can
// be exercised end-to-end without a real runtime.
class SteeringTurnDriver implements MakaSessionDriver {
  stopCalls = 0;
  readonly steered: string[] = [];
  readonly queuedMessages: string[] = [];
  readonly turnOrchestrations: Array<MakaPreparePromptOptions['turnOrchestration']> = [];
  retractCalls = 0;
  private steering: string[] = [];
  private followup: string[] = [];
  private pendingEvents: SessionEvent[] = [];
  private wakeTurn: (() => void) | null = null;
  private turnEnded = false;
  private eventSeq = 0;

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  preparePrompt(
    prompt: string,
    options: MakaPreparePromptOptions = {},
  ): Promise<MakaPreparedSessionTurn> {
    const turnId = options.turnId ?? 'turn-1';
    this.turnOrchestrations.push(options.turnOrchestration);
    return Promise.resolve({
      sessionId: this.getSessionId(),
      turnId,
      events: this.promptEvents(prompt, turnId),
    });
  }

  async *compactSession(): AsyncIterable<never> {}

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
      steering: [...this.steering],
      followup: [...this.followup],
    });
    this.wakeTurn?.();
    this.wakeTurn = null;
  }

  async *promptEvents(_prompt: string, turnId: string): AsyncIterable<SessionEvent> {
    this.turnEnded = false;
    for (;;) {
      while (this.pendingEvents.length > 0) yield this.pendingEvents.shift()!;
      if (this.turnEnded) break;
      await new Promise<void>((resolve) => {
        this.wakeTurn = resolve;
      });
    }
    yield { type: 'abort', id: 'event-abort', turnId, ts: 1, reason: 'user_stop' };
    yield { type: 'complete', id: 'event-complete', turnId, ts: 2, stopReason: 'user_stop' };
  }

  async steer(text: string): Promise<QueueEnqueueOutcome> {
    this.steered.push(text);
    this.steering.push(text);
    this.emitQueueUpdate();
    return { kind: 'queued' };
  }

  async queueMessage(text: string): Promise<QueueEnqueueOutcome> {
    this.queuedMessages.push(text);
    this.followup.push(text);
    this.emitQueueUpdate();
    return { kind: 'queued' };
  }

  async takePendingFollowup(): Promise<string | null> {
    if (this.followup.length === 0) return null;
    const joined = this.followup.join('\n\n');
    this.followup = [];
    return joined;
  }

  async retractQueued(): Promise<string> {
    this.retractCalls += 1;
    const joined = [...this.steering, ...this.followup].join('\n\n');
    this.steering = [];
    this.followup = [];
    this.emitQueueUpdate();
    return joined;
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
  startNewSession(): void {}
  getSessionId(): string {
    return 'session-1';
  }
}

/**
 * A driver whose enqueues hit the no-live-owner `fallback` outcome for the
 * first N calls (configurable, default forever) while the turn parks until
 * `endTurn()` — the begin-window shape behind review finding N2.
 */
class FallbackSteeringDriver implements MakaSessionDriver {
  readonly prompts: string[] = [];
  readonly steered: string[] = [];
  readonly queuedMessages: string[] = [];
  stopCalls = 0;
  completedTurns = 0;
  /** Enqueue calls that report `fallback` before the owner "appears". */
  steerFallbacks = Number.POSITIVE_INFINITY;
  queueFallbacks = Number.POSITIVE_INFINITY;
  /** Total enqueue attempts, including rejected ones — the observable retry count. */
  steerAttempts = 0;
  queueAttempts = 0;
  private steering: string[] = [];
  private followup: string[] = [];
  private pendingEvents: SessionEvent[] = [];
  private wakeTurn: (() => void) | null = null;
  private turnOpen = false;
  private turnEnded = false;
  private eventSeq = 0;

  get parked(): boolean {
    return this.turnOpen && !this.turnEnded;
  }

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  preparePrompt(
    prompt: string,
    options: MakaPreparePromptOptions = {},
  ): Promise<MakaPreparedSessionTurn> {
    this.prompts.push(options.modelText ?? prompt);
    const turnId = options.turnId ?? `turn-${this.prompts.length}`;
    return Promise.resolve({
      sessionId: this.getSessionId(),
      turnId,
      events: this.promptEvents(turnId),
    });
  }

  async *compactSession(): AsyncIterable<never> {}

  // Same single-path contract as the runtime: queue contents reach the CLI
  // only through `queue_update` events on the turn stream.
  private emitQueueUpdate(): void {
    this.eventSeq += 1;
    this.pendingEvents.push({
      type: 'queue_update',
      id: `queue-update-${this.eventSeq}`,
      turnId: `turn-${this.prompts.length}`,
      ts: this.eventSeq,
      steering: [...this.steering],
      followup: [...this.followup],
    });
    this.wakeTurn?.();
    this.wakeTurn = null;
  }

  async *promptEvents(turnId: string): AsyncIterable<SessionEvent> {
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
    if (this.abortNextTurn) {
      this.abortNextTurn = false;
      yield {
        type: 'abort',
        id: `abort-${this.prompts.length}`,
        turnId,
        ts: 1,
        reason: 'user_stop',
      };
      yield {
        type: 'complete',
        id: `complete-${this.prompts.length}`,
        turnId,
        ts: 2,
        stopReason: 'user_stop',
      };
      this.completedTurns += 1;
      return;
    }
    yield {
      type: 'complete',
      id: `complete-${this.prompts.length}`,
      turnId,
      ts: 1,
      stopReason: 'end_turn',
    };
    this.completedTurns += 1;
  }

  /** Next endTurn() finishes the turn as aborted instead of end_turn. */
  abortNextTurn = false;

  async steer(text: string): Promise<QueueEnqueueOutcome> {
    this.steerAttempts += 1;
    if (this.steerFallbacks > 0) {
      this.steerFallbacks -= 1;
      return { kind: 'fallback' };
    }
    this.steered.push(text);
    this.steering.push(text);
    this.emitQueueUpdate();
    return { kind: 'queued' };
  }

  async queueMessage(text: string): Promise<QueueEnqueueOutcome> {
    this.queueAttempts += 1;
    if (this.queueFallbacks > 0) {
      this.queueFallbacks -= 1;
      return { kind: 'fallback' };
    }
    this.queuedMessages.push(text);
    this.followup.push(text);
    this.emitQueueUpdate();
    return { kind: 'queued' };
  }

  async takePendingFollowup(): Promise<string | null> {
    if (this.followup.length === 0) return null;
    const joined = this.followup.join('\n\n');
    this.followup = [];
    return joined;
  }

  async retractQueued(): Promise<string> {
    const joined = [...this.steering, ...this.followup].join('\n\n');
    this.steering = [];
    this.followup = [];
    this.emitQueueUpdate();
    return joined;
  }

  endTurn(): void {
    this.turnEnded = true;
    this.wakeTurn?.();
    this.wakeTurn = null;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.steering = [];
    this.followup = [];
    this.endTurn();
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
  startNewSession(): void {}
  getSessionId(): string {
    return 'session-1';
  }
}

class DeferredAdmissionDriver extends FallbackSteeringDriver {
  steerCalls = 0;
  readonly #admission = deferred<QueueEnqueueOutcome>();

  override async steer(_text: string): Promise<QueueEnqueueOutcome> {
    this.steerCalls += 1;
    return this.#admission.promise;
  }

  releaseAdmission(outcome: QueueEnqueueOutcome): void {
    this.#admission.resolve(outcome);
  }
}

class DeferredRetryDriver extends FallbackSteeringDriver {
  steerCalls = 0;
  readonly delivered: string[] = [];
  readonly #retry = deferred<void>();

  override async steer(text: string): Promise<QueueEnqueueOutcome> {
    this.steerCalls += 1;
    if (this.steerCalls === 1) return { kind: 'fallback' };
    await this.#retry.promise;
    this.delivered.push(text);
    return { kind: 'queued' };
  }

  releaseRetry(): void {
    this.#retry.resolve();
  }
}

class SlowStopDriver implements MakaSessionDriver {
  stopCalls = 0;
  readonly prompts: string[] = [];
  private releaseTurn: (() => void) | null = null;

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    this.prompts.push(prompt);
    return prepareTestPrompt(this, prompt);
  }

  async *compactSession(): AsyncIterable<never> {}

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
  startNewSession(): void {}
  getSessionId(): string {
    return 'session-1';
  }
}

class ToolOutputDriver implements MakaSessionDriver {
  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    return prepareTestPrompt(this, prompt);
  }

  async *compactSession(): AsyncIterable<never> {}

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
  startNewSession(): void {}
  getSessionId(): string {
    return 'session-1';
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

class SlashCommandDriver implements MakaSessionDriver {
  /** Model-facing text (options.modelText when set, else the typed prompt). */
  readonly prompts: string[] = [];
  /** Human-facing typed prompt for every prepared turn. */
  readonly displayPrompts: string[] = [];
  readonly models: string[] = [];
  readonly modelConnections: Array<string | undefined> = [];
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
  contextDiagnosticsRequests = 0;
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
  ) {}

  async listSessions(): Promise<SessionSummary[]> {
    return this.sessions;
  }

  async getContextDiagnostics(): Promise<ContextDiagnostics> {
    this.contextDiagnosticsRequests += 1;
    return this.contextDiagnostics;
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

  async *promptEvents(_prompt: string, turnId = 'turn-1'): AsyncIterable<SessionEvent> {
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

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_response: SandboxBoundaryResponse): Promise<void> {}
  async setModel(model: string, connectionSlug?: string): Promise<void> {
    this.models.push(model);
    this.modelConnections.push(connectionSlug);
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
    return switchResult(nextSummary, [...(this.sessionMessages.get(nextSummary.id) ?? [])]);
  }
  async listRewindTargets(): Promise<RewindTarget[]> {
    return [];
  }
  async rewindToTurn(_turnId: string): Promise<MakaSessionRewindResult> {
    throw new Error('rewind not supported in this fake');
  }
  startNewSession(): void {
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

class HostSkillDriver extends SlashCommandDriver {
  constructor(private readonly skillInvocation: SkillInvocationResult) {
    super();
  }

  override async preparePrompt(
    prompt: string,
    options: MakaPreparePromptOptions = {},
  ): Promise<MakaPreparedSessionTurn> {
    if (this.skillInvocation.loaded.length === 0 && this.skillInvocation.failed.length > 0) {
      throw new SkillInvocationBlockedError(this.skillInvocation);
    }
    const turn = await super.preparePrompt(prompt, options);
    return { ...turn, skillInvocation: this.skillInvocation };
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

class HostSuccessorDriver extends SlashCommandDriver {
  #startedTurnListener: ((turn: MakaAttachedSessionTurn) => void) | undefined;
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

  subscribeStartedTurns(listener: (turn: MakaAttachedSessionTurn) => void): () => void {
    this.#startedTurnListener = listener;
    return () => {
      if (this.#startedTurnListener === listener) this.#startedTurnListener = undefined;
    };
  }

  publishSuccessor(): void {
    const turnId = 'turn-second';
    const driver = this;
    this.#startedTurnListener?.({
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

class DeferredControlDriver implements MakaSessionDriver {
  readonly prompts: string[] = [];
  readonly models: string[] = [];
  private resolveSetModel: (() => void) | null = null;

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    return prepareTestPrompt(this, prompt);
  }

  async *compactSession(): AsyncIterable<never> {}

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

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_response: SandboxBoundaryResponse): Promise<void> {}

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
  startNewSession(): void {}
  getSessionId(): string {
    return 'session-1';
  }
}

class RejectingSandboxBoundaryDriver implements MakaSessionDriver {
  readonly responses: SandboxBoundaryResponse[] = [];

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    return prepareTestPrompt(this, prompt);
  }

  async *compactSession(): AsyncIterable<never> {}

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

  async stop(): Promise<void> {}

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
  startNewSession(): void {}
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

class SandboxBoundaryThenErrorDriver implements MakaSessionDriver {
  respondCalls = 0;
  private resolveContinue: (() => void) | null = null;

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    return prepareTestPrompt(this, prompt);
  }

  async *compactSession(): AsyncIterable<never> {}

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

  async stop(): Promise<void> {}

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
  startNewSession(): void {}
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

function switchResult(
  summary: SessionSummary,
  messages: StoredMessage[] = [],
): MakaSessionSwitchResult {
  return { summary, messages };
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
