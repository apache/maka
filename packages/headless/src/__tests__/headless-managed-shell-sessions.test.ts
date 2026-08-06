import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';
import { MAX_FOREGROUND_BASH_TIMEOUT_MS, SHELL_RUN_RESOURCE_PREFIX } from '@maka/runtime';
import { z } from 'zod';
import {
  createHarborCellLocalToolExecutor,
  createHarborHttpToolExecutor,
} from '../harbor-cell-tool-executor.js';
import type { IsolatedShellSessions, IsolatedToolExecutor } from '../isolation.js';
import { buildIsolatedHeadlessProductToolSurface, buildIsolatedBashTool } from '../tools.js';

const execFileAsync = promisify(execFile);
const workspace = () => mkdtemp(join(tmpdir(), 'maka-managed-shell-'));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let sequence = 0;
const counter = () => (sequence += 1);

/**
 * Liveness observed from OUTSIDE the manager, so a record-only mutation fails.
 *
 * pgrep runs unwrapped on purpose. A `sh -c "pgrep -f MARKER || true"` wrapper
 * carries the marker in its OWN argv, and pgrep excludes only itself, not its
 * parent shell — the wrapper would count itself and make this probe report 1 no
 * matter what the manager did. pgrep exits 1 when nothing matches, which is the
 * zero case rather than an error.
 */
async function markedProcessCount(marker: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', marker]);
    return stdout.split('\n').filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * A command that runs until killed AND carries the marker in its own argv, so
 * pgrep can see it. A trailing `# marker` comment would not survive: the shell
 * execs itself into the child, dropping the comment from the visible argv.
 */
const longLivedCommand = (cwd: string, marker: string) =>
  `touch ${cwd}/${marker} && tail -f ${cwd}/${marker}`;

/** A background launch returns as soon as the run is admitted, before the child is up. */
async function waitForMarkedProcess(marker: string): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const count = await markedProcessCount(marker);
    if (count > 0) return count;
    await delay(20);
  }
  return 0;
}

/** Captures the timeout the tool resolves for each command without spawning. */
function recordingSessions(timeouts: Array<number | undefined>): IsolatedShellSessions {
  return {
    commandEnv: {},
    defaultCommandTimeoutMs: 5_000,
    runForegroundBash: async (input) => {
      timeouts.push(input.timeoutMs);
      return {
        kind: 'terminal',
        cwd: input.cwd,
        cmd: input.command,
        status: 'completed',
        exitCode: 0,
        output: {
          mode: 'pipes',
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false,
        },
      };
    },
    runBackgroundBash: async () => {
      throw new Error('not used');
    },
    readRuntimeResource: async () => {
      throw new Error('not used');
    },
    stopBackgroundTask: async () => {
      throw new Error('not used');
    },
    writeStdin: async () => {
      throw new Error('not used');
    },
    terminateAll: async () => {},
  };
}

const toolFrom = (executor: IsolatedToolExecutor, name: string) => {
  const found = buildIsolatedHeadlessProductToolSurface(executor).tools.find(
    (tool) => tool.name === name,
  );
  assert.ok(found, `${name} is not bound`);
  return found;
};

const toolCtx = (cwd: string, toolCallId = 'tool-1') => ({
  sessionId: 'session-1',
  turnId: 'turn-1',
  cwd,
  toolCallId,
  abortSignal: new AbortController().signal,
  emitOutput: () => {},
});

const shapeOf = (parameters: unknown): Record<string, unknown> => {
  const schema = z.toJSONSchema(parameters as z.ZodType, { io: 'input' }) as {
    properties?: Record<string, unknown>;
    allOf?: Array<{ properties?: Record<string, unknown> }>;
  };
  return schema.properties ?? schema.allOf?.[0]?.properties ?? {};
};

const toolNames = (executor: IsolatedToolExecutor) =>
  buildIsolatedHeadlessProductToolSurface(executor).tools.map((tool) => tool.name);

