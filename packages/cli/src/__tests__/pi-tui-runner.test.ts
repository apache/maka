import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { before, describe, test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import {
  SHELL_RUN_UPDATE_BUFFER_MAX_ENTRIES,
  type PermissionMode,
  type OrchestrationMode,
  type QueueEnqueueOutcome,
  type SandboxBoundaryResponse,
  type SessionEvent,
  type SessionSummary,
  type StoredMessage,
  type ThinkingLevel,
  type UserQuestionResponse,
} from '@maka/core';
import {
  GoalManager,
  SessionActivityRegistry,
  type ContextDiagnostics,
  type GoalTurnOutcome,
  type ShellRunUpdate,
} from '@maka/runtime';
import type {
  MakaPreparePromptOptions,
  MakaPreparedSessionTurn,
  MakaSessionMoveResult,
  MakaSessionDriver,
  MakaSessionRewindResult,
  MakaSessionSwitchResult,
  RewindTarget,
  SessionResumeAvailability,
} from '../session-driver.js';
import { CliGoalContinuation, type CliGoalTurnHost } from '../cli-goal-continuation.js';
import type { ModelChoice } from '../connection-target.js';
import {
  listApiKeyOnboardableProviders,
  type MakaOnboardingSurface,
  type OnboardingProviderEntry,
  type OnboardingSaveResult,
  type OnboardingVerifyResult,
} from '../onboarding.js';
import type { ModelInfo, ProviderType } from '@maka/core/llm-connections';
import {
  runMakaPiTui as runMakaPiTuiImpl,
  type MakaPiTuiGoalLifecycle,
  type MakaPiTuiInput,
} from '../pi-tui-runner.js';
import { AUTO_RECAP_IDLE_MS } from '../session-recap.js';
import { _setColorLevelForTesting } from '../tui-ansi.js';
import { BUSY_SPINNER_FRAMES } from '../tui-attention.js';
import { arrangeAutocompleteAboveEditor } from '../tui-autocomplete-layout.js';
import {
  assertBottomPickerPlacement,
  autocompleteSuggestionLines,
  FakeTerminal,
  inputSurfaceRows,
  latestPlainLineContaining,
  plainTerminalOutput,
  waitFor,
} from './tui-terminal-mock.js';

// Pin truecolor so the accent-chrome escape assertion ("uses logo blue") is
// hermetic. Color level is detected from process.env.TERM/COLORTERM at module
// load, which varies between local (truecolor) and CI (unset/dumb) terminals.
before(() => _setColorLevelForTesting(3));

type TestMakaPiTuiInput = Omit<MakaPiTuiInput, 'driver' | 'goalLifecycle'> & {
  driver: MakaSessionDriver;
  goalLifecycle?: MakaPiTuiGoalLifecycle;
};

function runMakaPiTui(input: TestMakaPiTuiInput): Promise<void> {
  const { driver, goalLifecycle, ...rest } = input;
  return runMakaPiTuiImpl({
    ...rest,
    driver,
    goalLifecycle: goalLifecycle ?? createTestGoalLifecycle(),
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

function createTestGoalLifecycle(
  onSettled?: (sessionId: string, turnId: string, outcome: GoalTurnOutcome) => void,
  activities = new SessionActivityRegistry(),
  onHostChange?: (host: CliGoalTurnHost | undefined) => void,
): MakaPiTuiGoalLifecycle {
  return {
    activities,
    beginExternalTurn: (sessionId, turnId) => ({
      kind: 'registered',
      settle: async (outcome) => {
        onSettled?.(sessionId, turnId, outcome);
      },
    }),
    bindHost: (host) => {
      onHostChange?.(host);
      return () => {
        onHostChange?.(undefined);
      };
    },
  };
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
  test('restores the terminal before exiting on SIGTERM', async () => {
    const { code, signal, stdout } = await runSignalExitProbe('SIGTERM');

    assert.equal(signal, null);
    assert.equal(code, 143);
    assert.match(stdout, /TERMINAL_STOP/);
    assert.match(stdout, /CLOSED/);
  });

  test('restores the terminal before exiting on SIGHUP', async () => {
    const { code, signal, stdout } = await runSignalExitProbe('SIGHUP');

    assert.equal(signal, null);
    assert.equal(code, 129);
    assert.match(stdout, /TERMINAL_STOP/);
    assert.match(stdout, /CLOSED/);
  });

  test('restores the terminal before exiting on SIGINT', async () => {
    const { code, signal, stdout } = await runSignalExitProbe('SIGINT');

    assert.equal(signal, null);
    assert.equal(code, 130);
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

  test('reports and forces fatal exit when outer cleanup never settles', async () => {
    const { code, signal, stdout, stderr } = await runFatalExitProbe('uncaughtException', true);

    assert.equal(signal, null);
    assert.equal(code, 1);
    assert.match(stdout, /TERMINAL_STOP/);
    assert.match(stdout, /CLOSED/);
    assert.match(stderr, /fatal probe/);
  });

  test('restores the terminal before reporting an unhandled rejection', async () => {
    const { code, signal, stdout, stderr } = await runFatalExitProbe('unhandledRejection');

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
      delay(50).then(() => {
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

  test('/setup opens a provider picker listing API-key providers', async () => {
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
      onboarding: fakeOnboardingSurface(),
    });

    await delay(20);
    terminal.input('/setup');
    terminal.input('\r');

    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'Set Up Provider') !== null;
      } catch {
        return false;
      }
    });

    const output = plainTerminalOutput(terminal.screenOutput());
    assert.ok(
      output.includes('Anthropic') || output.includes('OpenAI'),
      'provider picker should list an API-key provider',
    );
    assert.ok(output.includes('1/3'), 'provider search is step 1/3');

    terminal.input('\x1b');
    await delay(30);
    terminal.input('/exit');
    terminal.input('\r');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close after /exit');
      }),
    ]);
  });

  test('/setup marks existing connections 已设置 in the provider search', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const providers = defaultOnboardingProviders().map((p) =>
      p.providerType === 'anthropic'
        ? { ...p, hasConnection: true, enabledModelIds: ['claude-sonnet-5'] }
        : p,
    );
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'bypass',
      terminal,
      onboarding: fakeOnboardingSurface({ providers }),
    });

    await delay(20);
    terminal.input('/setup');
    terminal.input('\r');
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'Set Up Provider') !== null;
      } catch {
        return false;
      }
    });
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('已设置'));

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('/setup verifies the key then shows the model multi-select', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const verifyCalls: Array<{ providerType: ProviderType; apiKey?: string }> = [];
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
          return { kind: 'ok', models: [{ id: 'gpt-5.5' }, { id: 'gpt-5.5-mini' }] };
        },
      }),
    });

    await delay(20);
    terminal.input('/setup');
    terminal.input('\r');
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'Set Up Provider') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('\r'); // pick the highlighted provider -> key phase
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'API key') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('sk-test');
    terminal.input('\r');
    await waitFor(() => verifyCalls.length === 1);
    assert.equal(verifyCalls[0]!.apiKey, 'sk-test');
    // Verify success advances to the searchable model multi-select (step 3/3).
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('3/3'));

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
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

    await delay(20);
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
      delay(500).then(() => {
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

    await delay(20);
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
    await delay(60);
    assert.equal(verifyCalls.length, 0);

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
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

    await delay(20);
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
      delay(500).then(() => {
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

    await delay(20);
    terminal.input('/setup');
    terminal.input('\r');
    await delay(60);
    const out = plainTerminalOutput(terminal.screenOutput());
    assert.match(out, /storage read failed/);
    assert.doesNotMatch(out, /没有可配置的 API key 类供应商/);

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('first-run picker cancel closes the TUI without configuring', async () => {
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
      onboarding: fakeOnboardingSurface(),
    });

    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'Set Up Provider') !== null;
      } catch {
        return false;
      }
    });
    // Esc cancels the picker; in first-run mode that closes the TUI (the host
    // sees no configured connection) rather than dropping into a driver-less editor.
    terminal.input('\x1b');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close on first-run picker cancel');
      }),
    ]);
  });

  test('first-run mode auto-opens the provider picker without typing /setup', async () => {
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
      onboarding: fakeOnboardingSurface(),
    });

    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'Set Up Provider') !== null;
      } catch {
        return false;
      }
    });

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('onboarding wizard filters the provider list as you type in the search field', async () => {
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
      onboarding: fakeOnboardingSurface(),
    });

    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'Set Up Provider') !== null;
      } catch {
        return false;
      }
    });
    const before = plainTerminalOutput(terminal.screenOutput());
    assert.ok(before.includes('Anthropic'));
    assert.ok(before.includes('DeepSeek'));

    // Typing in the wizard's search field filters the provider list live: the
    // unmatched providers leave the list while the match stays.
    terminal.input('anth');
    await waitFor(() => {
      const out = plainTerminalOutput(terminal.screenOutput());
      return out.includes('Anthropic') && !out.includes('DeepSeek');
    });

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('verify/saving status stays beside the input, out of the transcript', async () => {
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

    await delay(20);
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
    // A succeeding retry advances to the models step. The in-flight failure
    // status lived only in the overlay, so it leaves no residue in the transcript.
    terminal.input('sk-good');
    terminal.input('\r');
    await waitFor(() => verifyCalls.length === 2);
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('3/3'));
    assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /验证失败/);

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('key Esc returns to the provider search (step 1/3)', async () => {
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
      onboarding: fakeOnboardingSurface(),
    });

    await delay(20);
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
    // Esc from the key field returns to the search phase: the step marker is
    // back to 1/3 and the provider list is visible again.
    terminal.input('\x1b');
    await waitFor(() => {
      const out = plainTerminalOutput(terminal.screenOutput());
      return out.includes('1/3') && out.includes('Anthropic');
    });

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('models Esc returns to the key step (step 2/3)', async () => {
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
      onboarding: fakeOnboardingSurface(),
    });

    await delay(20);
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
    // Esc from the models step moves back exactly one level to the key step.
    terminal.input('\x1b');
    await waitFor(() => {
      const out = plainTerminalOutput(terminal.screenOutput());
      return out.includes('2/3') && out.includes('API key');
    });

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('models Space toggles selection; Enter saves at least one model', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
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
        save: async (input) => {
          saveCalls.push(input);
          return { kind: 'ok', modelChoices: [] };
        },
      }),
    });

    await delay(20);
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
    // A new connection starts with no models selected: Enter with 0 does not save.
    terminal.input('\r');
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), '至少选择一个模型') !== null;
      } catch {
        return false;
      }
    });
    assert.equal(saveCalls.length, 0);
    // Space toggles the highlighted model on; Enter then saves the selection.
    terminal.input(' ');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('已选 1 ·'));
    terminal.input('\r');
    await waitFor(() => saveCalls.length === 1);
    assert.deepEqual(saveCalls[0]!.enabledModelIds, ['gpt-5.5']);

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('models search field moves the cursor with arrow keys like the other fields', async () => {
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
      onboarding: fakeOnboardingSurface(),
    });

    await delay(20);
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
    terminal.input('gpt'); // type into the model search field
    await delay(30);
    terminal.input('\x1b[D'); // left arrow — should move the cursor left
    terminal.input('x'); // insert x at the cursor (before the t)
    await delay(30);
    const out = plainTerminalOutput(terminal.screenOutput());
    assert.ok(
      out.includes('gpxt'),
      'left arrow should move the cursor so x inserts before the final t',
    );
    assert.ok(!out.includes('gptx'), 'without the left arrow the x would append after t');

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('model search filters without discarding selections', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
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
        save: async (input) => {
          saveCalls.push(input);
          return { kind: 'ok', modelChoices: [] };
        },
      }),
    });

    await delay(20);
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
    terminal.input(' '); // toggle the first model on (gpt-5.5)
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('已选 1 ·'));
    // Filtering to 'mini' hides gpt-5.5, but its selection survives.
    terminal.input('mini');
    await waitFor(() => {
      const out = plainTerminalOutput(terminal.screenOutput());
      return (
        out.includes('gpt-5.5-mini') && !out.includes('☐ gpt-5.5 ') && !out.includes('☑ gpt-5.5 ')
      );
    });
    terminal.input(' '); // toggle gpt-5.5-mini on while filtered
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('已选 2 ·'));
    terminal.input('\r');
    await waitFor(() => saveCalls.length === 1);
    // Both selections reach save — the filtered-out gpt-5.5 was not discarded.
    assert.deepEqual(saveCalls[0]!.enabledModelIds, ['gpt-5.5', 'gpt-5.5-mini']);

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('existing connection preserves its enabled set; new starts empty', async () => {
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
      onboarding: fakeOnboardingSurface({
        providers: defaultOnboardingProviders().map((p) =>
          p.providerType === 'anthropic'
            ? { ...p, hasConnection: true, enabledModelIds: ['claude-sonnet-5'] }
            : p,
        ),
        verify: async () => ({
          kind: 'ok',
          models: [{ id: 'claude-sonnet-5' }, { id: 'claude-haiku-5' }],
        }),
      }),
    });

    await delay(20);
    terminal.input('/setup');
    terminal.input('\r');
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'Set Up Provider') !== null;
      } catch {
        return false;
      }
    });
    // anthropic may not be the first provider, so filter to it then pick it.
    terminal.input('anth');
    await waitFor(() => {
      const out = plainTerminalOutput(terminal.screenOutput());
      return out.includes('Anthropic') && !out.includes('DeepSeek');
    });
    terminal.input('\r'); // pick anthropic -> key phase
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'API key') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('\r'); // blank key reuses the stored secret -> verify -> models
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('3/3'));
    // The existing enabled set (claude-sonnet-5) is pre-selected.
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('已选 1 ·'));

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('blank key for an existing connection reuses the stored secret', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const verifyCalls: Array<{ apiKey?: string }> = [];
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'bypass',
      terminal,
      onboarding: fakeOnboardingSurface({
        providers: defaultOnboardingProviders().map((p) =>
          p.providerType === 'anthropic'
            ? { ...p, hasConnection: true, enabledModelIds: ['claude-sonnet-5'] }
            : p,
        ),
        verify: async (input) => {
          verifyCalls.push(input);
          return { kind: 'ok', models: [{ id: 'claude-sonnet-5' }] };
        },
      }),
    });

    await delay(20);
    terminal.input('/setup');
    terminal.input('\r');
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'Set Up Provider') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('anth');
    await waitFor(() => {
      const out = plainTerminalOutput(terminal.screenOutput());
      return out.includes('Anthropic') && !out.includes('DeepSeek');
    });
    terminal.input('\r'); // pick anthropic -> key phase
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'API key') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('\r'); // blank submit reuses the stored secret
    await waitFor(() => verifyCalls.length === 1);
    assert.equal(verifyCalls[0]!.apiKey, '');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('3/3'));

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('key rotation passes the new key to verify and save', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const verifyCalls: Array<{ apiKey?: string }> = [];
    const saveCalls: Array<{ apiKey?: string; enabledModelIds: readonly string[] }> = [];
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'bypass',
      terminal,
      onboarding: fakeOnboardingSurface({
        providers: defaultOnboardingProviders().map((p) =>
          p.providerType === 'anthropic'
            ? { ...p, hasConnection: true, enabledModelIds: ['claude-sonnet-5'] }
            : p,
        ),
        verify: async (input) => {
          verifyCalls.push(input);
          return { kind: 'ok', models: [{ id: 'claude-sonnet-5' }, { id: 'claude-haiku-5' }] };
        },
        save: async (input) => {
          saveCalls.push(input);
          return { kind: 'ok', modelChoices: [] };
        },
      }),
    });

    await delay(20);
    terminal.input('/setup');
    terminal.input('\r');
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'Set Up Provider') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('anth');
    await waitFor(() => {
      const out = plainTerminalOutput(terminal.screenOutput());
      return out.includes('Anthropic') && !out.includes('DeepSeek');
    });
    terminal.input('\r'); // pick anthropic -> key phase
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'API key') !== null;
      } catch {
        return false;
      }
    });
    terminal.input('sk-rotated');
    terminal.input('\r');
    await waitFor(() => verifyCalls.length === 1);
    assert.equal(verifyCalls[0]!.apiKey, 'sk-rotated');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('3/3'));
    // The preserved enabled set already satisfies the minimum, so Enter saves.
    terminal.input('\r');
    await waitFor(() => saveCalls.length === 1);
    assert.equal(saveCalls[0]!.apiKey, 'sk-rotated');
    assert.deepEqual(saveCalls[0]!.enabledModelIds, ['claude-sonnet-5']);

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('save refreshes the running TUI model choices, shows success in-frame, and does not switch the session', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
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
        save: async (input) => {
          saveCalls.push(input);
          return {
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
          };
        },
      }),
    });

    await delay(20);
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
    terminal.input('\r'); // save
    await waitFor(() => saveCalls.length === 1);
    // Success shows the enabled-model count in-frame; no transcript setup Note.
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('已启用 1 个模型'));
    assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /已配置/);
    terminal.input('\r'); // close the in-frame success
    await delay(40);
    // The refreshed ready model choices are immediately available from /model.
    terminal.input('/model');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('gpt-5.5-new'));
    // Setup never switched the active session (no setModel call).
    assert.deepEqual(driver.models, []);

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('first-run setup save closes the TUI so the host re-resolves the new default', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const saveCalls: Array<{ enabledModelIds: readonly string[] }> = [];
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
        save: async (input) => {
          saveCalls.push(input);
          return { kind: 'ok', modelChoices: [] };
        },
      }),
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
    terminal.input('sk-test');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('3/3'));
    terminal.input(' '); // toggle the first model on
    terminal.input('\r'); // save -> first-run closes the TUI for re-entry
    await waitFor(() => saveCalls.length === 1);
    // The wizard does not show an in-frame success on first run; it closes so the
    // host re-resolves the now-configured default connection and relaunches.
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('first-run TUI did not close after save');
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

    await delay(20);
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
    await delay(40);

    const out = plainTerminalOutput(terminal.screenOutput());
    assert.doesNotMatch(out, /验证失败/);
    assert.ok(out.includes('sk-b'));

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(500).then(() => {
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

    await delay(20);
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
    await delay(40);
    assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /已启用/);

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(500).then(() => {
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

    await delay(20);
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
    await delay(30);
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
    await delay(40);
    terminal.input('/model');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('gpt-5.5-new'));
    assert.deepEqual(driver.models, []);

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(500).then(() => {
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
    await delay(40);
    assert.equal(preparePromptCalls, 0);
    // The wizard is back open as the only first-run surface.
    assert.ok(plainTerminalOutput(terminal.screenOutput()).includes('Set Up Provider'));

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('first-run wizard reopens on Alt+Enter after a slash escape (no agent turn)', async () => {
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

    // Slash escapes and closes the wizard; Alt+Enter must go through the same
    // submitPrompt choke point as Enter and reopen the wizard, not hand the
    // prompt to a connection-less driver.
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
    terminal.input('\x1b\r'); // Alt+Enter
    await delay(40);
    assert.equal(preparePromptCalls, 0);
    assert.ok(plainTerminalOutput(terminal.screenOutput()).includes('Set Up Provider'));

    process.emit('SIGTERM');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close after SIGTERM');
      }),
    ]);
  });

  test('first-run /exit in the main editor after a slash escape still exits the TUI', async () => {
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

    // Slash escape in the key field closes the wizard and shows help.
    terminal.input('/help');
    terminal.input('\r');
    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'Keybindings') !== null;
      } catch {
        return false;
      }
    });

    // Now the main editor is active. /exit must reach the command layer, not
    // be swallowed by the first-run guard that would reopen the wizard.
    terminal.input('/exit');
    terminal.input('\r');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('/exit did not close the first-run TUI');
      }),
    ]);
  });

  test('onboarding wizard cancels on Ctrl+C as well as Esc (first-run closes the TUI)', async () => {
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
      onboarding: fakeOnboardingSurface(),
    });

    await waitFor(() => {
      try {
        return latestPlainLineContaining(terminal.writes.join(''), 'Set Up Provider') !== null;
      } catch {
        return false;
      }
    });

    // The overlay cancel contract is Esc AND Ctrl+C (pi-tui `tui.select.cancel`);
    // in first-run, Ctrl+C must close the TUI like Esc does, not be swallowed.
    terminal.input('\x03');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('Ctrl+C did not close the first-run wizard');
      }),
    ]);
  });

  test('onboarding wizard key-phase Ctrl+C cancels while Esc returns to search', async () => {
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

    // In the key phase, Ctrl+C cancels the whole wizard (first-run closes the
    // TUI), matching the overlay cancel contract; Esc only returns to search.
    terminal.input('\x03');
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('Ctrl+C did not close the first-run wizard from the key phase');
      }),
    ]);
  });

  test('allows a pending sandbox boundary request from the terminal', async () => {
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
    await delay(20);
    terminal.input('y');
    await waitFor(() => driver.boundaryResponses.length === 1);

    assert.deepEqual(driver.boundaryResponses, [
      {
        requestId: 'boundary-1',
        decision: 'allow',
      },
    ]);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('allows a pending sandbox boundary request with Enter', async () => {
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
    await delay(20);
    terminal.input('\r');
    await waitFor(() => driver.boundaryResponses.length === 1);

    assert.deepEqual(driver.boundaryResponses, [
      {
        requestId: 'boundary-1',
        decision: 'allow',
      },
    ]);

    exitMaka(terminal);
    await run;
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
    await delay(20);
    terminal.input('keep this draft');
    await waitFor(() => editorInputText(terminal) === 'keep this draft');
    releaseBoundaryRequest();
    await waitFor(() => driver.boundaryRequests === 1);

    terminal.input('x');
    await delay(20);
    assert.equal(editorInputText(terminal), 'keep this draft');
    assert.deepEqual(driver.boundaryResponses, []);

    terminal.input('n');
    await waitFor(() => driver.boundaryResponses.length === 1);
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
    terminal.input('\x1b[121;1:2u');
    await delay(20);
    assert.deepEqual(driver.boundaryResponses, []);

    terminal.input('y');
    await waitFor(() => driver.boundaryResponses.length === 1);
    exitMaka(terminal);
    await run;
  });

  test('ignores the removed turn-wide approval key while a boundary request waits', async () => {
    const terminal = new FakeTerminal();
    const driver = new SandboxBoundaryPromptDriver(['/outside']);
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
    await delay(20);
    terminal.input('a');
    await delay(20);
    assert.equal(driver.boundaryResponses.length, 0);
    terminal.input('y');
    await waitFor(() => driver.boundaryResponses.length === 1);
    assert.deepEqual(driver.boundaryResponses, [
      {
        requestId: 'boundary-1',
        decision: 'allow',
      },
    ]);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
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
    await delay(20);
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
      delay(50).then(() => {
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
      delay(50).then(() => {
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

  test('navigates the inline option list and Other row with the arrow keys', async () => {
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

    // Q1: ↓ moves the highlight to the second option, Enter selects it.
    terminal.input('\x1b[B');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Keep the default'));

    // Q2: ↓ past both options lands on the Other row; typed text submits on Enter.
    terminal.input('\x1b[B');
    terminal.input('\x1b[B');
    terminal.input('typed answer');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('typed answer'));
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Anything else'));

    // Q3: ↑ from the first option wraps to the (empty) Other row; Enter there is a
    // no-op, so the question stays open until Escape leaves it unanswered.
    terminal.input('\x1b[A');
    terminal.input('\r');
    await delay(20);
    assert.equal(driver.responses.length, 0);
    assert.ok(plainTerminalOutput(terminal.screenOutput()).includes('Anything else'));
    terminal.input('\x1b');

    await waitFor(() => driver.responses.length === 1);
    assert.deepEqual(driver.responses, [
      {
        requestId: 'question-1',
        answers: ['Separate', 'typed answer', null],
      },
    ]);

    exitMaka(terminal);
    await run;
  });

  test('submits a large pasted Other answer expanded, not as a paste marker', async () => {
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

    // ↑ from the first option wraps onto the Other row; a >1000-char bracketed
    // paste is stored as a `[paste #N …]` placeholder inside the editor.
    const pasted = 'x'.repeat(1001);
    terminal.input('\x1b[A');
    terminal.input(`\x1b[200~${pasted}\x1b[201~`);
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('[paste #1 1001 chars]'),
    );

    // Enter must submit through the Editor's own path, which expands the
    // placeholder back into the full pasted text before answering.
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Keep the default'));
    terminal.input('\x1b');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Anything else'));
    terminal.input('\x1b');

    await waitFor(() => driver.responses.length === 1);
    assert.deepEqual(driver.responses, [
      {
        requestId: 'question-1',
        answers: [pasted, null, null],
      },
    ]);

    exitMaka(terminal);
    await run;
  });

  test('treats LF in the Other row as a newline, not a submit', async () => {
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

    // Type into the Other row, then send a legacy LF (Ctrl-J). The Editor owns
    // Enter-key classification: LF is a newline, so the question must stay open
    // with a second line started instead of submitting the answer.
    terminal.input('line one');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('line one'));
    terminal.input('\n');
    terminal.input('line two');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('line two'));
    assert.equal(driver.responses.length, 0);
    assert.ok(plainTerminalOutput(terminal.screenOutput()).includes('Choose an approach'));

    // CR submits: the answer carries the newline the LF inserted.
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Keep the default'));
    terminal.input('\x1b');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Anything else'));
    terminal.input('\x1b');

    await waitFor(() => driver.responses.length === 1);
    assert.deepEqual(driver.responses, [
      {
        requestId: 'question-1',
        answers: ['line one\nline two', null, null],
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

  test('toggles tool detail globally with Ctrl-O', async () => {
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

    terminal.input('r');
    terminal.input('u');
    terminal.input('n');
    terminal.input('\r');

    await waitFor(() => terminal.output().includes('(31 lines)'));
    assert.equal(terminal.output().includes('expanded-tail'), false);

    terminal.input('\x0f');
    // Expanding the 31-line result overflows the viewport; the transcript is not
    // windowed, so its head line `expanded-tail` scrolls into the terminal's own
    // scrollback. The cumulative write stream is what was drawn, so it records the
    // expanded content even once it has scrolled above the fold.
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('expanded-tail'));

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('Ctrl-O with tool cards above the viewport never clears terminal scrollback (#1097)', async () => {
    const terminal = new FakeTerminal();
    const driver = new OffscreenToolDriver();
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
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('late-build'));

    terminal.input('\x0f');
    // The late card sits inside the 24-row viewport, so Ctrl+O expands it.
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('late-head'));

    // The early card scrolled above the viewport before the toggle: its lines
    // are terminal scrollback now, so it must not be re-rendered expanded, and
    // nothing in the whole run may emit the scrollback-erase sequence.
    assert.equal(plainTerminalOutput(terminal.output()).includes('early-head'), false);
    assert.equal(terminal.output().includes('\x1b[3J'), false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('off-screen running-Bash ticker never clears scrollback (#1135)', async () => {
    const terminal = new FakeTerminal();
    const driver = new OffscreenTickerDriver();
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
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('late-build'));

    // The ticker fires every 1s; wait past two ticks. The early running card
    // is off-screen, so its elapsed update must not trigger a scrollback wipe.
    await delay(2_500);
    assert.equal(terminal.output().includes('\x1b[3J'), false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
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
    await delay(50);

    assert.equal(terminal.output().includes('\x1b[3J'), false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
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
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('off-screen thinking_complete never clears scrollback (#1135)', async () => {
    const terminal = new FakeTerminal();
    const driver = new OffscreenThinkingDriver();
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
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('late-visible'));

    assert.equal(terminal.output().includes('\x1b[3J'), false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
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
    await delay(20);
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('(31 lines)'), false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
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
    terminal.input('\x1b[27u');
    terminal.input('\x1b[27;1:3u');
    await delay(20);
    assert.equal(driver.stopCalls, 0);

    // A real second press still interrupts the running turn.
    terminal.input('\x1b[27u');
    await waitFor(() => driver.stopCalls === 1);
    await waitFor(() => terminal.progressStates.at(-1) === false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('toggles thinking visibility with Ctrl-T', async () => {
    const terminal = new FakeTerminal();
    const driver = new ThinkingOutputDriver();
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

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Thinking…'));
    assert.equal(plainTerminalOutput(terminal.output()).includes('secret reasoning tail'), false);

    terminal.input('\x14');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('secret reasoning tail'));

    terminal.input('\x14');
    await waitFor(
      () => !plainTerminalOutput(terminal.screenOutput()).includes('secret reasoning tail'),
    );

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('Ctrl-T on a block expanded past the viewport flips the default and explains, without clearing scrollback (#1134)', async () => {
    const terminal = new FakeTerminal();
    const driver = new TallThinkingOutputDriver();
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
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Thinking…'));

    // Expanding writes all 80 reasoning rows; the block's own head scrolls
    // above the 24-row viewport into terminal scrollback.
    terminal.input('\x14');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('reason-row-79'));

    // The second Ctrl+T finds no thinking head inside the viewport. It must
    // not clear scrollback, must keep the frozen expansion, and must say what
    // happened instead of silently doing nothing.
    terminal.input('\x14');
    await waitFor(() =>
      plainTerminalOutput(terminal.screenOutput()).includes('No thinking in view to toggle'),
    );
    assert.match(plainTerminalOutput(terminal.screenOutput()), /New thinking starts collapsed/);
    assert.equal(terminal.output().includes('\x1b[3J'), false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('renders the statusline below the input editor', async () => {
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

    await waitFor(() =>
      plainTerminalOutput(terminal.output()).includes(
        'Maka · Auto · deepseek-v4-flash · deepseek · /repo',
      ),
    );

    const lines = plainTerminalOutput(terminal.output()).split(/\r?\n/);
    const statusLineIndex = lines.findIndex((line) =>
      line.includes('Maka · Auto · deepseek-v4-flash · deepseek · /repo'),
    );
    const editorBorderIndexes = lines
      .map((line, index) => (/^─+$/.test(line) ? index : -1))
      .filter((index) => index >= 0);

    assert.ok(editorBorderIndexes.length >= 2);
    assert.ok(statusLineIndex > editorBorderIndexes[editorBorderIndexes.length - 1]!);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('shows Working… in the activity strip while a turn runs', async () => {
    const terminal = new FakeTerminal();
    const driver = new HangingTurnDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('hello');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Working…'));
    assert.match(plainTerminalOutput(terminal.screenOutput()), /Working… \d+s/);

    driver.releaseComplete();
    await waitFor(() => !plainTerminalOutput(terminal.screenOutput()).includes('Working…'));

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('uses logo blue for TUI accent chrome', async () => {
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

    await waitFor(() => terminal.output().includes('\x1b[38;2;87;163;239m'));

    assert.doesNotMatch(terminal.output(), /\x1b\[36m─/);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('keeps the input editor and statusline at the terminal bottom', async () => {
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

    await waitFor(() =>
      plainTerminalOutput(terminal.output()).includes(
        'Maka · Auto · deepseek-v4-flash · deepseek · /repo',
      ),
    );

    const lines = plainTerminalOutput(terminal.output()).split(/\r?\n/);
    const statusLineIndex = lines.findIndex((line) =>
      line.includes('Maka · Auto · deepseek-v4-flash · deepseek · /repo'),
    );
    const editorBorderIndexes = lines
      .map((line, index) => (/^─+$/.test(line) ? index : -1))
      .filter((index) => index >= 0);

    assert.equal(statusLineIndex, terminal.rows - 1);
    assert.equal(editorBorderIndexes[editorBorderIndexes.length - 1], terminal.rows - 2);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('passes the runtime terminal turn identity to the settlement callback', async () => {
    const terminal = new FakeTerminal();
    const driver = new RuntimeTurnIdentityDriver();
    const settledTurns: Array<{
      sessionId: string;
      outcome: { kind: string; turnId?: string };
    }> = [];
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
      goalLifecycle: createTestGoalLifecycle((sessionId, turnId, outcome) => {
        assert.equal(outcome.turnId, turnId);
        settledTurns.push({ sessionId, outcome });
      }),
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => settledTurns.length === 1);

    assert.deepEqual(settledTurns, [
      {
        sessionId: 'session-1',
        outcome: { kind: 'completed', turnId: 'runtime-turn-42' },
      },
    ]);

    exitMaka(terminal);
    await run;
  });

  test('passes an external turn failure to the settlement callback', async () => {
    const terminal = new FakeTerminal();
    const driver = new QuickErrorDriver();
    const settlements: Array<{ sessionId: string; kind: string; reason?: string }> = [];
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
      goalLifecycle: createTestGoalLifecycle((sessionId, _turnId, outcome) => {
        settlements.push({
          sessionId,
          kind: outcome.kind,
          ...(outcome.kind === 'errored' ? { reason: outcome.reason } : {}),
        });
      }),
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => settlements.length === 1);

    assert.deepEqual(settlements, [
      {
        sessionId: 'session-1',
        kind: 'errored',
        reason: 'turn failed',
      },
    ]);

    exitMaka(terminal);
    await run;
  });

  test('uses the real CLI Goal lifecycle for external, owned, and switched turns', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    let goalId = 0;
    let evaluations = 0;
    const manager = new GoalManager({
      generateId: () => `goal-${++goalId}`,
      now: () => 1,
    });
    const lifecycle = new CliGoalContinuation({
      goalManager: manager,
      evaluator: {
        evaluate: async () => {
          evaluations++;
          return JSON.stringify({
            met: evaluations === 2,
            impossible: false,
            progress: true,
            waiting: false,
            reason: evaluations === 2 ? 'verified' : 'continue',
          });
        },
      },
      getRecentContext: async () => 'recent context',
    });
    assert.equal(manager.create('session-1', 'ship').kind, 'created');

    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
      goalLifecycle: lifecycle,
    });

    terminal.input('run');
    terminal.input('\r');
    await waitFor(() => manager.get('session-1')?.status === 'achieved');
    assert.equal(evaluations, 2);
    assert.equal(driver.prompts.length, 2);
    assert.equal(driver.prompts[0], 'run');
    assert.match(driver.prompts[1] ?? '', /\[Goal continuation\]/);
    assert.equal(manager.get('session-1')?.iterations, 1);
    assert.equal(lifecycle.activities.whenIdle('session-1'), undefined);

    assert.equal(manager.create('session-1', 'old session goal').kind, 'created');
    const switched = lifecycle.beginExternalTurn('session-1', 'turn-after-switch');
    assert.equal(switched.kind, 'registered');
    if (switched.kind !== 'registered') throw new Error('expected registered switch-boundary turn');
    await driver.switchSession('session-2');
    await switched.settle({
      kind: 'completed',
      turnId: 'turn-after-switch',
    });
    await waitFor(() => manager.get('session-1')?.status === 'paused');
    assert.equal(manager.get('session-1')?.lastReason, 'TUI is attached to a different session.');

    manager.clear('session-1');
    exitMaka(terminal);
    await run;

    lifecycle.dispose();
    manager.dispose();
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
      goalLifecycle: createTestGoalLifecycle(undefined, activities),
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
    let registered = false;
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
      goalLifecycle: {
        activities,
        bindHost: () => () => {},
        beginExternalTurn: (sessionId, turnId) => {
          assert.equal(sessionId, 'session-first');
          assert.equal(turnId, 'turn-first');
          assert.ok(activities.whenIdle(sessionId));
          registered = true;
          return {
            kind: 'registered',
            settle: async () => {},
          };
        },
      },
    });

    terminal.input('run');
    terminal.input('\r');
    await driver.streamStarted.promise;
    assert.equal(registered, true);
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
      goalLifecycle: createTestGoalLifecycle(undefined, activities),
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
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('does not close the main TUI on Escape', async () => {
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

    await waitFor(() =>
      plainTerminalOutput(terminal.output()).includes(
        'Maka · Auto · deepseek-v4-flash · deepseek · /repo',
      ),
    );

    terminal.input('\x1b');
    await delay(30);

    assert.equal(terminal.stopCalls, 0);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
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
    await delay(20);

    assert.equal(terminal.stopCalls, 0);
    assert.doesNotMatch(plainTerminalOutput(terminal.screenOutput()), /unsent draft/);
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
    terminal.input('\x1b[99;5:2u');
    await delay(20);

    assert.equal(terminal.stopCalls, 0);
    terminal.input('\x1b[99;5u');
    await run;
  });

  test('keeps Maka open when Ctrl-D is pressed with a draft', async () => {
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

    terminal.input('draft');
    terminal.input('\x04');
    await delay(20);

    assert.equal(terminal.stopCalls, 0);
    terminal.input('\x03');
    exitMaka(terminal);
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
    terminal.input('\x04');
    await delay(20);

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

  test('/quit during a running turn closes the TUI instead of steering it', async () => {
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

    terminal.input('/quit');
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
    await delay(20);

    assert.deepEqual(driver.prompts, []);
    assert.ok(plainTerminalOutput(terminal.screenOutput()).includes('a draft to keep'));

    driver.releaseSetModel();
    await delay(20);
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

    // The old bounded poll gave up after ~2s of busy and silently dropped the
    // text; a normal turn easily outlives that budget.
    await delay(2200);
    const screen = plainTerminalOutput(terminal.screenOutput());
    assert.equal(screen.includes('Steering: second thought'), true);
    assert.equal(screen.includes('Queued: and afterwards'), true);
    assert.deepEqual(driver.prompts, ['start the work']);

    // The turn boundary flushes the undelivered texts into the next turn.
    driver.endTurn();
    await waitFor(() => driver.prompts.length === 2);
    assert.equal(driver.prompts[1], 'second thought\n\nand afterwards');

    await waitFor(() => driver.parked);
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
    await delay(20);

    driver.endTurn(); // the aborted turn finally terminates
    await waitFor(() => terminal.progressStates.at(-1) === false);
    await delay(30);
    // No second turn is prepared; the typed text is still in the editor as a draft.
    assert.deepEqual(driver.prompts, ['start the work']);
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('after stop'), true);

    terminal.input('\x03'); // clear the preserved draft
    terminal.input('/exit');
    terminal.input('\r');
    await run;
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
    await delay(30);
    assert.deepEqual(driver.prompts, ['start the work']);
    // The undelivered text is an editable draft, not a queued line.
    await waitFor(() => {
      const screen = plainTerminalOutput(terminal.screenOutput());
      return screen.includes('next thing') && !screen.includes('Queued: next thing');
    });

    terminal.input('\x03'); // clear the preserved draft
    terminal.input('/exit');
    terminal.input('\r');
    await run;
  });

  test('closes the main TUI on Ctrl-D', async () => {
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

    terminal.input('\x04');

    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after Ctrl-D');
      }),
    ]);
    assert.equal(terminal.stopCalls, 1);
  });

  test('shows slash commands alphabetically when typing /', async () => {
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

    terminal.input('/');

    await waitFor(() => {
      const lines = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
      return autocompleteSuggestionLines(lines).some((line) => line.includes('/session'));
    });
    // Scope to the autocomplete overlay — the empty-session home now shows
    // /session /model /setup as hint text, so a whole-screen grep would pick up
    // the home's copies and misorder them against the menu (#1098).
    const suggestions = autocompleteSuggestionLines(
      plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/),
    ).join('\n');
    const exitIndex = suggestions.indexOf('/exit');
    const modelIndex = suggestions.indexOf('/model');
    const permissionsIndex = suggestions.indexOf('/permissions');
    const sessionIndex = suggestions.indexOf('/session');

    assert.ok(exitIndex >= 0);
    assert.ok(modelIndex >= 0);
    assert.ok(permissionsIndex >= 0);
    assert.ok(sessionIndex >= 0);
    assert.ok(exitIndex < modelIndex);
    assert.ok(modelIndex < permissionsIndex);
    assert.ok(permissionsIndex < sessionIndex);
    // The whole menu is visible at once — including the last command
    // alphabetically — so new commands don't push older ones below the fold.
    assert.ok(suggestions.indexOf('/thinking') > sessionIndex);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('renders slash autocomplete above the input editor', async () => {
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

    terminal.input('/');

    await waitFor(() => {
      const lines = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
      return (
        lines.some((line) => line.includes('→')) &&
        autocompleteSuggestionLines(lines).some((line) => line.includes('/model'))
      );
    });
    // Scope to the autocomplete overlay, not the whole screen: the empty-session
    // home now shows /session /model /setup as hint text, so a whole-screen
    // findIndex('/model') would land on the home's hint and pass even if the
    // overlay never rendered (#1098).
    const lines = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
    const [editorTopBorder, editorBottomBorder] = inputSurfaceRows(lines);
    const cursorIndex = lines.findIndex((line) => line.includes('→'));
    const statusLineIndex = lines.findIndex((line) =>
      line.includes('Maka · Auto · deepseek-v4-flash · deepseek · /repo'),
    );

    // The autocomplete menu (→ cursor) renders above the editor's top border.
    assert.ok(cursorIndex >= 0);
    assert.ok(cursorIndex < editorTopBorder);
    // The menu carries /model, scoped to the overlay rather than the home hint.
    assert.ok(autocompleteSuggestionLines(lines).some((line) => line.includes('/model')));
    // The editor's bottom border sits just above the statusline.
    assert.equal(editorBottomBorder, statusLineIndex - 1);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('keeps slash autocomplete filtering anchored to the input editor', async () => {
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

    terminal.input('/');

    await waitFor(() => {
      const lines = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
      return autocompleteSuggestionLines(lines).some((line) => line.includes('/session'));
    });
    const beforeLines = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
    const beforeRows = inputSurfaceRows(beforeLines);

    terminal.input('s');

    await waitFor(() => {
      const suggestions = autocompleteSuggestionLines(
        plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/),
      );
      return (
        suggestions.some((line) => line.includes('/session')) &&
        !suggestions.some((line) => line.includes('/model'))
      );
    });
    const afterLines = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
    const afterRows = inputSurfaceRows(afterLines);
    const afterSuggestions = autocompleteSuggestionLines(afterLines);

    // The input surface did not shift while filtering.
    assert.deepEqual(afterRows, beforeRows);
    // The 's' filter matches four commands — /session, /setup, /skill, /swarm — bottom-
    // aligned immediately above the editor's top border. Scope to the overlay so
    // the empty-session home's /session /model /setup hints don't collide (#1098).
    assert.equal(afterSuggestions.length, 4);
    assert.deepEqual(
      afterSuggestions.map((line) => line.match(/\/\w+/)?.[0]),
      ['/session', '/setup', '/skill', '/swarm'],
    );
    assert.ok(afterLines[afterRows[0] - 1]!.includes('/swarm'));
    assert.ok(afterLines[afterRows[0] - 2]!.includes('/skill'));
    assert.ok(afterLines[afterRows[0] - 3]!.includes('/setup'));
    assert.ok(afterLines[afterRows[0] - 4]!.includes('/session'));

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('keeps slash autocomplete filtering pinned to the bottom after scrollback', async () => {
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

    await waitFor(() => driver.prompts.length === 1);
    await waitFor(() => terminal.progressStates.at(-1) === false);
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('filler line 40'));

    terminal.input('/');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('/session'));
    const beforeLines = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
    const beforeRows = inputSurfaceRows(beforeLines);

    terminal.input('s');

    await waitFor(() => {
      const output = plainTerminalOutput(terminal.screenOutput());
      return output.includes('/session') && !output.includes('/model');
    });
    const afterLines = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
    const afterRows = inputSurfaceRows(afterLines);
    const afterSessionRow = afterLines.findIndex((line) => line.includes('/session'));
    const afterSkillRow = afterLines.findIndex((line) => line.includes('/skill'));
    const afterSetupRow = afterLines.findIndex((line) => line.includes('/setup'));
    const afterSwarmRow = afterLines.findIndex((line) => line.includes('/swarm'));

    assert.deepEqual(afterRows, beforeRows);
    assert.equal(afterRows[1], terminal.rows - 2);
    assert.equal(afterSwarmRow, afterRows[0] - 1);
    assert.equal(afterSkillRow, afterRows[0] - 2);
    assert.equal(afterSetupRow, afterRows[0] - 3);
    assert.equal(afterSessionRow, afterRows[0] - 4);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('bottom-aligns filtered autocomplete inside a stable slot', () => {
    const expanded = arrangeAutocompleteAboveEditor({
      lines: ['────────', '/ ', '────────', '→ /exit', '  /model', '  /permissions', '  /session'],
      autocompleteShowing: true,
      autocompleteSlotRows: 0,
    });

    const filtered = arrangeAutocompleteAboveEditor({
      lines: ['────────', '/s ', '────────', '→ /session'],
      autocompleteShowing: true,
      autocompleteSlotRows: expanded.autocompleteSlotRows,
    });

    assert.equal(filtered.lines.length, expanded.lines.length);
    assert.deepEqual(filtered.lines.slice(0, 4), ['', '', '', '→ /session']);
    assert.deepEqual(filtered.lines.slice(4), ['────────', '/s ', '────────']);
  });

  test('navigates submitted prompt history and restores the unsent draft', async () => {
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

    const submit = async (prompt: string, expectedPromptCount: number) => {
      terminal.input(prompt);
      terminal.input('\r');
      await waitFor(() => driver.prompts.length === expectedPromptCount);
      await waitFor(() => terminal.progressStates.at(-1) === false);
    };

    try {
      await submit('first prompt', 1);
      await submit('second prompt', 2);

      terminal.input('\x1b[A');
      await waitFor(() => editorInputText(terminal) === 'second prompt');

      terminal.input('\x1b[A');
      await waitFor(() => editorInputText(terminal) === 'first prompt');

      terminal.input('\x1b[B');
      await waitFor(() => editorInputText(terminal) === 'second prompt');

      terminal.input('\x1b[B');
      await waitFor(() => editorInputText(terminal) === '');

      terminal.input('unsent draft');
      terminal.input('\x01');
      terminal.input('\x1b[A');
      await waitFor(() => editorInputText(terminal) === 'second prompt');

      terminal.input('\x1b[B');
      await waitFor(() => editorInputText(terminal) === 'unsent draft');
    } finally {
      exitMaka(terminal);
      await Promise.race([
        run,
        delay(50).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    }
  });

  test('handles /exit without sending a prompt', async () => {
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

    terminal.input('/exit');
    terminal.input('\r');

    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close after /exit');
      }),
    ]);

    assert.deepEqual(driver.prompts, []);
    assert.equal(terminal.stopCalls, 1);
  });

  test('keeps Maka open when Ctrl-D is pressed during a control command', async () => {
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
    terminal.input('\x04');
    await delay(20);

    try {
      assert.equal(terminal.stopCalls, 0);
    } finally {
      driver.releaseSetModel();
      if (terminal.stopCalls === 0) exitMaka(terminal);
      await run;
    }
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
    await delay(20);

    try {
      assert.equal(terminal.stopCalls, 0);
      terminal.input('\x03');
      await Promise.race([
        run,
        delay(50).then(() => {
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

  test('handles /compact through the runtime compact API and progress loader', async () => {
    const terminal = new FakeTerminal();
    const driver = new DeferredCompactDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    for (const char of '/compact') terminal.input(char);
    terminal.input('\r');

    await waitFor(() => driver.compactCalls === 1);
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Compacting context'));

    assert.deepEqual(driver.prompts, []);
    assert.equal(terminal.progressStates.at(-1), true);

    driver.releaseCompact();
    await waitFor(() => terminal.progressStates.at(-1) === false);
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Context compacted'));

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('handles /resume without submitting another user prompt', async () => {
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

    for (const char of '/resume') terminal.input(char);
    terminal.input('\r');

    await waitFor(() => driver.resumeCalls === 1);
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('resumed safely'));
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await run;
  });

  test('applies the selected slash command from autocomplete', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      models: ['deepseek-v4-flash', 'gpt-5.3-codex-spark'],
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/m');

    await waitFor(() => {
      const lines = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
      return autocompleteSuggestionLines(lines).some((line) => line.includes('/model'));
    });
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Select Model'));

    assert.deepEqual(driver.prompts, []);

    terminal.input('\x1b');
    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('rejects removed permission modes without sending a prompt', async () => {
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

    terminal.input('/permissions execute');
    terminal.input('\r');

    await waitFor(() => terminal.output().includes('Usage: /permissions auto|bypass'));

    assert.deepEqual(driver.permissionModes, []);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
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
    await delay(20);
    assert.deepEqual(driver.permissionModes, []);

    exitMaka(terminal);
    await run;
  });

  test('returns from Bypass to Auto without a confirmation', async () => {
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
    });

    terminal.input('/permissions auto');
    terminal.input('\r');
    await waitFor(() => driver.permissionModes.length === 1);

    assert.deepEqual(driver.permissionModes, ['ask']);
    assert.doesNotMatch(terminal.output(), /Switch to full access/);

    exitMaka(terminal);
    await run;
  });

  test('shows, enables, and disables persistent Swarm Mode without sending a prompt', async () => {
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

    terminal.input('/swarm');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Swarm Mode is off'));

    terminal.input('/swarm on');
    terminal.input('\r');
    await waitFor(() => driver.orchestrationModes.length === 1);
    await waitFor(() => terminal.output().includes('Swarm Mode enabled'));
    assert.ok(plainTerminalOutput(terminal.screenOutput()).includes('swarm'));

    terminal.input('/swarm status');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Swarm Mode is on'));

    terminal.input('/swarm off');
    terminal.input('\r');
    await waitFor(() => driver.orchestrationModes.length === 2);
    await waitFor(() => terminal.output().includes('Swarm Mode disabled'));

    assert.deepEqual(driver.orchestrationModes, ['swarm', 'default']);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await run;
  });

  test('runs /swarm <task> as one trusted swarm turn with clean transcript text', async () => {
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

    terminal.input('/swarm inspect runtime, UI, and tests');
    terminal.input('\r');
    await waitFor(() => driver.prompts.length === 1);
    await waitFor(() => terminal.output().includes('Using Swarm Mode for this turn only'));

    assert.deepEqual(driver.displayPrompts, ['inspect runtime, UI, and tests']);
    assert.deepEqual(driver.prompts, ['inspect runtime, UI, and tests']);
    assert.deepEqual(driver.turnOrchestrations, [{ mode: 'swarm', source: 'slash_command' }]);
    assert.deepEqual(driver.orchestrationModes, []);
    const screen = plainTerminalOutput(terminal.screenOutput());
    assert.ok(screen.includes('inspect runtime, UI, and tests'));
    assert.equal(screen.includes('/swarm inspect runtime, UI, and tests'), false);

    terminal.input('follow up normally');
    terminal.input('\r');
    await waitFor(() => driver.prompts.length === 2);
    assert.deepEqual(driver.turnOrchestrations, [
      { mode: 'swarm', source: 'slash_command' },
      undefined,
    ]);

    exitMaka(terminal);
    await run;
  });

  test('shows, enables, disables, and runs Graph Mode from the CLI', async () => {
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

    terminal.input('/graph');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Graph Mode is off'));

    terminal.input('/graph on');
    terminal.input('\r');
    await waitFor(() => driver.orchestrationModes.length === 1);
    await waitFor(() => terminal.output().includes('Graph Mode enabled'));

    terminal.input('/graph off');
    terminal.input('\r');
    await waitFor(() => driver.orchestrationModes.length === 2);
    await waitFor(() => terminal.output().includes('Graph Mode disabled'));

    terminal.input('/graph implement A, then integrate B');
    terminal.input('\r');
    await waitFor(() => driver.prompts.length === 1);
    await waitFor(() => terminal.output().includes('Using Graph Mode for this turn only'));

    assert.deepEqual(driver.orchestrationModes, ['graph', 'default']);
    assert.deepEqual(driver.displayPrompts, ['implement A, then integrate B']);
    assert.deepEqual(driver.turnOrchestrations, [{ mode: 'graph', source: 'slash_command' }]);

    exitMaka(terminal);
    await run;
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

  test('handles /thinking high without sending a prompt', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'gpt-5.5',
      connectionSlug: 'openai',
      providerType: 'openai',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/thinking high');
    terminal.input('\r');

    await waitFor(() => driver.thinkingLevelUpdates.length === 1);
    assert.deepEqual(driver.thinkingLevelUpdates, ['high']);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('shows the default thinking status for Ollama Cloud GLM-5.2', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'glm-5.2',
      connectionSlug: 'ollama-cloud',
      providerType: 'ollama-cloud',
      permissionMode: 'ask',
      terminal,
    });

    // #1064: thinking:default is no longer shown — only an explicitly set
    // thinkingLevel appears. The status line omits the thinking segment.
    await waitFor(() =>
      plainTerminalOutput(terminal.output()).includes(
        'Maka · Auto · glm-5.2 · ollama-cloud · /repo',
      ),
    );

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('handles /thinking off when the current model exposes a real off wire', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'gpt-5.5',
      connectionSlug: 'openai',
      providerType: 'openai',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/thinking off');
    terminal.input('\r');

    await waitFor(() => driver.thinkingLevelUpdates.length === 1);
    assert.deepEqual(driver.thinkingLevelUpdates, ['off']);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
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
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('handles /thinking default by clearing the override', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'gpt-5.5',
      connectionSlug: 'openai',
      providerType: 'openai',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/thinking default');
    terminal.input('\r');

    await waitFor(() => driver.thinkingLevelUpdates.length === 1);
    assert.deepEqual(driver.thinkingLevelUpdates, [undefined]);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('confirms Bypass a second time when selected from /permissions', async () => {
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

    terminal.input('/permissions');
    terminal.input('\r');

    await waitFor(() => terminal.output().includes('Permissions'));
    assertBottomPickerPlacement(
      terminal,
      'Permissions',
      'Maka · Auto · claude-sonnet-4-5 · claude-subscription · /repo',
    );
    terminal.input('\x1b[B');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Switch to full access?'));
    assert.deepEqual(driver.permissionModes, []);
    terminal.input('\x1b[B');
    terminal.input('\r');
    await waitFor(() => driver.permissionModes.length === 1);
    await waitFor(() => terminal.output().includes('Permissions: Full access'));

    assert.deepEqual(driver.permissionModes, ['bypass']);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
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
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('handles /model without sending a prompt', async () => {
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

    terminal.input('/model claude-opus-4-1');
    terminal.input('\r');

    await waitFor(() => driver.models.length === 1);
    await waitFor(() => terminal.output().includes('Model: claude-opus-4-1'));

    assert.deepEqual(driver.models, ['claude-opus-4-1']);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('selects a model from /model', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'deepseek-v4-flash',
      models: ['deepseek-v4-flash', 'gpt-5.3-codex-spark'],
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/model');
    terminal.input('\r');

    await waitFor(() => terminal.output().includes('Select Model'));
    await waitFor(() => terminal.output().includes('gpt-5.3-codex-spark'));
    const titleLine = latestPlainLineContaining(terminal.output(), 'Select Model');
    assert.equal(titleLine.startsWith('Select Model'), true);
    assert.equal(visibleWidth(titleLine), terminal.columns);
    assertBottomPickerPlacement(
      terminal,
      'Select Model',
      'Maka · Auto · deepseek-v4-flash · deepseek · /repo',
    );
    terminal.input('\x1b[B');
    terminal.input('\r');
    await waitFor(() => driver.models.length === 1);
    await waitFor(() => terminal.output().includes('Model: gpt-5.3-codex-spark'));

    assert.deepEqual(driver.models, ['gpt-5.3-codex-spark']);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
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

    terminal.input('/model');
    terminal.input('\r');

    await waitFor(() => terminal.output().includes('Select Model'));
    await waitFor(() => terminal.output().includes('glm-5.2'));
    // The picker opens on the current model (gpt-5.5); move down to the choice on
    // the other connection and select it.
    terminal.input('\x1b[B');
    terminal.input('\r');
    await waitFor(() => driver.models.length === 1);

    assert.deepEqual(driver.models, ['glm-5.2']);
    assert.deepEqual(driver.modelConnections, ['zai']);
    // The status line now reflects both the new model and the new connection.
    await waitFor(() =>
      plainTerminalOutput(terminal.output()).includes('Maka · Auto · glm-5.2 · zai · /repo'),
    );

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('cross-connection /model filters the model list as you type in the search field', async () => {
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

    await delay(20);
    terminal.input('/model');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Select Model'));
    await waitFor(() => terminal.output().includes('glm-5.2'));
    const before = plainTerminalOutput(terminal.screenOutput());
    assert.ok(before.includes('gpt-5.5'));
    assert.ok(before.includes('glm-5.2'));
    // The searchable overlay stays bottom-anchored above the editor + status line,
    // just like the non-searchable picker it replaces.
    assertBottomPickerPlacement(terminal, 'Select Model', 'Maka · Auto · gpt-5.5 · openai · /repo');

    // Typing in the search field filters the cross-connection list live. The
    // query "gpt" matches only the OpenAI model id, so the Z.ai model leaves
    // the visible list while the match stays. The current model (gpt-5.5) is
    // still shown by the status line regardless, so the assertion targets the
    // model that was filtered out (glm-5.2, not the current model).
    terminal.input('gpt');
    await waitFor(() => {
      const out = plainTerminalOutput(terminal.screenOutput());
      return out.includes('gpt-5.5') && !out.includes('glm-5.2');
    });

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('cross-connection /model shows an empty state when no model matches the search', async () => {
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

    await delay(20);
    terminal.input('/model');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Select Model'));

    // A query that matches no model id, provider, or connection surfaces an
    // in-frame empty state instead of the full list.
    terminal.input('zzz');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('没有匹配的模型'));

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('cross-connection /model rebinds the session to a filtered model on Enter', async () => {
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

    await delay(20);
    terminal.input('/model');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Select Model'));
    // Filter to the Z.ai model alone; the OpenAI connection-name leaves the list
    // (the status line keeps the lowercase slug, not the capitalized name).
    terminal.input('glm');
    await waitFor(() => {
      const out = plainTerminalOutput(terminal.screenOutput());
      return out.includes('glm-5.2') && !out.includes('OpenAI');
    });
    // The filtered list's first match is already highlighted, so Enter rebinds.
    terminal.input('\r');
    await waitFor(() => driver.models.length === 1);

    assert.deepEqual(driver.models, ['glm-5.2']);
    assert.deepEqual(driver.modelConnections, ['zai']);
    await waitFor(() =>
      plainTerminalOutput(terminal.output()).includes('Maka · Auto · glm-5.2 · zai · /repo'),
    );

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('cross-connection /model cancel closes the picker without changing the model', async () => {
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

    await delay(20);
    terminal.input('/model');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Select Model'));
    terminal.input('\x1b');
    await delay(30);

    // Esc closed the picker without rebinding: no setModel call, and the status
    // line still shows the original model + connection.
    assert.deepEqual(driver.models, []);
    assert.deepEqual(driver.modelConnections, []);
    assert.ok(
      plainTerminalOutput(terminal.output()).includes('Maka · Auto · gpt-5.5 · openai · /repo'),
    );

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(500).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('typed /model <id> still switches the model directly when modelChoices are present', async () => {
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

    await delay(20);
    terminal.input('/model glm-5.2');
    terminal.input('\r');
    await waitFor(() => driver.models.length === 1);

    // Typed /model sets the model on the current connection without opening the
    // searchable picker (cross-connection switching is the picker's job).
    assert.deepEqual(driver.models, ['glm-5.2']);
    assert.deepEqual(driver.modelConnections, [undefined]);
    assert.equal(terminal.output().includes('Select Model'), false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(500).then(() => {
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

    await delay(20);
    terminal.input('/model');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Select Model'));
    await waitFor(() => {
      const out = plainTerminalOutput(terminal.screenOutput());
      return out.includes('gpt-5.5') && out.includes('glm-max') && out.includes('text-unicorn');
    });

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
      delay(500).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('handles /rename without sending a prompt', async () => {
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

    terminal.input('/rename Updated title');
    terminal.input('\r');

    await waitFor(() => driver.renames.length === 1);
    await waitFor(() =>
      plainTerminalOutput(terminal.output()).includes('Session renamed to "Updated title"'),
    );
    await waitFor(() => terminal.titles.includes('Updated title (Maka)'));

    assert.deepEqual(driver.renames, ['Updated title']);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('uses the canonical session name returned by /rename', async () => {
    const terminal = new FakeTerminal();
    const driver = new CanonicalRenameDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/rename Raw\u200B title');
    terminal.input('\r');

    await waitFor(() => driver.renames.length === 1);
    await waitFor(() => terminal.titles.includes('Raw title (Maka)'));
    assert.equal(
      plainTerminalOutput(terminal.output()).includes('Session renamed to "Raw title"'),
      true,
    );

    exitMaka(terminal);
    await run;
  });

  test('handles /move without sending it as a prompt and accepts the next prompt', async () => {
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

    terminal.input('/move /repo/.worktree/feature');
    terminal.input('\r');

    await waitFor(() => driver.moves.length === 1);
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('uncommitted changes'));
    assert.deepEqual(driver.moves, ['/repo/.worktree/feature']);
    assert.deepEqual(driver.prompts, []);

    terminal.input('continue in the moved workspace');
    terminal.input('\r');
    await waitFor(() => driver.prompts.length === 1);
    assert.deepEqual(driver.prompts, ['continue in the moved workspace']);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('preserves repeated whitespace in a quoted /move path', async () => {
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

    terminal.input('/move "/repo/a  b"');
    terminal.input('\r');

    await waitFor(() => driver.moves.length === 1);
    assert.deepEqual(driver.moves, ['"/repo/a  b"']);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('opens the /move directory picker', async () => {
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

    terminal.input('/move');
    terminal.input('\r');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Move Session'));
    terminal.input('/repo/.worktree/feature');
    terminal.input('\r');
    await waitFor(() => driver.moves.length === 1);
    assert.deepEqual(driver.moves, ['/repo/.worktree/feature']);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('shows a generated title for the active session in the terminal title', async () => {
    const terminal = new FakeTerminal();
    const session = fakeSessionSummary('session-1', '/repo', 'Generated title');
    const driver = new SlashCommandDriver([session]);
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

    await waitFor(() => terminal.titles.includes('Generated title (Maka)'));
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('Generated title'), false);

    exitMaka(terminal);
    await run;
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

  test('rejects /rename without a new name', async () => {
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

    terminal.input('/rename');
    terminal.input('\r');

    await waitFor(() =>
      plainTerminalOutput(terminal.output()).includes('Usage: /rename <new name>'),
    );
    assert.deepEqual(driver.renames, []);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('handles /session without sending a prompt', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver([fakeSessionSummary('session-2', '/repo')]);
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/session session-2');
    terminal.input('\r');

    await waitFor(() => driver.sessionIds.length === 1);
    await waitFor(() => terminal.output().includes('Resumed session "Existing chat"'));
    await waitFor(() => terminal.titles.includes('Existing chat (Maka)'));

    assert.deepEqual(driver.sessionIds, ['session-2']);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('selects a session from /session', async () => {
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

    terminal.input('/session');
    terminal.input('\r');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Resume Session Current'));
    // The picker labels rows by human name, not the raw session id.
    await waitFor(() => terminal.output().includes('Existing chat'));
    const titleLine = latestPlainLineContaining(terminal.output(), 'Resume Session Current');
    assert.equal(titleLine.startsWith('Resume Session Current'), true);
    assert.equal(visibleWidth(titleLine), terminal.columns);
    assertBottomPickerPlacement(
      terminal,
      'Resume Session Current',
      'Maka · Auto · claude-sonnet-4-5 · claude-subscription · /repo',
    );
    terminal.input('\r');
    await waitFor(() => driver.sessionIds.length === 1);
    await waitFor(() => terminal.output().includes('Resumed session "Existing chat"'));

    assert.deepEqual(driver.sessionIds, ['session-2']);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
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
      delay(50).then(() => {
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
      plainTerminalOutput(terminal.output()).includes('读取外部会话失败：corrupt index'),
    );

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
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
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('switching to a session on a different model updates the ctx total in the status line', async () => {
    const terminal = new FakeTerminal();
    const driver = new ModelSwitchDriver();
    const modelChoices: ModelChoice[] = [
      {
        connectionSlug: 'claude-subscription',
        connectionName: 'Claude',
        providerType: 'claude-subscription',
        model: 'claude-sonnet-4-5',
        isDefaultConnection: true,
        contextWindow: 1_000,
      },
      {
        connectionSlug: 'conn-b',
        connectionName: 'B',
        providerType: 'claude-subscription',
        model: 'model-b',
        isDefaultConnection: false,
        contextWindow: 200_000,
      },
    ];
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      modelChoices,
      modelContextWindow: 1_000,
      terminal,
    });

    terminal.input('/session session-2');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Resumed session "Existing chat"'));

    terminal.input('go');
    terminal.input('\r');
    // contextWindow after the switch (200_000) minus contextRemaining (50_000)
    // is 150_000 used, 75% — only correct if applySwitchResult re-resolved
    // modelContextWindow for the switched-to connection+model instead of
    // leaving the pre-switch session's 1_000 window in place.
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('ctx 150k/200k 75%'));

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('switching to a session whose model was curated out of modelChoices clears the stale ctx total', async () => {
    const terminal = new FakeTerminal();
    const driver = new CuratedOutModelSwitchDriver();
    const modelChoices: ModelChoice[] = [
      {
        connectionSlug: 'claude-subscription',
        connectionName: 'Claude',
        providerType: 'claude-subscription',
        model: 'claude-sonnet-4-5',
        isDefaultConnection: true,
        contextWindow: 1_000,
      },
    ];
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      modelChoices,
      modelContextWindow: 1_000,
      terminal,
    });

    terminal.input('/session session-2');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Resumed session "Existing chat"'));
    // The switched-to session's model ("legacy-model") is not in modelChoices,
    // so no exact contextWindowMatch exists for it.
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('legacy-model'));

    terminal.input('go');
    terminal.input('\r');
    await waitFor(() => driver.prompts.length === 1);
    // The driver's promptEvents completes near-instantly (no manual gating),
    // so give the token_usage + complete events time to drain and render.
    await delay(20);

    // Bug under test: the pre-switch session's 1_000 window must not survive
    // to render a (wrong) ctx total against the curated-out model's usage.
    assert.doesNotMatch(plainTerminalOutput(terminal.output()), /ctx \d/);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
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
    await delay(50);
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
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('toggles the session picker from Current to All with Tab', async () => {
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
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('Other chat'), false);

    terminal.input('\t');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('Other chat'));
    assert.match(plainTerminalOutput(terminal.screenOutput()), /Resume Session.*All/);
    assert.match(plainTerminalOutput(terminal.screenOutput()), /Other chat.*elsewhere/);

    terminal.input('\x1b');
    exitMaka(terminal);
    await run;
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
    await delay(10);

    assert.deepEqual(driver.sessionIds, []);
    assert.match(
      plainTerminalOutput(terminal.screenOutput()),
      /Legacy chat.*Missing working directory/,
    );

    terminal.input('\x1b');
    exitMaka(terminal);
    await run;
  });

  test('the session picker scrolls through every session rather than capping', async () => {
    const terminal = new FakeTerminal();
    const sessions = Array.from({ length: 12 }, (_, i) =>
      fakeSessionSummary(`session-${i}`, '/repo', `chat ${i}`),
    );
    const driver = new SlashCommandDriver(sessions);
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

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Resume Session Current'));
    // All 12 are in the list (not sliced to 10): the scroll indicator counts the
    // full total, so the window shows "(1/12)".
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('/12)'));
    // And the 12th is genuinely reachable: scrolling down brings it into view,
    // even though it starts below the visible window.
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('chat 11'), false);
    for (let i = 0; i < 11; i += 1) terminal.input('\x1b[B');
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('chat 11'));

    terminal.input('\x1b');
    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('the session picker disambiguates same-named sessions by short id', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver([
      fakeSessionSummary('aaaa1111-2222-3333', '/repo', 'Same name'),
      fakeSessionSummary('bbbb4444-5555-6666', '/repo', 'Same name'),
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

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Resume Session Current'));
    // Same label on both rows, but the short id in the description tells them apart.
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('aaaa1111'));
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('bbbb4444'));

    terminal.input('\x1b');
    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('/help lists commands and keybindings', async () => {
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

    terminal.input('/help');
    terminal.input('\r');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Commands'));
    const out = plainTerminalOutput(terminal.output());
    // Commands are derived from the registry, so a representative one shows up.
    assert.ok(out.includes('/rewind'));
    assert.ok(out.includes('Rewind to an earlier turn'));
    assert.ok(out.includes('/new'));
    // Keybindings — the whole reason /help exists (they are otherwise hidden).
    assert.ok(out.includes('Keybindings'));
    assert.ok(out.includes('Ctrl+O'));
    assert.ok(out.includes('Esc Esc'));
    assert.ok(out.includes('Ctrl+C — stop the turn, clear input, or press twice to exit'));
    assert.ok(out.includes('Ctrl+D — exit when input is empty'));
    // Scrolling is the terminal's own now; the removed PgUp/PgDn pager must not
    // be advertised as a working keybinding.
    assert.ok(out.includes('terminal or trackpad'));
    assert.equal(out.includes('PageUp'), false);
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('/context renders persisted request diagnostics without preparing a model turn', async () => {
    const terminal = new FakeTerminal();
    Object.defineProperty(terminal, 'columns', { value: 36 });
    const driver = new SlashCommandDriver();
    driver.contextDiagnostics = {
      status: 'available',
      providerId: 'anthropic',
      modelId: 'claude-test',
      completedAt: 20,
      inputTokens: 40,
      contextWindow: 200,
      segments: [
        { kind: 'system_instructions', bytes: 400, estimatedTokens: 100 },
        { kind: 'tool_definitions', bytes: 800, estimatedTokens: 200 },
        { kind: 'messages', bytes: 1_200, estimatedTokens: 300 },
      ],
      compaction: {
        kind: 'history',
        phase: 'pre_turn',
        eventCount: 12,
        turnCount: 3,
        estimatedTokens: 77,
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
    });

    terminal.input('/context');
    terminal.input('\r');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('Context'));
    const out = plainTerminalOutput(terminal.output()).replace(/\s+/g, ' ');
    assert.match(
      out,
      /Context Latest completed request anthropic · claude-test Usage Used: 40 tokens provider-reported Total: 200 tokens request-model snapshot Free: 160 tokens calculated Share: 20% calculated/,
    );
    assert.match(
      out,
      /Estimated breakdown System instructions: ≈100 tokens Tool definitions: ≈200 tokens Messages: ≈300 tokens/,
    );
    assert.match(
      out,
      /History compaction pre-turn · 12 events \/ 3 turns ≈77 tokens · local estimate/,
    );
    assert.deepEqual(driver.prompts, []);
    assert.equal(driver.contextDiagnosticsRequests, 1);
    assert.equal(
      plainTerminalOutput(terminal.screenOutput())
        .split(/\r?\n/)
        .every((line) => visibleWidth(line) <= terminal.columns),
      true,
    );

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('/context labels unavailable request diagnostics', async () => {
    const terminal = new FakeTerminal();
    Object.defineProperty(terminal, 'columns', { value: 36 });
    const driver = new SlashCommandDriver();
    driver.contextDiagnostics = {
      status: 'available',
      providerId: 'anthropic',
      modelId: 'claude-test',
      completedAt: 20,
      segments: [],
    };
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
    });

    terminal.input('/context');
    terminal.input('\r');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('provider report missing'));
    const out = plainTerminalOutput(terminal.output()).replace(/\s+/g, ' ');
    assert.match(
      out,
      /Usage Used: unavailable provider report missing Total: unavailable request-model snapshot missing Free: unavailable requires Used and Total Share: unavailable requires Used and Total/,
    );
    assert.match(
      out,
      /Estimated breakdown Unavailable no captured request segments History compaction Unavailable for this request/,
    );
    assert.equal(
      plainTerminalOutput(terminal.screenOutput())
        .split(/\r?\n/)
        .every((line) => visibleWidth(line) <= terminal.columns),
      true,
    );
    assert.deepEqual(driver.prompts, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('/context explains why diagnostics are unavailable', async () => {
    const cases: Array<{
      reason: 'no_completed_request' | 'trace_unavailable';
      message: string;
    }> = [
      {
        reason: 'no_completed_request',
        message: 'No completed provider request exists for this session.',
      },
      {
        reason: 'trace_unavailable',
        message: 'Provider request trace data could not be read.',
      },
    ];

    for (const { reason, message } of cases) {
      const terminal = new FakeTerminal();
      const driver = new SlashCommandDriver();
      driver.contextDiagnostics = { status: 'unavailable', reason };
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'claude-sonnet-4-5',
        connectionSlug: 'claude-subscription',
        permissionMode: 'ask',
        terminal,
      });

      terminal.input('/context');
      terminal.input('\r');

      await waitFor(() => plainTerminalOutput(terminal.output()).includes(message));
      assert.deepEqual(driver.prompts, []);

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(50).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    }
  });

  test('/new clears the transcript and starts a fresh session', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver([
      fakeSessionSummary('session-1', '/repo', 'Previous title'),
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
    await waitFor(() => terminal.titles.includes('Previous title (Maka)'));

    terminal.input('remember this');
    terminal.input('\r');
    await waitFor(() => driver.prompts.length === 1);
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('remember this'));

    terminal.input('/new');
    terminal.input('\r');

    await waitFor(() => driver.startNewSessionCalls === 1);
    // /new empties the transcript, so it opens on the same welcome block as a
    // cold start rather than a one-off notice — that block is the "fresh session"
    // cue and a notice would suppress it.
    await waitFor(() => plainTerminalOutput(terminal.screenOutput()).includes('陪你把事做完'));
    // The previous turn is gone from the visible transcript.
    await waitFor(() => !plainTerminalOutput(terminal.screenOutput()).includes('remember this'));
    assert.equal(terminal.titles.at(-1), 'Maka');

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
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
    await delay(300);
    assert.equal(hydrationAttempts, attemptsAfterReset);

    exitMaka(terminal);
    await run;
  });

  test('serializes a control command with prompts and shared session activity', async () => {
    const terminal = new FakeTerminal();
    const driver = new DeferredControlDriver();
    const activities = new SessionActivityRegistry();
    let goalHost: CliGoalTurnHost | undefined;
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      terminal,
      goalLifecycle: createTestGoalLifecycle(undefined, activities, (host) => {
        if (host) goalHost = host;
      }),
    });
    assert.ok(goalHost);

    terminal.input('/model claude-opus-4-1');
    terminal.input('\r');
    await waitFor(() => driver.models.length === 1);
    const admission = goalHost.admitTurn('session-1', 'wait for control');
    assert.equal(admission.kind, 'busy');
    if (admission.kind !== 'busy') throw new Error('expected busy admission');

    let automationAcquired = false;
    const automationActivity = activities.acquire('session-1').then((lease) => {
      automationAcquired = true;
      return lease;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(automationAcquired, false);

    // While the model switch is in flight, typing + Enter must not send a prompt.
    terminal.input('blocked');
    terminal.input('\r');
    await delay(20);
    assert.deepEqual(driver.prompts, []);

    // After the switch completes, the previously typed prompt goes through.
    driver.releaseSetModel();
    await admission.whenIdle;
    const automationLease = await automationActivity;
    automationLease.release();
    await delay(20);
    terminal.input('\r');
    await waitFor(() => driver.prompts.length === 1);
    assert.deepEqual(driver.prompts, ['blocked']);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
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
    await delay(20);

    // Response rejected: error shows, but the boundary prompt stays and can be retried.
    assert.ok(
      plainTerminalOutput(terminal.output()).includes('Allow access outside the workspace?'),
    );

    terminal.input('n');
    await waitFor(() => driver.responses.length === 2);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
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
    terminal.input('hello');
    terminal.input('\r');
    await delay(20);
    assert.deepEqual(driver.prompts, []);

    driver.releaseList();
    await delay(30);

    terminal.input('\x1b');
    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
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

    terminal.input('\x1b');
    await delay(20);
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
    await delay(20);
    assert.equal(driver.stopCalls, 1);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
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
      delay(50).then(() => {
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

  test('reports when /rewind has no earlier turns', async () => {
    const terminal = new FakeTerminal();
    const driver = new RewindDriver([]);
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

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('没有可回退的轮次'));
    assert.equal(plainTerminalOutput(terminal.output()).includes('回到选定轮次'), false);
    assert.deepEqual(driver.rewound, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
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

    // A single Escape falls through to the editor: no picker yet.
    terminal.input('\x1b');
    await delay(40);
    assert.equal(plainTerminalOutput(terminal.output()).includes('回到选定轮次'), false);

    // A second Escape within the window completes the gesture and opens the picker.
    terminal.input('\x1b');
    await waitFor(() => plainTerminalOutput(terminal.output()).includes('回到选定轮次'));

    // Cancel the picker so Ctrl-C reaches the runner rather than the overlay.
    terminal.input('\x1b');
    await waitFor(() => !plainTerminalOutput(terminal.screenOutput()).includes('回到选定轮次'));

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
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

    // While a draft is present, Escape belongs to the editor (clear input), not
    // the rewind gesture. Two Escapes must not open the picker.
    terminal.input('draft in progress');
    await delay(20);
    terminal.input('\x1b');
    await delay(20);
    terminal.input('\x1b');
    await delay(40);
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('回到选定轮次'), false);
    assert.deepEqual(driver.rewound, []);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
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
    terminal.input('\x1b');
    await delay(20);
    terminal.input('\x1b[D');
    await delay(20);
    terminal.input('\x1b');
    await delay(40);
    assert.equal(plainTerminalOutput(terminal.screenOutput()).includes('回到选定轮次'), false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
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
    // would append a duplicate abort note to the session log.
    terminal.input('\x1b');
    terminal.input('\x1b');
    await delay(30);
    assert.equal(driver.stopCalls, 1);

    driver.endTurn();
    await waitFor(() => terminal.progressStates.at(-1) === false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
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
        delay(50).then(() => {
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
    await delay(20);

    terminal.input('\x1b');
    terminal.input('\x1b');
    await waitFor(() => driver.boundaryResponses.length >= 1);

    // Both Escapes route to the boundary prompt, never to turn interruption.
    assert.equal(driver.boundaryResponses[0]?.decision, 'deny');
    assert.equal(driver.stopCalls, 0);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
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
    await delay(20);
    assert.equal(driver.respondCalls, 0);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
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
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('rings the bell and marks the title when a long turn ends unfocused', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      // Zero threshold: every completed turn counts as long, so the test drives
      // the ring path without waiting real seconds.
      attentionLongTurnThresholdMs: 0,
      terminal,
    });

    // Report the terminal as backgrounded, then run a turn to completion.
    terminal.input('\x1b[O');
    terminal.input('go');
    terminal.input('\r');

    await waitFor(() => driver.prompts.length === 1);
    await waitFor(() => bellCount(terminal) === 1);
    assert.ok(
      terminal.titles.includes(`${BUSY_SPINNER_FRAMES[0]} Maka`),
      'title marks busy during the turn',
    );
    assert.ok(
      terminal.titles.includes('★ Maka'),
      'title marks attention after the unfocused finish',
    );

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('does not ring when a short turn ends unfocused', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      // Default (large) threshold: the immediate-complete turn is far too short.
      terminal,
    });

    terminal.input('\x1b[O');
    terminal.input('go');
    terminal.input('\r');

    await waitFor(() => driver.prompts.length === 1);
    await delay(30);
    assert.equal(bellCount(terminal), 0);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('does not ring when a long turn ends while still focused', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      attentionLongTurnThresholdMs: 0,
      terminal,
    });

    // No blur report: the terminal is assumed focused, so a finished turn is
    // silent — the user is watching it.
    terminal.input('go');
    terminal.input('\r');

    await waitFor(() => driver.prompts.length === 1);
    await delay(30);
    assert.equal(bellCount(terminal), 0);
    assert.equal(terminal.titles.includes('★ Maka'), false);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('rings when a sandbox boundary prompt appears unfocused', async () => {
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

    terminal.input('\x1b[O');
    terminal.input('run');
    terminal.input('\r');

    await waitFor(() => driver.boundaryRequests === 1);
    await waitFor(() => bellCount(terminal) >= 1);
    assert.ok(terminal.titles.includes('★ Maka'));

    // Answer so the parked turn can finish and the TUI closes cleanly.
    terminal.input('y');
    await waitFor(() => driver.boundaryResponses.length === 1);

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('rings when a short turn fails unfocused', async () => {
    const terminal = new FakeTerminal();
    const driver = new QuickErrorDriver();
    const run = runMakaPiTui({
      title: 'Maka',
      driver,
      cwd: '/repo',
      model: 'claude-sonnet-4-5',
      connectionSlug: 'claude-subscription',
      permissionMode: 'ask',
      // Default (large) threshold: the ring must come from the error path, not
      // from turn duration — the turn fails immediately.
      terminal,
    });

    terminal.input('\x1b[O');
    terminal.input('go');
    terminal.input('\r');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('turn failed'));
    await waitFor(() => bellCount(terminal) === 1);
    assert.ok(terminal.titles.includes('★ Maka'));

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('clears the busy title marker when Ctrl-C stops a turn', async () => {
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
    await waitFor(() => terminal.titles.includes(`${BUSY_SPINNER_FRAMES[0]} Maka`));

    terminal.input('\x03');
    await waitFor(() => driver.stopCalls === 1);
    await waitFor(() => terminal.titles.at(-1) === 'Maka');
    assert.equal(terminal.stopCalls, 0);

    exitMaka(terminal);
    await run;
    assert.equal(terminal.titles.at(-1), 'Maka');
  });

  // #1148: explicit skill invocation — tokens are resolved by the CLI at
  // submit, the runtime receives the composed message, and the transcript
  // keeps showing what the user actually typed.
  test('injects invoked skill instructions at submit while showing the typed prompt', async () => {
    await withSkillWorkspace(async (workspaceRoot) => {
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
        skills: { source: () => workspaceRoot, host: { toolNames: new Set<string>() } },
      });

      terminal.input('/skill:alpha 帮我整理');
      terminal.input('\r');
      await waitFor(() => driver.prompts.length === 1);

      assert.equal(
        driver.displayPrompts[0],
        '/skill:alpha 帮我整理',
        'human-facing prompt keeps the typed tokens',
      );
      const sent = driver.prompts[0];
      assert.match(sent, /<invoked-skill id="alpha" name="Alpha">/);
      assert.match(sent, /# Alpha\nAlpha body\./);
      assert.match(sent, /do not call the Skill tool again for these skills/);
      assert.ok(
        sent.endsWith('<user-message>\n帮我整理\n</user-message>'),
        `composed message carries the stripped user text: ${sent}`,
      );

      // The transcript render trails the send by a tick — wait for it.
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('/skill:alpha 帮我整理'));
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('已加载技能：Alpha'));

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(50).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });
  });

  // Governance closeout: an all-failed explicit invocation yields a bounded
  // local diagnostic and must not create a provider turn.
  test('does not create a turn when every skill token fails to resolve', async () => {
    await withSkillWorkspace(async (workspaceRoot) => {
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
        skills: { source: () => workspaceRoot, host: { toolNames: new Set<string>() } },
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
        delay(50).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });
  });

  test('does not create a turn when distinct skill requests exceed the preparation limit', async () => {
    await withSkillWorkspace(async (workspaceRoot) => {
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
        skills: { source: () => workspaceRoot, host: { toolNames: new Set<string>() } },
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
        delay(50).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });
  });

  // #1148: `/skill` opens the picker; picking inserts the token into the
  // draft without sending, so the user keeps composing before submitting.
  test('/skill picker inserts a token that a later submit injects', async () => {
    await withSkillWorkspace(async (workspaceRoot) => {
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
        skills: { source: () => workspaceRoot, host: { toolNames: new Set<string>() } },
      });

      terminal.input('/skill');
      terminal.input('\r');
      await waitFor(() => terminal.output().includes('Invoke Skill'));
      assert.equal(driver.prompts.length, 0, 'the picker command itself sends nothing');

      terminal.input('\r');
      terminal.input('整理一下');
      terminal.input('\r');
      await waitFor(() => driver.prompts.length === 1);

      const sent = driver.prompts[0];
      assert.match(sent, /<invoked-skill id="alpha" name="Alpha">/);
      assert.ok(
        sent.endsWith('<user-message>\n整理一下\n</user-message>'),
        `picker-inserted token composes on submit: ${sent}`,
      );

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(50).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });
  });

  // #1055: `/recap` and the generator injection point it shares with idle-return
  // auto-recap. The idle-timer path itself is not covered here (it depends on
  // real wall-clock gaps with no injectable clock) — see session-recap.test.ts
  // for the pure `shouldAutoRecap` boundary coverage instead.
  describe('/recap command', () => {
    test('reports unavailability when no generator is injected', async () => {
      const terminal = new FakeTerminal();
      const driver = new RewindDriver([{ turnId: 'turn-1', label: 'first prompt' }]);
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'claude-sonnet-4-5',
        connectionSlug: 'claude-subscription',
        permissionMode: 'ask',
        terminal,
      });

      terminal.input('/recap');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes(
          'Recap is not available in this environment.',
        ),
      );

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(50).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });

    test('reports nothing to recap yet when there are no main turns, without calling the generator', async () => {
      const terminal = new FakeTerminal();
      const driver = new SlashCommandDriver(); // default listRewindTargets() resolves to []
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
            return { ok: true, text: 'unused', raw: 'unused' };
          },
        },
      });

      terminal.input('/recap');
      terminal.input('\r');
      await waitFor(() => plainTerminalOutput(terminal.output()).includes('Nothing to recap yet.'));
      assert.equal(calls, 0, 'the generator must not be called when there is nothing to recap');

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(50).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });

    test('shows the cleaned recap text on success', async () => {
      const terminal = new FakeTerminal();
      const driver = new RewindDriver([{ turnId: 'turn-1', label: 'first prompt' }]);
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'claude-sonnet-4-5',
        connectionSlug: 'claude-subscription',
        permissionMode: 'ask',
        terminal,
        recap: {
          generate: async () => ({
            ok: true,
            text: 'We fixed the recap bug.',
            raw: 'We fixed the recap bug.',
          }),
        },
      });

      terminal.input('/recap');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes('Recap: We fixed the recap bug.'),
      );

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(50).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });

    test('shows an error notice on failure', async () => {
      const terminal = new FakeTerminal();
      const driver = new RewindDriver([{ turnId: 'turn-1', label: 'first prompt' }]);
      const run = runMakaPiTui({
        title: 'Maka',
        driver,
        cwd: '/repo',
        model: 'claude-sonnet-4-5',
        connectionSlug: 'claude-subscription',
        permissionMode: 'ask',
        terminal,
        recap: {
          generate: async () => ({ ok: false, error: 'connection lost' }),
        },
      });

      terminal.input('/recap');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes('Recap failed: connection lost'),
      );

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(50).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });

    test('a second /recap while one is in flight reports it is already running, without a second generate() call', async () => {
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
      await waitFor(() => calls === 1);

      terminal.input('/recap');
      terminal.input('\r');
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes('Recap already running.'),
      );
      assert.equal(calls, 1, 'the in-flight lock must prevent a second concurrent generate() call');

      gate.resolve();
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes('Recap: first recap result'),
      );

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(50).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });

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
      await delay(50);
      assert.equal(
        plainTerminalOutput(terminal.output()).includes('Recap: stale recap result'),
        false,
        'an idle recap superseded by a later prompt must be dropped silently',
      );

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(50).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });

    test('an idle-triggered recap is shown normally when no later prompt supersedes it', async (t) => {
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
            return { ok: true, text: 'fresh recap result', raw: 'fresh recap result' };
          },
        },
      });

      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      t.mock.timers.tick(AUTO_RECAP_IDLE_MS + 1_000);
      terminal.input('first prompt after idle');
      terminal.input('\r');
      t.mock.timers.reset();

      await waitFor(() => calls === 1); // idle auto-recap fired; generate() is in flight
      await waitFor(() => driver.prompts.length === 1);
      await waitFor(() => terminal.progressStates.at(-1) === false);

      // No further prompt is submitted before the recap resolves, so promptSeq
      // is unchanged from what runRecap captured on entry: the notice shows.
      gate.resolve();
      await waitFor(() =>
        plainTerminalOutput(terminal.output()).includes('Recap: fresh recap result'),
      );

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(50).then(() => {
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
        delay(50).then(() => {
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
      await delay(50);
      assert.equal(
        plainTerminalOutput(terminal.output()).includes('Recap:'),
        false,
        'a recap started in a session that has since been switched away from must be dropped silently',
      );

      exitMaka(terminal);
      await Promise.race([
        run,
        delay(50).then(() => {
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
        delay(50).then(() => {
          throw new Error('TUI did not close during test cleanup');
        }),
      ]);
    });
  });

  test('a bare "quit" line exits Maka without sending a prompt', async () => {
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

    terminal.input('quit');
    terminal.input('\r');

    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close on a bare "quit" line');
      }),
    ]);

    assert.equal(terminal.stopCalls, 1);
    assert.deepEqual(driver.prompts, []);
  });

  test('a bare "exit" line exits Maka without sending a prompt', async () => {
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

    terminal.input('exit');
    terminal.input('\r');

    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close on a bare "exit" line');
      }),
    ]);

    assert.equal(terminal.stopCalls, 1);
    assert.deepEqual(driver.prompts, []);
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
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('/quit exits Maka (alias of /exit)', async () => {
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

    terminal.input('/quit');
    terminal.input('\r');

    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close on /quit');
      }),
    ]);

    assert.equal(terminal.stopCalls, 1);
    assert.deepEqual(driver.prompts, []);
  });

  test('/quit is a hidden alias of /exit, not its own autocomplete entry', async () => {
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

    terminal.input('/');

    await waitFor(() => plainTerminalOutput(terminal.output()).includes('/exit'));
    const output = plainTerminalOutput(terminal.output());
    assert.ok(output.includes('/exit'));
    assert.ok(!output.includes('/quit'));

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });

  test('resumes a session at startup via resumeSessionId', async () => {
    const terminal = new FakeTerminal();
    const driver = new SlashCommandDriver([
      { ...fakeSessionSummary('session-2', '/repo'), orchestrationMode: 'swarm' },
    ]);
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
    await waitFor(() => terminal.output().includes('Resumed session "Existing chat"'));

    assert.deepEqual(driver.sessionIds, ['session-2']);
    assert.deepEqual(driver.prompts, []);
    assert.ok(plainTerminalOutput(terminal.screenOutput()).includes('swarm'));

    terminal.input('/swarm status');
    terminal.input('\r');
    await waitFor(() => terminal.output().includes('Swarm Mode is on for this session.'));

    exitMaka(terminal);
    await Promise.race([
      run,
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
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
      delay(50).then(() => {
        throw new Error('TUI did not close during test cleanup');
      }),
    ]);
  });
});

/** Count the standalone BEL bytes the attention layer wrote. */
function bellCount(terminal: FakeTerminal): number {
  return terminal.writes.filter((write) => write === '\x07').length;
}

function editorInputText(terminal: FakeTerminal): string {
  const lines = plainTerminalOutput(terminal.screenOutput()).split(/\r?\n/);
  const [topEditorBorderIndex, bottomEditorBorderIndex] = inputSurfaceRows(lines);
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
  private releaseTurn: (() => void) | null = null;

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
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

  steer(text: string): QueueEnqueueOutcome {
    this.steered.push(text);
    this.steering.push(text);
    this.emitQueueUpdate();
    return { kind: 'queued' };
  }

  queueMessage(text: string): QueueEnqueueOutcome {
    this.queuedMessages.push(text);
    this.followup.push(text);
    this.emitQueueUpdate();
    return { kind: 'queued' };
  }

  takePendingFollowup(): string | null {
    if (this.followup.length === 0) return null;
    const joined = this.followup.join('\n\n');
    this.followup = [];
    return joined;
  }

  retractQueued(): string {
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
  /** Enqueue calls that report `fallback` before the owner "appears". */
  steerFallbacks = Number.POSITIVE_INFINITY;
  queueFallbacks = Number.POSITIVE_INFINITY;
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
      return;
    }
    yield {
      type: 'complete',
      id: `complete-${this.prompts.length}`,
      turnId,
      ts: 1,
      stopReason: 'end_turn',
    };
  }

  /** Next endTurn() finishes the turn as aborted instead of end_turn. */
  abortNextTurn = false;

  steer(text: string): QueueEnqueueOutcome {
    if (this.steerFallbacks > 0) {
      this.steerFallbacks -= 1;
      return { kind: 'fallback' };
    }
    this.steered.push(text);
    this.steering.push(text);
    this.emitQueueUpdate();
    return { kind: 'queued' };
  }

  queueMessage(text: string): QueueEnqueueOutcome {
    if (this.queueFallbacks > 0) {
      this.queueFallbacks -= 1;
      return { kind: 'fallback' };
    }
    this.queuedMessages.push(text);
    this.followup.push(text);
    this.emitQueueUpdate();
    return { kind: 'queued' };
  }

  takePendingFollowup(): string | null {
    if (this.followup.length === 0) return null;
    const joined = this.followup.join('\n\n');
    this.followup = [];
    return joined;
  }

  retractQueued(): string {
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

class ThinkingOutputDriver implements MakaSessionDriver {
  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    return prepareTestPrompt(this, prompt);
  }

  async *compactSession(): AsyncIterable<never> {}

  async *promptEvents(_prompt: string): AsyncIterable<SessionEvent> {
    yield {
      type: 'thinking_delta',
      id: 'event-thinking',
      turnId: 'turn-1',
      ts: 1,
      messageId: 'message-1',
      text: 'secret reasoning tail',
    };
    yield {
      type: 'text_complete',
      id: 'event-text',
      turnId: 'turn-1',
      ts: 2,
      messageId: 'message-1',
      text: 'visible answer',
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

/** 80 reasoning rows: expanding pushes the block's head into scrollback (#1134). */
class TallThinkingOutputDriver extends ThinkingOutputDriver {
  override async *promptEvents(_prompt: string): AsyncIterable<SessionEvent> {
    yield {
      type: 'thinking_delta',
      id: 'event-thinking',
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

class OffscreenToolDriver extends ToolOutputDriver {
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
        kind: 'terminal',
        cwd: '/repo',
        cmd: 'early-build',
        status: 'completed',
        exitCode: 0,
        // `early-head` is hidden by the compact tail; it can only ever be
        // written if the card is re-rendered expanded.
        output: pipeOutput(
          `early-head\n${Array.from({ length: 30 }, (_, i) => `early-row-${i}`).join('\n')}`,
        ),
      },
    };
    yield {
      type: 'text_delta',
      id: 'event-filler',
      turnId: 'turn-1',
      ts: 3,
      messageId: 'message-1',
      // 30 paragraphs (~60 rows) push the early card above a 24-row viewport.
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
        output: pipeOutput(
          `late-head\n${Array.from({ length: 30 }, (_, i) => `late-row-${i}`).join('\n')}`,
        ),
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

// #1135: a running Bash card scrolls off-screen, then the 1s ticker updates
// its elapsed time. The freeze must keep the off-screen render unchanged.
class OffscreenTickerDriver extends ToolOutputDriver {
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

// #1135: a thinking entry is streamed off-screen, then thinking_complete
// replaces its text. The freeze must keep the off-screen render unchanged.
class OffscreenThinkingDriver extends ToolOutputDriver {
  override async *promptEvents(_prompt: string): AsyncIterable<SessionEvent> {
    yield {
      type: 'thinking_delta',
      id: 'event-thinking-delta',
      turnId: 'turn-1',
      ts: 1,
      messageId: 'message-1',
      text: 'early-streamed-reasoning',
    };
    yield {
      type: 'text_delta',
      id: 'event-filler',
      turnId: 'turn-1',
      ts: 2,
      messageId: 'message-2',
      text: Array.from({ length: 30 }, (_, i) => `filler-${i}`).join('\n\n'),
    };
    // thinking_complete arrives after the thinking entry has scrolled off-screen.
    yield {
      type: 'thinking_complete',
      id: 'event-thinking-complete',
      turnId: 'turn-1',
      ts: 3,
      messageId: 'message-1',
      text: 'final-reasoning-replaces-streamed',
    };
    yield {
      type: 'text_delta',
      id: 'event-late-text',
      turnId: 'turn-1',
      ts: 4,
      messageId: 'message-3',
      text: 'late-visible-reply',
    };
    yield {
      type: 'complete',
      id: 'event-complete',
      turnId: 'turn-1',
      ts: 5,
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
  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    this.sessionIds.push(sessionId);
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

class FailingSwitchSessionDriver extends SlashCommandDriver {
  async switchSession(_sessionId: string): Promise<MakaSessionSwitchResult> {
    throw new Error('session not found');
  }
}

// Switches onto a session on a different connection/model, then emits a
// token_usage event on the next turn so the ctx statusline segment can be
// checked against the *new* session's context window.
class ModelSwitchDriver extends SlashCommandDriver {
  constructor() {
    super([
      {
        ...fakeSessionSummary('session-2', '/repo'),
        llmConnectionSlug: 'conn-b',
        model: 'model-b',
      },
    ]);
  }

  override async *promptEvents(_prompt: string, turnId = 'turn-1'): AsyncIterable<SessionEvent> {
    yield {
      type: 'token_usage',
      id: 'event-token-usage',
      turnId,
      ts: 1,
      input: 150_000,
      output: 0,
      contextRemaining: 50_000,
    };
    yield { type: 'complete', id: 'event-complete', turnId, ts: 2, stopReason: 'end_turn' };
  }
}

// Switches onto a session with the *same* connection but a model that has
// been curated out of modelChoices (a legitimate state for old sessions —
// see applySwitchResult). No exact contextWindowMatch exists, so the stale
// window from the pre-switch session must be cleared, not kept.
class CuratedOutModelSwitchDriver extends SlashCommandDriver {
  constructor() {
    super([
      {
        ...fakeSessionSummary('session-2', '/repo'),
        llmConnectionSlug: 'claude-subscription',
        model: 'legacy-model',
      },
    ]);
  }

  override async *promptEvents(_prompt: string, turnId = 'turn-1'): AsyncIterable<SessionEvent> {
    yield {
      type: 'token_usage',
      id: 'event-token-usage',
      turnId,
      ts: 1,
      input: 150_000,
      output: 0,
      contextRemaining: 50_000,
    };
    yield { type: 'complete', id: 'event-complete', turnId, ts: 2, stopReason: 'end_turn' };
  }
}

class RuntimeTurnIdentityDriver extends SlashCommandDriver {
  async preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    return {
      sessionId: this.sessionId,
      turnId: 'runtime-turn-42',
      events: this.promptEvents(prompt),
    };
  }

  override async *promptEvents(prompt: string): AsyncIterable<SessionEvent> {
    this.prompts.push(prompt);
    yield {
      type: 'complete',
      id: 'event-complete',
      turnId: 'runtime-turn-42',
      ts: 1,
      stopReason: 'end_turn',
    };
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

class HangingTurnDriver extends SlashCommandDriver {
  private resolveComplete: (() => void) | null = null;

  override async *promptEvents(prompt: string): AsyncIterable<SessionEvent> {
    this.prompts.push(prompt);
    yield {
      type: 'text_delta',
      id: 'event-text-delta',
      turnId: 'turn-1',
      ts: 1,
      messageId: 'msg-1',
      text: 'thinking…',
    };
    await new Promise<void>((resolve) => {
      this.resolveComplete = resolve;
    });
    yield {
      type: 'text_complete',
      id: 'event-text-complete',
      turnId: 'turn-1',
      ts: 2,
      messageId: 'msg-1',
      text: 'done',
    };
    yield {
      type: 'complete',
      id: 'event-complete',
      turnId: 'turn-1',
      ts: 3,
      stopReason: 'end_turn',
    };
  }

  releaseComplete(): void {
    this.resolveComplete?.();
    this.resolveComplete = null;
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

class DeferredCompactDriver extends SlashCommandDriver {
  compactCalls = 0;
  private resolveCompact: (() => void) | null = null;

  override async *compactSession(): AsyncIterable<SessionEvent> {
    this.compactCalls += 1;
    await new Promise<void>((resolve) => {
      this.resolveCompact = resolve;
    });
    yield {
      type: 'token_usage',
      id: 'event-token-usage',
      turnId: 'turn-compact',
      ts: 1,
      input: 0,
      output: 0,
      contextBudget: {
        enabled: true,
        policyName: 'unit-budget',
        estimatedTokensBefore: 1000,
        estimatedTokensAfter: 400,
        keptTurns: 1,
        droppedTurns: 2,
        keptEvents: 2,
        droppedEvents: 4,
        compactionDecisions: [
          {
            stage: 'priorReplay',
            sourceKind: 'runtimeEvents',
            decision: 'replaced',
            boundaryKind: 'historyCompact',
            estimatedTokensSaved: 600,
          },
        ],
      },
    };
    yield {
      type: 'complete',
      id: 'event-complete',
      turnId: 'turn-compact',
      ts: 2,
      stopReason: 'end_turn',
    };
  }

  releaseCompact(): void {
    this.resolveCompact?.();
    this.resolveCompact = null;
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

class CanonicalRenameDriver extends SlashCommandDriver {
  override async renameSession(name: string): Promise<string> {
    await super.renameSession(name);
    return 'Raw title';
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

class QuickErrorDriver implements MakaSessionDriver {
  readonly prompts: string[] = [];

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  preparePrompt(prompt: string): Promise<MakaPreparedSessionTurn> {
    return prepareTestPrompt(this, prompt);
  }

  async *compactSession(): AsyncIterable<never> {}

  async *promptEvents(prompt: string): AsyncIterable<SessionEvent> {
    this.prompts.push(prompt);
    // The turn fails immediately, so its duration never crosses the long-turn
    // threshold — the attention ring must come from the error, not the timer.
    yield {
      type: 'error',
      id: 'event-error',
      turnId: 'turn-1',
      ts: 1,
      message: 'turn failed',
      recoverable: false,
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

// #1148: a throwaway workspace seeded with one invocable skill (`alpha`).
// The runner's skill surface points at it in single-root mode, so no real
// user- or project-level skills leak into the tests.
async function withSkillWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-cli-skill-invocation-'));
  try {
    const skillDir = join(workspaceRoot, 'skills', 'alpha');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: Alpha\ndescription: First.\n---\n# Alpha\nAlpha body.',
      'utf8',
    );
    await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
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
  const cliUrl = new URL('../cli.js', import.meta.url).href;
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
    const goalLifecycle = {
      activities: {},
      beginExternalTurn() { throw new Error('unused'); },
      bindHost() { return () => {}; },
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
      goalLifecycle,
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
  let killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (!signalSent && stdout.includes('READY')) {
      signalSent = true;
      child.kill(signalToSend);
      // Time the kill against the signal handling window, not the child's
      // startup: on a slow CI runner importing the TUI and reaching READY can
      // itself take seconds, which would otherwise leave the 3s exit grace
      // (beginMakaCliExit) past the 5s kill timer and the probe would be
      // SIGKILLed before the graceful exit it is asserting.
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
  const cliUrl = new URL('../cli.js', import.meta.url).href;
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
    const goalLifecycle = {
      activities: {},
      beginExternalTurn() { throw new Error('unused'); },
      bindHost() { return () => {}; },
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
        goalLifecycle,
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
  let killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
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