describe('headless managed shell sessions', () => {
  test('a remote executor keeps the stateless single-command surface', () => {
    const executor = createHarborHttpToolExecutor({
      MAKA_HARBOR_TOOL_EXECUTOR_URL: 'http://127.0.0.1:1/',
      MAKA_HARBOR_TOOL_EXECUTOR_TOKEN: 'token',
    });

    // Spawning managed processes locally for a remote workspace would put them
    // on the host beside the credentials, not in the task container.
    assert.equal(executor.shellSessions, undefined);
    const names = toolNames(executor);
    assert.ok(!names.includes('WriteStdin'));
    assert.ok(!names.includes('StopBackgroundTask'));
    assert.deepEqual(Object.keys(shapeOf(buildIsolatedBashTool(executor).parameters)).sort(), [
      'command',
      'timeout_ms',
    ]);
  });

  test('an in-container executor binds background, stdin, and ref reads together', () => {
    const executor = createHarborCellLocalToolExecutor({});
    const names = toolNames(executor);

    assert.ok(names.includes('WriteStdin'), 'a ref the model cannot write to is a dead ref');
    assert.ok(names.includes('StopBackgroundTask'));
    const bash = Object.keys(shapeOf(buildIsolatedBashTool(executor).parameters)).sort();
    assert.deepEqual(bash, ['command', 'pty', 'run_in_background', 'timeout_ms']);
    // No sandbox manager exists behind an external isolation boundary, so the
    // model is never asked to declare an authority nothing would enforce.
    assert.ok(!bash.includes('required_boundary'));
  });

  test('managed commands inherit the executor’s stripped env, not the cell’s credentials', async () => {
    const cwd = await workspace();
    const secretName = 'MAKA_MANAGED_SHELL_TEST_API_KEY';
    const publicName = 'MAKA_MANAGED_SHELL_TEST_PUBLIC';
    process.env[secretName] = 'provider-credential';
    process.env[publicName] = 'visible';
    try {
      const bash = buildIsolatedBashTool(createHarborCellLocalToolExecutor({}));
      const result = (await bash.impl(
        { command: `printenv ${secretName} || true; printenv ${publicName} || true` },
        toolCtx(cwd),
      )) as { output: { stdout: string } };

      // ShellRunProcessManager falls back to the headless process's own env when
      // a launch carries none, and in a Harbor cell that env holds the key the
      // cell uses to call the model.
      assert.ok(
        !result.output.stdout.includes('provider-credential'),
        'provider credential reached the model’s shell',
      );
      assert.ok(result.output.stdout.includes('visible'), 'non-secret env still passes through');
    } finally {
      delete process.env[secretName];
      delete process.env[publicName];
    }
  });

  test('a PTY task survives across calls: start, write, read back, stop', async () => {
    const cwd = await workspace();
    const executor = createHarborCellLocalToolExecutor({});
    const sessions = executor.shellSessions;
    assert.ok(sessions);
    const surface = buildIsolatedHeadlessProductToolSurface(executor);
    const tool = (name: string) => {
      const found = surface.tools.find((entry) => entry.name === name);
      assert.ok(found, `${name} is not bound`);
      return found;
    };

    const started = (await tool('Bash').impl(
      { command: 'cat', run_in_background: true, pty: true },
      toolCtx(cwd, 'tool-start'),
    )) as { kind: string; ref: string };
    assert.equal(started.kind, 'shell_run');

    // The whole point of the seam: a second tool call reaches the SAME process.
    const written = (await tool('WriteStdin').impl(
      { ref: started.ref, input: 'interactive-round-trip\r' },
      toolCtx(cwd, 'tool-write'),
    )) as { kind: string };
    assert.equal(written.kind, 'shell_run');

    // WriteStdin returns the screen at its own parser cut, which may precede the
    // child's echo; later output is observed by reading the ref, as its
    // description tells the model.
    let screen = '';
    for (
      let attempt = 0;
      attempt < 50 && !screen.includes('interactive-round-trip');
      attempt += 1
    ) {
      const observed = (await tool('Read').impl(
        { ref: started.ref },
        toolCtx(cwd, `tool-read-${attempt}`),
      )) as { kind: string; output: { mode: string; screen: string } };
      assert.equal(observed.output.mode, 'pty');
      screen = observed.output.screen;
      if (!screen.includes('interactive-round-trip')) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.match(screen, /interactive-round-trip/);

    const stopped = (await tool('StopBackgroundTask').impl(
      { ref: started.ref },
      toolCtx(cwd, 'tool-stop'),
    )) as { status: string };
    assert.equal(stopped.status, 'cancelled');
  });

  test('terminateAll kills the actual process, not just its record', async () => {
    const cwd = await workspace();
    const executor = createHarborCellLocalToolExecutor({});
    const sessions = executor.shellSessions;
    assert.ok(sessions);
    const bash = buildIsolatedBashTool(executor);
    // A unique marker so process liveness is observable from outside the
    // manager: asserting only on the record would pass against an
    // implementation that terminalizes state without reaping the child.
    const marker = `maka-managed-marker-${process.pid}-${counter()}`;

    let started: { kind: string; ref: string; status: string };
    try {
      started = (await bash.impl(
        { command: longLivedCommand(cwd, marker), run_in_background: true },
        toolCtx(cwd, 'tool-sleep'),
      )) as { kind: string; ref: string; status: string };
      assert.equal(started.status, 'running');
      assert.ok(await waitForMarkedProcess(marker), 'the background process never started');
    } finally {
      // Terminate even when an assertion above fails, or the stray `sleep 600`
      // keeps the test runner's event loop alive for its full duration.
      await sessions.terminateAll();
    }

    assert.equal(await markedProcessCount(marker), 0, 'process survived into the grading phase');
    const after = (await sessions.readRuntimeResource(
      'session-1',
      started.ref,
      new AbortController().signal,
    )) as { status: string };
    assert.notEqual(after.status, 'running');
  });

  test('an aborted foreground command is cancelled, not left running', async () => {
    const cwd = await workspace();
    const executor = createHarborCellLocalToolExecutor({});
    const bash = buildIsolatedBashTool(executor);
    const controller = new AbortController();
    const marker = `maka-abort-marker-${process.pid}-${counter()}`;

    const pending = bash.impl(
      { command: longLivedCommand(cwd, marker) },
      {
        ...toolCtx(cwd, 'tool-abort'),
        abortSignal: controller.signal,
      },
    ) as Promise<{ status: string; exitCode?: number }>;
    let result: { status: string; exitCode?: number };
    try {
      assert.ok(await waitForMarkedProcess(marker), 'the command never started');
    } finally {
      controller.abort();
      result = await pending;
    }

    assert.equal(result.status, 'cancelled');
    assert.equal(await markedProcessCount(marker), 0, 'aborted command left its process running');
  });

  test('an unknown but well-formed ref reports a task, not a crash', async () => {
    const cwd = await workspace();
    const executor = createHarborCellLocalToolExecutor({});
    const read = toolFrom(executor, 'Read');

    await assert.rejects(
      async () =>
        await read.impl(
          { ref: `${SHELL_RUN_RESOURCE_PREFIX}/01JZZZZZZZZZZZZZZZZZZZZZZZ` },
          toolCtx(cwd),
        ),
      /not found in this session/,
    );
  });

  test('the model is told how to reach the capability, not just given the fields', () => {
    const executor = createHarborCellLocalToolExecutor({});
    const bash = buildIsolatedBashTool(executor);
    const read = toolFrom(executor, 'Read');

    // The description is the contract a model discovers the capability from;
    // pinning only the schema property names would let it be deleted silently.
    assert.match(bash.description ?? '', /run_in_background/);
    assert.match(bash.description ?? '', /pty=true/);
    assert.match(bash.description ?? '', /WriteStdin/);
    assert.match(bash.description ?? '', /isolated headless task workspace/);
    // No sandbox boundary exists here, so the model must not be told one is enforced.
    assert.ok(!/sandbox boundary/i.test(bash.description ?? ''));
    assert.match(read.description ?? '', /ref/);

    const parameters = bash.parameters as z.ZodType;
    assert.equal(parameters.safeParse({ command: 'x', pty: true }).success, false);
    assert.equal(
      parameters.safeParse({ command: 'x', timeout_ms: MAX_FOREGROUND_BASH_TIMEOUT_MS + 1 })
        .success,
      false,
    );
  });

  test('an operator floor above the foreground maximum caps the command instead of breaking Bash', async () => {
    const cwd = await workspace();
    // MAKA_CELL_COMMAND_TIMEOUT_MS raises the floor for slow builds and has no
    // documented ceiling. The managed launcher REJECTS anything past ten
    // minutes, so passing it through unclamped would fail every foreground
    // command in a cell that previously ran fine.
    const bash = buildIsolatedBashTool(
      createHarborCellLocalToolExecutor({ MAKA_CELL_COMMAND_TIMEOUT_MS: '900000' }),
    );

    const result = (await bash.impl({ command: 'echo floor-ok' }, toolCtx(cwd))) as {
      status: string;
      output: { stdout: string };
    };
    assert.equal(result.status, 'completed');
    assert.match(result.output.stdout, /floor-ok/);
  });

  test('the gcov cleanup carve-out survives the managed path', async () => {
    const cwd = await workspace();
    const timeouts: Array<number | undefined> = [];
    const sessions = recordingSessions(timeouts);
    const bash = buildIsolatedBashTool({
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      shellSessions: sessions,
    });

    await bash.impl({ command: 'rm -f *.gcda *.gcno *.gcov' }, toolCtx(cwd, 'tool-gcov'));
    await bash.impl({ command: 'echo other' }, toolCtx(cwd, 'tool-other'));

    // The same command must not be killed at a different time depending on
    // which isolation mode ran it.
    assert.deepEqual(timeouts, [120_000, 5_000]);
  });

  test('heavy-task evidence records a finished foreground command and nothing for a launch', async () => {
    const cwd = await workspace();
    const recorded: Array<{ name: string; result: Record<string, unknown> }> = [];
    const executor = createHarborCellLocalToolExecutor({});
    const bash = buildIsolatedBashTool(executor, {
      heavyTaskEvidence: {
        recordToolEvidence: async (input) => {
          recorded.push({
            name: input.name,
            result: input.result as unknown as Record<string, unknown>,
          });
          return {} as never;
        },
        recordArtifactEvidence: async () => ({}) as never,
      },
    });

    await bash.impl(
      { command: 'echo evidence-out; echo evidence-err >&2' },
      toolCtx(cwd, 'tool-fg'),
    );
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.name, 'Bash');
    assert.match(String(recorded[0]?.result.stdout), /evidence-out/);
    assert.match(String(recorded[0]?.result.stderr), /evidence-err/);
    assert.equal(recorded[0]?.result.exitCode, 0);

    const started = (await bash.impl(
      { command: 'sleep 600', run_in_background: true },
      toolCtx(cwd, 'tool-bg'),
    )) as { ref: string };
    // A launch has produced no command output, so it is not evidence.
    assert.equal(recorded.length, 1);
    await executor.shellSessions?.terminateAll();
    assert.ok(started.ref);
  });

  test('Read still refuses a path/ref pair and rejects non-runtime refs', async () => {
    const cwd = await workspace();
    const executor = createHarborCellLocalToolExecutor({});
    const read = buildIsolatedHeadlessProductToolSurface(executor).tools.find(
      (tool) => tool.name === 'Read',
    );
    assert.ok(read);

    const parsed = (read.parameters as z.ZodType).safeParse({
      path: 'a.txt',
      ref: 'maka://runtime/background-tasks/x',
    });
    assert.equal(parsed.success, false);

    await assert.rejects(
      async () => await read.impl({ ref: 'https://example.com/not-a-runtime-ref' }, toolCtx(cwd)),
      /Unsupported runtime resource ref/,
    );
  });
});
