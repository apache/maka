import assert from 'node:assert/strict';
import childProcess, {
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test, type TestContext } from 'node:test';
import {
  SHELL_RUN_SOURCE_TOOL_CALL_ID_MAX_BYTES,
  type ShellRunRecord,
  type ShellRunStore,
} from '@maka/core/shell-run';
import { type ShellRunUpdate, type ToolResultContent } from '@maka/core/events';
import { createSqliteShellRunStore } from '@maka/storage';

import { ShellRunProcessManager } from '../shell-run-manager.js';
import {
  ShellRunPtyControlClosedError,
  type ShellRunPtyDataEvent,
  type ShellRunProcessManagerInput,
} from '../shell-run-contract.js';
import { defaultShellPlan, type ShellPlan } from '../shell-detect.js';
import { PTY_PROTOCOL_REPLY_MAX_BYTES } from '../pty-screen-collector.js';

const NO_ABORT = new AbortController().signal;
const TEMPORARY_WORKSPACES = new Set<string>();

after(async () => {
  await Promise.all(
    [...TEMPORARY_WORKSPACES].map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('ShellRunProcessManager', () => {
  test('rejects unprojectable provider tool-call identities before durable admission', async () => {
    const cwd = await workspace();
    const store = createSqliteShellRunStore(cwd);
    const manager = createManager(store);
    const completions: boolean[] = [];
    const maximumMultibyteId = '😀'.repeat(SHELL_RUN_SOURCE_TOOL_CALL_ID_MAX_BYTES / 4);
    assert.equal(
      Buffer.byteLength(maximumMultibyteId, 'utf8'),
      SHELL_RUN_SOURCE_TOOL_CALL_ID_MAX_BYTES,
    );

    await assert.rejects(
      () =>
        manager.runBackgroundBash(
          shellInput({
            cwd,
            command: 'printf should-not-run',
            sourceToolCallId: `${maximumMultibyteId}x`,
            onCompletion: ({ successful }) => completions.push(successful),
          }),
        ),
      /ShellRun source tool-call ID must be non-empty/,
    );

    assert.deepEqual(await store.listSessionShellRuns('session-1'), []);
    assert.deepEqual(completions, [false]);
  });

  test('keeps the default pipe path separated, durable, redacted, and observed', async () => {
    const cwd = await workspace();
    const store = createSqliteShellRunStore(cwd);
    const manager = createManager(store);
    const result = await manager.runForegroundBash(
      shellInput({
        cwd,
        command: 'printf "hello"; printf "warning" >&2',
      }),
    );

    assert.equal(result.kind, 'terminal');
    assert.equal(result.status, 'completed');
    assert.equal(result.exitCode, 0);
    assert.equal(result.output.mode, 'pipes');
    if (result.output.mode !== 'pipes') throw new Error('expected pipes output');
    assert.equal(result.output.stdout, 'hello');
    assert.equal(result.output.stderr, 'warning');
    assert.equal(result.output.latestStream, 'stderr');

    const record = await store.readShellRun('session-1', 'shell-run-1');
    assert.equal(record.output.mode, 'pipes');
    assert.equal(record.status, 'completed');
    assert.ok(record.revision >= 2);
    assert.ok(record.observedAt !== undefined);
    assert.equal(manager.liveCount(), 0);
  });

  test('preserves CJK PowerShell output through pipes', {
    skip: process.platform === 'win32' ? false : 'Windows PowerShell 5.1 regression',
  }, async () => {
    const shell = windowsPowerShellPlan();
    assert.ok(shell, 'Windows PowerShell 5.1 must exist on the Windows baseline runner');
    const manager = await createTestManager();
    const result = await manager.runForegroundBash(
      shellInput({
        cwd: await workspace(),
        command:
          "if (Test-Path Env:__MAKA_RUNTIME_POWERSHELL_COMMAND) { throw 'internal command env leaked' }; New-Item -ItemType File -Path '中文文件名.txt' | Out-Null; Get-ChildItem -Name",
        shell,
      }),
    );

    assert.equal(result.kind, 'terminal');
    assert.equal(result.status, 'completed');
    assert.equal(result.exitCode, 0);
    assert.equal(result.output.mode, 'pipes');
    if (result.output.mode !== 'pipes') throw new Error('expected pipes output');
    assert.match(result.output.stdout, /中文文件名\.txt/u);
    assert.doesNotMatch(result.output.stdout, /\uFFFD/u);
  });

  test('uses the shared explicit PowerShell pipe plan', async () => {
    const manager = await createTestManager();
    const result = await manager.runForegroundBash(
      shellInput({
        cwd: await workspace(),
        command: 'echo wired-marker',
        shell: { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: '/bin/echo' },
      }),
    );

    assert.equal(result.kind, 'terminal');
    assert.equal(result.output.mode, 'pipes');
    if (result.output.mode !== 'pipes') throw new Error('expected pipes output');
    assert.match(result.output.stdout, /\$OutputEncoding = \$__makaUtf8/u);
    assert.match(result.output.stdout, /\$__makaCommand = \[ScriptBlock\]::Create/u);
    assert.doesNotMatch(result.output.stdout, /wired-marker/u);
  });

  test('runs explicit argv and supplies inherited fd payloads on the pipe path', async () => {
    const manager = await createTestManager();
    const result = await manager.runForegroundBash(
      shellInput({
        cwd: await workspace(),
        command: 'sandbox display command',
        argv: [
          process.execPath,
          '-e',
          'process.stdout.write(require("node:fs").readFileSync(3, "utf8"))',
        ],
        fdInputs: [{ fd: 3, data: Buffer.from('seccomp-payload') }],
      }),
    );

    assert.equal(result.kind, 'terminal');
    assert.equal(result.status, 'completed');
    assert.equal(result.output.mode, 'pipes');
    if (result.output.mode !== 'pipes') throw new Error('expected pipes output');
    assert.equal(result.output.stdout, 'seccomp-payload');
  });

  test('keeps foreground execution bounded and rejects PTY promotion', async () => {
    const cwd = await workspace();
    const store = createSqliteShellRunStore(await workspace());
    const manager = createManager(store);
    const abort = new AbortController();
    const running = manager.runForegroundBash(
      shellInput({
        cwd,
        command: waitForeverCommand(),
        abortSignal: abort.signal,
      }),
    );

    await waitUntil(async () => {
      try {
        const record = await store.readShellRun('session-1', 'shell-run-1');
        return record.status === 'running' && record.timeoutMs === 120_000;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    });
    abort.abort();
    assert.equal((await running).status, 'cancelled');
    await assert.rejects(
      () => manager.runForegroundBash(shellInput({ cwd, command: 'true', timeoutMs: 600_001 })),
      /Foreground Bash timeout/,
    );
    await assert.rejects(
      () => manager.runForegroundBash(shellInput({ cwd, command: 'true', pty: true })),
      /does not support PTY mode/,
    );
  });

  test('hands off a long pipe command without output and publishes monotonic revisions', async () => {
    const updates: ShellRunUpdate[] = [];
    const store = createSqliteShellRunStore(await workspace());
    const manager = createManager(store, (update) => updates.push(update));
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: 'printf "start"; sleep 0.4; printf "done"',
      }),
    );

    assert.equal(initial.kind, 'shell_run');
    assert.equal(initial.mode, 'pipes');
    assert.equal(initial.output, undefined);
    assert.equal((await store.readShellRun('session-1', 'shell-run-1')).timeoutMs, undefined);
    await waitForShellRun(
      manager,
      initial.ref,
      (result) => result.output?.mode === 'pipes' && result.output.stdout === 'start',
    );
    const runningUpdate = updates.find(
      (update) =>
        update.result.status === 'running' &&
        update.result.output?.mode === 'pipes' &&
        update.result.output.stdout === 'start',
    );
    assert.ok(runningUpdate);
    const running = await manager.readRuntimeResource('session-1', initial.ref, NO_ABORT);
    assertShellRun(running);
    assert.equal(running.output?.mode, 'pipes');
    if (running.output?.mode !== 'pipes') throw new Error('expected pipes output');
    assert.equal(running.output.stdout, 'start');

    await waitUntil(() => updates.some((update) => update.result.status === 'completed'));
    const terminal = updates.find((update) => update.result.status === 'completed')?.result;
    assert.equal(terminal?.output?.mode, 'pipes');
    if (terminal?.output?.mode !== 'pipes') throw new Error('expected terminal pipe update');
    assert.equal(terminal.output.stdout, 'startdone');
    assert.deepEqual(
      updates.map((update) => update.result.revision),
      [...updates.map((update) => update.result.revision)].sort((a, b) => a - b),
    );
  });

  test('notifies resource owners when foreground and background commands reach terminal state', async () => {
    const store = createSqliteShellRunStore(await workspace());
    const manager = createManager(store);
    const completions: boolean[] = [];
    await manager.runForegroundBash(
      shellInput({
        cwd: await workspace(),
        command: 'foreground completion',
        argv: [process.execPath, '-e', 'process.exit(0)'],
        onCompletion: (outcome) => completions.push(outcome.successful),
      }),
    );
    await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: 'background completion',
        argv: [process.execPath, '-e', 'process.exit(7)'],
        onCompletion: (outcome) => completions.push(outcome.successful),
      }),
    );

    await waitUntil(async () => {
      try {
        return (await store.readShellRun('session-1', 'shell-run-2')).status === 'failed';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    });
    await waitUntil(() => completions.length === 2);
    assert.deepEqual(completions, [true, false]);
  });

  test('notifies resource owners exactly once when startup fails before admission', async () => {
    const completions: boolean[] = [];
    const preAborted = new AbortController();
    preAborted.abort();
    const manager = await createTestManager();
    const cwd = await workspace();

    await assert.rejects(
      () =>
        manager.runForegroundBash(
          shellInput({
            cwd,
            command: 'pre-aborted',
            abortSignal: preAborted.signal,
            onCompletion: (outcome) => completions.push(outcome.successful),
          }),
        ),
      /aborted before shell process started/i,
    );
    await assert.rejects(() =>
      manager.runBackgroundBash(
        shellInput({
          cwd,
          command: 'invalid argv',
          argv: [],
          onCompletion: (outcome) => completions.push(outcome.successful),
        }),
      ),
    );
    const saturated = await createTestManager(undefined, { maxLiveShellRuns: 0 });
    await assert.rejects(() =>
      saturated.runForegroundBash(
        shellInput({
          cwd,
          command: 'slot rejected',
          onCompletion: (outcome) => completions.push(outcome.successful),
        }),
      ),
    );

    assert.deepEqual(completions, [false, false, false]);
  });

  test('commits a durable starting identity before the native pipe process spawns', async () => {
    const cwd = await workspace();
    const marker = join(cwd, 'spawned');
    const backingStore = createSqliteShellRunStore(cwd);
    const createCommitted = deferred<void>();
    const releaseCreate = deferred<void>();
    const store: ShellRunStore = {
      async createShellRun(record) {
        const created = await backingStore.createShellRun(record);
        createCommitted.resolve(undefined);
        await releaseCreate.promise;
        return created;
      },
      updateShellRun: (...args) => backingStore.updateShellRun(...args),
      readShellRun: (...args) => backingStore.readShellRun(...args),
      listSessionShellRuns: (...args) => backingStore.listSessionShellRuns(...args),
    };
    const manager = createManager(store);
    const startup = manager.runForegroundBash(
      shellInput({
        cwd,
        command: 'write spawn marker',
        argv: [
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`,
        ],
      }),
    );

    try {
      await createCommitted.promise;
      assert.equal(
        (await backingStore.readShellRun('session-1', 'shell-run-1')).status,
        'starting',
      );
      assert.equal(await manager.recoverOrphanedSession('session-1'), 0);
      assert.equal(
        (await backingStore.readShellRun('session-1', 'shell-run-1')).status,
        'starting',
      );
      await assert.rejects(() => readFile(marker, 'utf8'), { code: 'ENOENT' });
      releaseCreate.resolve(undefined);
      assert.equal((await startup).status, 'completed');
      assert.equal(await readFile(marker, 'utf8'), 'spawned');
    } finally {
      releaseCreate.resolve(undefined);
      await startup.catch(() => undefined);
      await manager.terminateAll();
    }
  });

  test('session close and runtime shutdown fence pipe startups blocked in durable creation', async () => {
    for (const lifecycle of ['session', 'runtime'] as const) {
      const cwd = await workspace();
      const marker = join(cwd, `${lifecycle}-spawned`);
      const backingStore = createSqliteShellRunStore(cwd);
      const createCommitted = deferred<void>();
      const releaseCreate = deferred<void>();
      const store: ShellRunStore = {
        async createShellRun(record) {
          const created = await backingStore.createShellRun(record);
          createCommitted.resolve(undefined);
          await releaseCreate.promise;
          return created;
        },
        updateShellRun: (...args) => backingStore.updateShellRun(...args),
        readShellRun: (...args) => backingStore.readShellRun(...args),
        listSessionShellRuns: (...args) => backingStore.listSessionShellRuns(...args),
      };
      const manager = createManager(store);
      const startup = manager.runForegroundBash(
        shellInput({
          cwd,
          command: `${lifecycle} startup fence`,
          argv: [
            process.execPath,
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`,
          ],
        }),
      );
      const rejectedStartup = assert.rejects(
        startup,
        lifecycle === 'session' ? /session lifecycle changed/ : /shell runtime is shutting down/,
      );
      let closing: Promise<void> | undefined;
      try {
        await createCommitted.promise;
        closing =
          lifecycle === 'session'
            ? manager.terminateSession('session-1').then((lease) => {
                manager.rollbackSessionClose(lease);
              })
            : manager.terminateAll();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await assert.rejects(() => readFile(marker, 'utf8'), { code: 'ENOENT' });

        releaseCreate.resolve(undefined);
        await rejectedStartup;
        await closing;
        const durable = await backingStore.readShellRun('session-1', 'shell-run-1');
        assert.equal(durable.status, 'failed');
        assert.ok(durable.observedAt !== undefined);
        await assert.rejects(() => readFile(marker, 'utf8'), { code: 'ENOENT' });
        assert.equal(manager.liveCount(), 0);
      } finally {
        releaseCreate.resolve(undefined);
        await startup.catch(() => undefined);
        await closing?.catch(() => undefined);
        await manager.terminateAll().catch(() => undefined);
      }
    }
  });

  test('rechecks the session fence after the durable running commit', async () => {
    const cwd = await workspace();
    const backingStore = createSqliteShellRunStore(cwd);
    const runningCommitted = deferred<void>();
    const releaseRunning = deferred<void>();
    const store: ShellRunStore = {
      createShellRun: (...args) => backingStore.createShellRun(...args),
      async updateShellRun(sessionId, shellRunId, patch) {
        const updated = await backingStore.updateShellRun(sessionId, shellRunId, patch);
        if (patch.status === 'running') {
          runningCommitted.resolve(undefined);
          await releaseRunning.promise;
        }
        return updated;
      },
      readShellRun: (...args) => backingStore.readShellRun(...args),
      listSessionShellRuns: (...args) => backingStore.listSessionShellRuns(...args),
    };
    const manager = createManager(store);
    const startup = manager.runForegroundBash(
      shellInput({
        cwd,
        command: waitForeverCommand(),
      }),
    );
    const rejectedStartup = assert.rejects(startup, /session lifecycle changed/);
    let closing: Promise<void> | undefined;

    try {
      await runningCommitted.promise;
      closing = manager.terminateSession('session-1').then((lease) => {
        manager.rollbackSessionClose(lease);
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseRunning.resolve(undefined);

      await rejectedStartup;
      await closing;
      const durable = await backingStore.readShellRun('session-1', 'shell-run-1');
      assert.equal(durable.status, 'failed');
      assert.ok(durable.observedAt !== undefined);
      assert.equal(manager.liveCount(), 0);
    } finally {
      releaseRunning.resolve(undefined);
      await startup.catch(() => undefined);
      await closing?.catch(() => undefined);
      await manager.terminateAll().catch(() => undefined);
    }
  });

  test('applies only explicit background timeouts and enforces their upper bound', async () => {
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: waitForeverCommand(),
        timeoutMs: 50,
      }),
    );

    const timedOut = await waitForTerminalShellRun(manager, initial.ref);
    assert.equal(timedOut.status, 'timed_out');
    assert.equal(timedOut.exitCode, 124);
    await assert.rejects(
      () =>
        manager.runBackgroundBash(
          shellInput({
            cwd: process.cwd(),
            command: 'true',
            timeoutMs: 86_400_001,
          }),
        ),
      /Background Bash timeout/,
    );
  });

  test('latches timeout when the root exits during POSIX process discovery', {
    skip: process.platform === 'win32' ? 'POSIX process discovery only' : false,
  }, async (context) => {
    const processDiscovery = delayPosixProcessDiscovery(context);
    const cwd = await workspace();
    const rootPidPath = join(cwd, 'root.pid');
    const rootScript = `
      const { writeFileSync } = require('node:fs');
      writeFileSync(${JSON.stringify(rootPidPath)}, String(process.pid));
      process.once('SIGUSR1', () => process.exit(0));
      setInterval(() => {}, 1000);
    `;
    const manager = await createTestManager();
    try {
      const initial = await manager.runBackgroundBash(
        shellInput({
          cwd,
          command: 'exit when the test releases the root process',
          argv: [process.execPath, '-e', rootScript],
          timeoutMs: 50,
        }),
      );
      assert.equal(initial.kind, 'shell_run');
      await waitUntil(async () => {
        try {
          return Number.isSafeInteger(Number.parseInt(await readFile(rootPidPath, 'utf8'), 10));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
      });
      await processDiscovery.started;
      const rootPid = Number.parseInt(await readFile(rootPidPath, 'utf8'), 10);
      assert.ok(Number.isSafeInteger(rootPid) && rootPid > 0);
      process.kill(rootPid, 'SIGUSR1');
      processDiscovery.release();

      const result = await waitForTerminalShellRun(manager, initial.ref);
      assert.equal(result.status, 'timed_out');
      assert.equal(result.exitCode, 124);
    } finally {
      processDiscovery.release();
      await manager.terminateAll().catch(() => undefined);
    }
  });

  test('preserves cancellation when timeout fires during POSIX process discovery', {
    skip: process.platform === 'win32' ? 'POSIX process discovery only' : false,
  }, async (context) => {
    const processDiscovery = delayPosixProcessDiscovery(context);
    const abort = new AbortController();
    const backingStore = createSqliteShellRunStore(await workspace());
    const runningCommitted = deferred<void>();
    const releaseRunning = deferred<void>();
    const store: ShellRunStore = {
      createShellRun: (...args) => backingStore.createShellRun(...args),
      async updateShellRun(sessionId, shellRunId, patch) {
        const updated = await backingStore.updateShellRun(sessionId, shellRunId, patch);
        if (patch.status === 'running') {
          runningCommitted.resolve(undefined);
          await releaseRunning.promise;
        }
        return updated;
      },
      readShellRun: (...args) => backingStore.readShellRun(...args),
      listSessionShellRuns: (...args) => backingStore.listSessionShellRuns(...args),
    };
    const manager = createManager(store);
    const run = manager.runForegroundBash(
      shellInput({
        cwd: await workspace(),
        command: waitForeverCommand('ready'),
        timeoutMs: 50,
        abortSignal: abort.signal,
      }),
    );

    try {
      await runningCommitted.promise;
      await processDiscovery.started;
      abort.abort();
      processDiscovery.release();
      releaseRunning.resolve(undefined);

      const result = await run;
      assert.equal(result.status, 'cancelled');
      assert.equal(result.exitCode, 130);
    } finally {
      processDiscovery.release();
      releaseRunning.resolve(undefined);
      await run.catch(() => undefined);
      await manager.terminateAll().catch(() => undefined);
    }
  });

  test('aborting foreground Bash terminates the process without leaking a ref', async () => {
    const abort = new AbortController();
    const manager = await createTestManager();
    const result = await manager.runForegroundBash(
      shellInput({
        cwd: await workspace(),
        command: 'printf "start"; sleep 5',
        abortSignal: abort.signal,
        emitOutput: () => abort.abort(),
      }),
    );

    assert.equal(result.kind, 'terminal');
    assert.equal(result.status, 'cancelled');
    assert.equal(result.exitCode, 130);
    assert.equal(manager.liveCount(), 0);
  });

  test('fences PTY starts admitted before session close and runtime shutdown', async () => {
    const cwd = await workspace();
    const sessionManager = await createTestManager();
    const sessionStart = assert.rejects(
      sessionManager.runBackgroundBash(
        shellInput({
          cwd,
          command: waitForeverCommand(),
          pty: true,
        }),
      ),
      /session lifecycle changed/,
    );

    await sessionManager.terminateSession('session-1');
    await sessionStart;
    await assert.rejects(
      () =>
        sessionManager.runBackgroundBash(
          shellInput({
            cwd,
            command: nodeCommand("process.stdout.write('blocked')"),
          }),
        ),
      /session lifecycle changed/,
    );
    sessionManager.resumeSession('session-1');
    const resumed = await sessionManager.runForegroundBash(
      shellInput({
        cwd,
        command: nodeCommand("process.stdout.write('RESUMED')"),
      }),
    );
    assert.equal(resumed.kind, 'terminal');
    if (resumed.kind !== 'terminal') throw new Error('expected terminal result');
    assert.equal(resumed.output.mode, 'pipes');
    if (resumed.output.mode !== 'pipes') throw new Error('expected pipe output');
    assert.equal(resumed.output.stdout, 'RESUMED');

    const runtimeManager = await createTestManager();
    const runtimeStart = assert.rejects(
      runtimeManager.runBackgroundBash(
        shellInput({
          cwd,
          command: waitForeverCommand(),
          pty: true,
        }),
      ),
      /shell runtime is shutting down/,
    );
    await runtimeManager.terminateAll();
    await runtimeStart;
    await assert.rejects(
      () =>
        runtimeManager.runBackgroundBash(
          shellInput({
            cwd,
            command: nodeCommand("process.stdout.write('blocked')"),
          }),
        ),
      /shell runtime is shutting down/,
    );
    assert.equal(sessionManager.liveCount(), 0);
    assert.equal(runtimeManager.liveCount(), 0);
  });

  test('keeps overlapping session close leases isolated through rollback and commit', async () => {
    const cwd = await workspace();
    const manager = await createTestManager();
    const first = await manager.terminateSession('session-1');
    const second = await manager.terminateSession('session-1');

    manager.rollbackSessionClose(first);
    await assert.rejects(
      () =>
        manager.runBackgroundBash(
          shellInput({
            cwd,
            command: nodeCommand("process.stdout.write('blocked')"),
          }),
        ),
      /session lifecycle changed/,
    );

    manager.rollbackSessionClose(second);
    const reopened = await manager.runForegroundBash(
      shellInput({
        cwd,
        command: nodeCommand("process.stdout.write('REOPENED')"),
      }),
    );
    assert.equal(reopened.kind, 'terminal');
    if (reopened.kind !== 'terminal') throw new Error('expected terminal result');
    assert.equal(reopened.output.mode, 'pipes');
    if (reopened.output.mode !== 'pipes') throw new Error('expected pipe output');
    assert.equal(reopened.output.stdout, 'REOPENED');

    const committed = await manager.terminateSession('session-1');
    manager.resumeSession('session-1');
    const admittedDuringReopen = await manager.runBackgroundBash(
      shellInput({
        cwd,
        command: waitForeverCommand(),
      }),
    );
    assert.equal(admittedDuringReopen.kind, 'shell_run');
    await manager.commitSessionClose(committed);
    assert.equal(manager.liveCount(), 0);
    await assert.rejects(
      () =>
        manager.runBackgroundBash(
          shellInput({
            cwd,
            command: nodeCommand("process.stdout.write('blocked')"),
          }),
        ),
      /session lifecycle changed/,
    );
    manager.resumeSession('session-1');
  });

  test('gives exactly one concurrent StopBackgroundTask call termination ownership', async () => {
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: 'printf "ready"; sleep 5',
      }),
    );
    assert.equal(initial.kind, 'shell_run');

    const [left, right] = await Promise.all([
      manager.stopBackgroundTask('session-1', initial.ref, NO_ABORT),
      manager.stopBackgroundTask('session-1', initial.ref, NO_ABORT),
    ]);
    assertShellRun(left);
    assertShellRun(right);
    assert.equal(left.status, 'cancelled');
    assert.equal(right.status, 'cancelled');
    assert.deepEqual(
      [left.operation, right.operation]
        .map((operation) => operation?.kind === 'stop' && operation.applied)
        .sort(),
      [false, true],
    );
    assert.equal(manager.liveCount(), 0);
  });

  test('ignores a Stop abort that occurs after another admitted Stop commits termination', {
    skip:
      process.platform === 'win32'
        ? 'Windows termination has no asynchronous POSIX snapshot window'
        : false,
  }, async () => {
    const cwd = await workspace();
    const committedPath = join(cwd, 'termination-committed');
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd,
        command: `exec ${nodeCommand(`
        const { writeFileSync } = require('node:fs');
        process.once('SIGTERM', () => {
          writeFileSync(${JSON.stringify(committedPath)}, 'committed');
          setTimeout(() => process.exit(0), 100);
        });
        process.stdout.write('READY\\n');
        setInterval(() => {}, 1000);
      `)}`,
        pty: true,
        timeoutMs: 5_000,
      }),
    );
    assert.equal(initial.kind, 'shell_run');
    await waitForPtyText(manager, initial.ref, /READY/);

    const laterAbort = new AbortController();
    const first = manager.stopBackgroundTask('session-1', initial.ref, NO_ABORT);
    const second = manager.stopBackgroundTask('session-1', initial.ref, laterAbort.signal);
    await waitUntil(async () => {
      try {
        await readFile(committedPath, 'utf8');
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    });
    laterAbort.abort();

    const [owner, joined] = await Promise.all([first, second]);
    assertShellRun(owner);
    assertShellRun(joined);
    assert.deepEqual(owner.operation, { kind: 'stop', applied: true });
    assert.deepEqual(joined.operation, { kind: 'stop', applied: false });
    assert.equal(owner.status, 'cancelled');
    assert.equal(joined.status, 'cancelled');
  });

  test('closes PTY control admission synchronously when Stop is admitted', async () => {
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: waitForeverCommand('READY\n'),
        pty: true,
        timeoutMs: 5_000,
      }),
    );
    assert.equal(initial.kind, 'shell_run');
    await waitForPtyText(manager, initial.ref, /READY/);

    const stopping = manager.stopBackgroundTask('session-1', initial.ref, NO_ABORT);
    await assert.rejects(
      () =>
        manager.writeStdin({
          sessionId: 'session-1',
          ref: initial.ref,
          input: 'late input',
          abortSignal: NO_ABORT,
        }),
      (error: unknown) =>
        error instanceof ShellRunPtyControlClosedError &&
        /stopping and no longer accepts input/.test(error.message),
    );
    const stopped = await stopping;
    assertShellRun(stopped);
    assert.deepEqual(stopped.operation, { kind: 'stop', applied: true });
  });

  test('closes PTY control at its mutation cut when shutdown starts after admission', async () => {
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: waitForeverCommand('READY\n'),
        pty: true,
        timeoutMs: 5_000,
      }),
    );
    assert.equal(initial.kind, 'shell_run');
    await waitForPtyText(manager, initial.ref, /READY/);

    const control = manager.writeStdin({
      sessionId: 'session-1',
      ref: initial.ref,
      input: 'late input',
      abortSignal: NO_ABORT,
    });
    const shutdown = manager.terminateAll();
    await assert.rejects(
      control,
      (error: unknown) => error instanceof ShellRunPtyControlClosedError,
    );
    await shutdown;
    const terminal = await manager.inspectResource('session-1', initial.ref);
    assert.equal(terminal.status, 'cancelled');
  });

  test('reopens PTY control only after every pre-commit Stop has aborted', async () => {
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: rawLineReaderCommand({ prompt: 'READY\n', label: 'VALUE:', lines: 1 }),
        pty: true,
        timeoutMs: 5_000,
      }),
    );
    assert.equal(initial.kind, 'shell_run');
    await waitForPtyText(manager, initial.ref, /READY/);

    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = assert.rejects(
      manager.stopBackgroundTask('session-1', initial.ref, firstAbort.signal),
      /aborted before termination was committed/,
    );
    const second = assert.rejects(
      manager.stopBackgroundTask('session-1', initial.ref, secondAbort.signal),
      /aborted before termination was committed/,
    );
    firstAbort.abort();
    const blocked = assert.rejects(
      manager.writeStdin({
        sessionId: 'session-1',
        ref: initial.ref,
        input: 'blocked',
        abortSignal: NO_ABORT,
      }),
      (error: unknown) =>
        error instanceof ShellRunPtyControlClosedError &&
        /stopping and no longer accepts input/.test(error.message),
    );
    secondAbort.abort();
    await Promise.all([first, blocked, second]);
    const control = await manager.writeStdin({
      sessionId: 'session-1',
      ref: initial.ref,
      input: 'resumed\r',
      abortSignal: NO_ABORT,
    });
    assert.deepEqual(control.operation, {
      kind: 'pty_control',
      failed: false,
      input: { bytes: 8, queued: true },
    });
    const completed = await waitForTerminalShellRun(manager, initial.ref);
    assertShellRunSnapshot(completed);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.output.mode, 'pty');
    if (completed.output.mode !== 'pty') throw new Error('expected pty output');
    assert.match(terminalText(completed.output), /VALUE:resumed/);
  });

  test('keeps a pipe task alive when Stop aborts during process-tree preparation', {
    skip:
      process.platform === 'win32'
        ? 'Windows termination does not take a POSIX process snapshot'
        : false,
  }, async () => {
    const cwd = await workspace();
    const childPidPath = join(cwd, 'child.pid');
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd,
        command: nodeCommand(`
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
        process.stdout.write('READY\\n');
        setInterval(() => {}, 1000);
      `),
        timeoutMs: 5_000,
      }),
    );
    assert.equal(initial.kind, 'shell_run');
    await waitUntil(async () => {
      try {
        await readFile(childPidPath, 'utf8');
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    });
    const childPid = Number.parseInt(await readFile(childPidPath, 'utf8'), 10);
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0);

    const abort = new AbortController();
    const rejected = assert.rejects(
      manager.stopBackgroundTask('session-1', initial.ref, abort.signal),
      /aborted before termination was committed/,
    );
    // The pipe path starts its asynchronous process-table read before returning.
    abort.abort();
    await rejected;

    const running = await manager.inspectResource('session-1', initial.ref);
    assert.equal(running.status, 'running');
    assert.equal(isProcessAlive(childPid), true);
    const stopped = await manager.stopBackgroundTask('session-1', initial.ref, NO_ABORT);
    assertShellRun(stopped);
    assert.deepEqual(stopped.operation, { kind: 'stop', applied: true });
    await waitUntil(() => !isProcessAlive(childPid));
  });

  test('keeps a PTY task controllable when Stop aborts during process-tree preparation', {
    skip:
      process.platform === 'win32'
        ? 'Windows termination does not take a POSIX process snapshot'
        : false,
  }, async () => {
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: rawLineReaderCommand({ prompt: 'READY\n', label: 'VALUE:', lines: 1 }),
        pty: true,
        timeoutMs: 5_000,
      }),
    );
    assert.equal(initial.kind, 'shell_run');
    await waitForPtyText(manager, initial.ref, /READY/);

    const abort = new AbortController();
    const rejected = assert.rejects(
      manager.stopBackgroundTask('session-1', initial.ref, abort.signal),
      /aborted before termination was committed/,
    );
    // Let the sequenced mutation enter its asynchronous process-table read.
    await Promise.resolve();
    abort.abort();
    const completion = manager.writeStdin({
      sessionId: 'session-1',
      ref: initial.ref,
      input: 'resumed\r',
      abortSignal: NO_ABORT,
    });
    const [, control] = await Promise.all([rejected, completion]);
    assert.deepEqual(control.operation, {
      kind: 'pty_control',
      failed: false,
      input: { bytes: 8, queued: true },
    });
    const completed = await waitForTerminalShellRun(manager, initial.ref);
    assertShellRunSnapshot(completed);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.output.mode, 'pty');
    if (completed.output.mode !== 'pty') throw new Error('expected pty output');
    assert.match(terminalText(completed.output), /VALUE:resumed/);
  });

  test('recovers durable starting and running records without live handles as orphaned', async () => {
    const store = createSqliteShellRunStore(await workspace());
    await store.createShellRun(record({ shellRunId: 'orphan-starting', status: 'starting' }));
    await store.createShellRun(record({ shellRunId: 'orphan-running', status: 'running' }));
    await store.createShellRun({
      ...record({ shellRunId: 'completed-1', status: 'running' }),
      status: 'completed',
      exitCode: 0,
      completedAt: 2,
    });
    const manager = createManager(store);

    assert.equal(await manager.recoverOrphanedSession('session-1'), 2);
    assert.equal(await manager.recoverOrphanedSession('session-1'), 0);
    const detail = await manager.readRuntimeResource(
      'session-1',
      'maka://runtime/background-tasks/orphan-starting',
      NO_ABORT,
    );
    assertShellRun(detail);
    assert.equal(detail.status, 'orphaned');
    assert.match(detail.failureMessage ?? '', /Runtime restarted/);
    assert.equal(detail.exitCode, undefined);
    assert.equal((await store.readShellRun('session-1', 'orphan-running')).status, 'orphaned');
    assert.equal((await store.readShellRun('session-1', 'completed-1')).status, 'completed');
  });

  test('concurrent orphan observers converge on the same durable terminal record', async () => {
    const backingStore = createSqliteShellRunStore(await workspace());
    await backingStore.createShellRun(
      record({ shellRunId: 'concurrent-orphan', status: 'running' }),
    );
    const readsReady = deferred<void>();
    let staleReads = 0;
    const store: ShellRunStore = {
      createShellRun: (...args) => backingStore.createShellRun(...args),
      updateShellRun: (...args) => backingStore.updateShellRun(...args),
      async readShellRun(...args) {
        const snapshot = await backingStore.readShellRun(...args);
        if (snapshot.shellRunId === 'concurrent-orphan' && staleReads < 2) {
          staleReads += 1;
          if (staleReads === 2) readsReady.resolve(undefined);
          await readsReady.promise;
        }
        return snapshot;
      },
      listSessionShellRuns: (...args) => backingStore.listSessionShellRuns(...args),
    };
    const manager = createManager(store);
    const ref = 'maka://runtime/background-tasks/concurrent-orphan';

    const [detail, stopped] = await Promise.all([
      manager.readRuntimeResource('session-1', ref, NO_ABORT),
      manager.stopBackgroundTask('session-1', ref, NO_ABORT),
    ]);

    assertShellRun(detail);
    assertShellRun(stopped);
    assert.equal(detail.status, 'orphaned');
    assert.equal(stopped.status, 'orphaned');
    assert.equal(detail.completedAt, stopped.completedAt);
    assert.equal(detail.failureMessage, stopped.failureMessage);
    const durable = await backingStore.readShellRun('session-1', 'concurrent-orphan');
    assert.equal(durable.status, 'orphaned');
    assert.equal(durable.completedAt, detail.completedAt);
  });

  test('keeps unauthorized refs non-disclosing and rejects malformed selectors before storage', async () => {
    const store = createSqliteShellRunStore(await workspace());
    await store.createShellRun({
      ...record({ shellRunId: 'owned-by-another-session', status: 'running' }),
      sessionId: 'session-2',
    });
    const manager = createManager(store);
    const refs = [
      'maka://runtime/background-tasks/unknown',
      'maka://runtime/background-tasks/owned-by-another-session',
    ];

    for (const ref of refs) {
      await assert.rejects(
        () => manager.readRuntimeResource('session-1', ref, NO_ABORT),
        (error: unknown) =>
          error instanceof Error &&
          (error as NodeJS.ErrnoException).code === 'ENOENT' &&
          error.message === 'Runtime background task not found in this session',
      );
    }

    await assert.rejects(
      () =>
        manager.readRuntimeResource(
          'session-1',
          'maka://runtime/background-tasks/%2Funsafe',
          NO_ABORT,
        ),
      // Same reply as the other two ref-parse sites: the canonical form and
      // where to get it, and no echo of the rejected string.
      (error: unknown) =>
        error instanceof Error &&
        /maka:\/\/runtime\/background-tasks\/<id>/.test(error.message) &&
        !error.message.includes('%2Funsafe'),
    );
  });

  test('runs with real TTY stdin/stdout at 80x24 and preserves the shell exit code', async () => {
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: nodeCommand(`
        const stdin = process.stdin.isTTY ? 'tty' : 'notty';
        const stdout = process.stdout.isTTY ? 'tty' : 'notty';
        process.stdout.write(
          'stdin=' + stdin + ' stdout=' + stdout + ' size=' + process.stdout.rows + ' ' + process.stdout.columns + '\\n',
          () => process.exit(23),
        );
      `),
        pty: true,
      }),
    );
    const result = await waitForTerminalShellRun(manager, initial.ref);

    assertShellRunSnapshot(result);
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 23);
    assert.equal(result.output.mode, 'pty');
    if (result.output.mode !== 'pty') throw new Error('expected pty output');
    assert.match(terminalText(result.output), /stdin=tty stdout=tty size=24 80/);
    assert.equal(result.output.cols, 80);
    assert.equal(result.output.rows, 24);
    assert.equal(manager.livePtyCount(), 0);
  });

  test('preserves CJK PowerShell output through a real PTY', {
    skip: process.platform === 'win32' ? false : 'Windows PowerShell 5.1 regression',
  }, async () => {
    const shell = windowsPowerShellPlan();
    assert.ok(shell, 'Windows PowerShell 5.1 must exist on the Windows baseline runner');
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command:
          "if (Test-Path Env:__MAKA_RUNTIME_POWERSHELL_COMMAND) { throw 'internal command env leaked' }; New-Item -ItemType File -Path '中文文件名.txt' | Out-Null; Get-ChildItem -Name",
        pty: true,
        shell,
      }),
    );
    const result = await waitForTerminalShellRun(manager, initial.ref);

    assert.equal(result.status, 'completed');
    assert.equal(result.exitCode, 0);
    assert.ok(result.output);
    assert.equal(result.output.mode, 'pty');
    if (result.output.mode !== 'pty') throw new Error('expected pty output');
    const output = terminalText(result.output);
    assert.match(output, /中文文件名\.txt/u);
    assert.doesNotMatch(output, /\uFFFD/u);
    assert.equal(manager.livePtyCount(), 0);
  });

  test('preserves the caller environment through a PowerShell PTY', {
    skip: process.platform === 'win32' ? false : 'Windows PowerShell 5.1 regression',
  }, async () => {
    const shell = windowsPowerShellPlan();
    assert.ok(shell, 'Windows PowerShell 5.1 must exist on the Windows baseline runner');
    const marker = 'maka-pty-caller-env';
    const previousHostOnly = process.env.MAKA_PTY_HOST_ONLY;
    process.env.MAKA_PTY_HOST_ONLY = 'must-not-leak';
    try {
      const manager = await createTestManager();
      const initial = await manager.runBackgroundBash(
        shellInput({
          cwd: await workspace(),
          command:
            'Write-Output "marker=$env:MAKA_PTY_CALLER_MARKER"; Write-Output "host=$env:MAKA_PTY_HOST_ONLY"',
          pty: true,
          shell,
          env: { MAKA_PTY_CALLER_MARKER: marker },
        }),
      );
      const result = await waitForTerminalShellRun(manager, initial.ref);

      assert.equal(result.status, 'completed');
      assert.ok(result.output);
      assert.equal(result.output.mode, 'pty');
      if (result.output.mode !== 'pty') throw new Error('expected pty output');
      const output = terminalText(result.output);
      assert.match(output, new RegExp(`marker=${marker}`));
      assert.match(output, /host=\r?\n/u);
      assert.doesNotMatch(output, /must-not-leak/u);
    } finally {
      if (previousHostOnly === undefined) delete process.env.MAKA_PTY_HOST_ONLY;
      else process.env.MAKA_PTY_HOST_ONLY = previousHostOnly;
    }
  });

  test('writes semantic text and Enter actions through a real PTY', async () => {
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: rawLineReaderCommand({ prompt: 'name? ', label: '\nhello:', lines: 1 }),
        pty: true,
        timeoutMs: 5_000,
      }),
    );
    assert.equal(initial.kind, 'shell_run');
    assert.equal(initial.mode, 'pty');
    await waitForPtyText(manager, initial.ref, /name\?/);

    const partial = await manager.writeStdin({
      sessionId: 'session-1',
      ref: initial.ref,
      actions: [{ type: 'text', text: '\u96ea\u{1F642}' }],
      abortSignal: NO_ABORT,
    });
    assert.equal(partial.status, 'running');
    assert.equal(partial.output?.mode, 'pty');
    if (partial.output?.mode !== 'pty') throw new Error('expected pty output');
    assert.doesNotMatch(terminalText(partial.output), /hello:/);
    assert.deepEqual(partial.operation, {
      kind: 'pty_control',
      failed: false,
      input: { bytes: 7, queued: true },
    });

    const control = await manager.writeStdin({
      sessionId: 'session-1',
      ref: initial.ref,
      actions: [{ type: 'key', key: 'enter' }],
      abortSignal: NO_ABORT,
    });
    assert.deepEqual(control.operation, {
      kind: 'pty_control',
      failed: false,
      input: { bytes: 1, queued: true },
    });
    const result = await waitForTerminalShellRun(manager, initial.ref);
    assertShellRunSnapshot(result);
    assert.equal(result.output.mode, 'pty');
    if (result.output.mode !== 'pty') throw new Error('expected pty output');
    assert.match(terminalText(result.output), /hello:\u96ea\u{1F642}/u);
  });

  test('rejects malformed PTY controls before commit without poisoning later input', async () => {
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: rawLineReaderCommand({ prompt: 'READY\n', label: 'VALUE:', lines: 1 }),
        pty: true,
        timeoutMs: 5_000,
      }),
    );
    assert.equal(initial.kind, 'shell_run');
    await waitForPtyText(manager, initial.ref, /READY/);
    const base = {
      sessionId: 'session-1',
      ref: initial.ref,
      abortSignal: NO_ABORT,
    };

    await assert.rejects(() => manager.writeStdin(base), /requires input, actions, and\/or size/);
    await assert.rejects(() => manager.writeStdin({ ...base, input: '' }), /must not be empty/);
    await assert.rejects(
      () => manager.writeStdin({ ...base, input: '\uD800' }),
      /well-formed Unicode/,
    );
    await assert.rejects(
      () => manager.writeStdin({ ...base, input: 'x'.repeat(64 * 1024 + 1) }),
      /exceeds the 65536-byte limit/,
    );
    await assert.rejects(
      () => manager.writeStdin({ ...base, size: { cols: 1, rows: 101 } }),
      /cols must be between 2 and 240/,
    );
    const control = await manager.writeStdin({
      ...base,
      input: 'ok\r',
    });
    assert.deepEqual(control.operation, {
      kind: 'pty_control',
      failed: false,
      input: { bytes: 3, queued: true },
    });
    const completed = await waitForTerminalShellRun(manager, initial.ref);
    assertShellRunSnapshot(completed);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.output.mode, 'pty');
    if (completed.output.mode !== 'pty') throw new Error('expected pty output');
    assert.match(terminalText(completed.output), /VALUE:ok/);
  });

  test('encodes keys from the terminal mode parsed before the control cut', async () => {
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: nodeCommand(`
        process.stdin.setRawMode?.(true);
        process.stdin.once('data', (chunk) => {
          const expected = Buffer.from([0x1b, 0x4f, 0x41]);
          const marker = chunk.equals(expected) ? 'APP-CURSOR-OK' : 'APP-CURSOR-WRONG';
          process.stdout.write(marker + '\\n', () => process.exit(0));
        });
        process.stdout.write('\\u001b[?1hREADY\\n');
      `),
        pty: true,
        timeoutMs: 5_000,
      }),
    );
    assert.equal(initial.kind, 'shell_run');
    await waitForPtyText(manager, initial.ref, /READY/);

    await manager.writeStdin({
      sessionId: 'session-1',
      ref: initial.ref,
      actions: [{ type: 'key', key: 'arrow_up' }],
      abortSignal: NO_ABORT,
    });
    const completed = await waitForTerminalShellRun(manager, initial.ref);
    assertShellRunSnapshot(completed);
    assert.equal(completed.output.mode, 'pty');
    if (completed.output.mode !== 'pty') throw new Error('expected pty output');
    assert.match(terminalText(completed.output), /APP-CURSOR-OK/);
  });

  test('encodes mouse actions from SGR cell mode parsed before the control cut', async () => {
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: nodeCommand(`
        process.stdin.setRawMode?.(true);
        const expected = Buffer.from('\\u001b[<0;3;4M\\u001b[<0;3;4m');
        let received = Buffer.alloc(0);
        process.stdin.on('data', (chunk) => {
          received = Buffer.concat([received, chunk]);
          if (received.length < expected.length) return;
          const marker = received.subarray(0, expected.length).equals(expected)
            ? 'SGR-MOUSE-OK'
            : 'SGR-MOUSE-WRONG:' + received.toString('hex');
          process.stdout.write(marker + '\\n', () => process.exit(0));
        });
        process.stdout.write('\\u001b[?1000;1016;1006hREADY\\n');
      `),
        pty: true,
        timeoutMs: 5_000,
      }),
    );
    assert.equal(initial.kind, 'shell_run');
    await waitForPtyText(manager, initial.ref, /READY/);

    const control = await manager.writeStdin({
      sessionId: 'session-1',
      ref: initial.ref,
      actions: [{ type: 'mouse', event: 'click', button: 'left', x: 2, y: 3 }],
      abortSignal: NO_ABORT,
    });
    assert.deepEqual(control.operation, {
      kind: 'pty_control',
      failed: false,
      input: { bytes: 18, queued: true },
    });
    const completed = await waitForTerminalShellRun(manager, initial.ref);
    assertShellRunSnapshot(completed);
    assert.equal(completed.output.mode, 'pty');
    if (completed.output.mode !== 'pty') throw new Error('expected pty output');
    assert.match(terminalText(completed.output), /SGR-MOUSE-OK/);
  });

  test('rejects unavailable mouse input without changing or terminating the PTY', async () => {
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: nodeCommand(`
        process.stdin.setRawMode?.(true);
        process.stdin.once('data', (chunk) => {
          const marker = chunk.equals(Buffer.from([0x0d])) ? 'KEYBOARD-OK' : 'KEYBOARD-WRONG';
          process.stdout.write(marker + '\\n', () => process.exit(0));
        });
        process.stdout.write('READY\\n');
      `),
        pty: true,
        timeoutMs: 5_000,
      }),
    );
    assert.equal(initial.kind, 'shell_run');
    await waitForPtyText(manager, initial.ref, /READY/);

    await assert.rejects(
      () =>
        manager.writeStdin({
          sessionId: 'session-1',
          ref: initial.ref,
          actions: [{ type: 'mouse', event: 'click', button: 'left', x: 90, y: 1 }],
          size: { cols: 100, rows: 30 },
          abortSignal: NO_ABORT,
        }),
      /has not enabled SGR cell mouse reporting/,
    );
    const afterRejection = await manager.inspectResource('session-1', initial.ref);
    assert.equal(afterRejection.status, 'running');
    assert.equal(afterRejection.output?.mode, 'pty');
    if (afterRejection.output?.mode !== 'pty') throw new Error('expected pty output');
    assert.deepEqual(
      { cols: afterRejection.output.cols, rows: afterRejection.output.rows },
      { cols: 80, rows: 24 },
    );

    await manager.writeStdin({
      sessionId: 'session-1',
      ref: initial.ref,
      actions: [{ type: 'key', key: 'enter' }],
      abortSignal: NO_ABORT,
    });
    const completed = await waitForTerminalShellRun(manager, initial.ref);
    assertShellRunSnapshot(completed);
    assert.equal(completed.output.mode, 'pty');
    if (completed.output.mode !== 'pty') throw new Error('expected pty output');
    assert.match(terminalText(completed.output), /KEYBOARD-OK/);
  });

  test('delivers Ctrl-C and Ctrl-D as terminal control characters', async () => {
    const manager = await createTestManager();
    const interrupted = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: controlCharacterCommand('\u0003', 'INT-SEEN'),
        pty: true,
        timeoutMs: 5_000,
      }),
    );
    assert.equal(interrupted.kind, 'shell_run');
    await waitForPtyText(manager, interrupted.ref, /READY/);

    const ctrlCControl = await manager.writeStdin({
      sessionId: 'session-1',
      ref: interrupted.ref,
      input: '\u0003',
      abortSignal: NO_ABORT,
    });
    assert.deepEqual(ctrlCControl.operation, {
      kind: 'pty_control',
      failed: false,
      input: { bytes: 1, queued: true },
    });
    const ctrlC = await waitForTerminalShellRun(manager, interrupted.ref);
    assertShellRunSnapshot(ctrlC);
    assert.equal(ctrlC.status, 'completed');
    assert.equal(ctrlC.output.mode, 'pty');
    if (ctrlC.output.mode !== 'pty') throw new Error('expected pty output');
    assert.match(terminalText(ctrlC.output), /INT-SEEN/);

    const awaitingEof = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: controlCharacterCommand('\u0004', 'EOF-SEEN'),
        pty: true,
        timeoutMs: 5_000,
      }),
    );
    assert.equal(awaitingEof.kind, 'shell_run');
    await waitForPtyText(manager, awaitingEof.ref, /READY/);

    const ctrlDControl = await manager.writeStdin({
      sessionId: 'session-1',
      ref: awaitingEof.ref,
      input: '\u0004',
      abortSignal: NO_ABORT,
    });
    assert.deepEqual(ctrlDControl.operation, {
      kind: 'pty_control',
      failed: false,
      input: { bytes: 1, queued: true },
    });
    const ctrlD = await waitForTerminalShellRun(manager, awaitingEof.ref);
    assertShellRunSnapshot(ctrlD);
    assert.equal(ctrlD.status, 'completed');
    assert.equal(ctrlD.output.mode, 'pty');
    if (ctrlD.output.mode !== 'pty') throw new Error('expected pty output');
    assert.match(terminalText(ctrlD.output), /EOF-SEEN/);
  });

  test('keeps concurrent PTY controls FIFO without an output-observation wait', async () => {
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: rawLineReaderCommand({ prompt: 'READY\n', label: 'SEEN:', lines: 3 }),
        pty: true,
        timeoutMs: 5_000,
      }),
    );
    assert.equal(initial.kind, 'shell_run');
    await waitForPtyText(manager, initial.ref, /READY/);

    const first = manager.writeStdin({
      sessionId: 'session-1',
      ref: initial.ref,
      input: 'one\r',
      size: { cols: 81, rows: 25 },
      abortSignal: NO_ABORT,
    });
    const second = manager.writeStdin({
      sessionId: 'session-1',
      ref: initial.ref,
      input: 'two\r',
      size: { cols: 82, rows: 26 },
      abortSignal: NO_ABORT,
    });
    const third = manager.writeStdin({
      sessionId: 'session-1',
      ref: initial.ref,
      input: 'three\r',
      size: { cols: 83, rows: 27 },
      abortSignal: NO_ABORT,
    });
    const controls = await Promise.all([first, second, third]);
    assert.deepEqual(
      controls.map((result) => result.operation),
      [
        {
          kind: 'pty_control',
          failed: false,
          input: { bytes: 4, queued: true },
          resize: { cols: 81, rows: 25, applied: true, changed: true },
        },
        {
          kind: 'pty_control',
          failed: false,
          input: { bytes: 4, queued: true },
          resize: { cols: 82, rows: 26, applied: true, changed: true },
        },
        {
          kind: 'pty_control',
          failed: false,
          input: { bytes: 6, queued: true },
          resize: { cols: 83, rows: 27, applied: true, changed: true },
        },
      ],
    );
    const snapshots = controls.map((control) => {
      assertShellRunSnapshot(control);
      return control;
    });
    assert.deepEqual(
      snapshots.map((control) =>
        control.output.mode === 'pty' ? [control.output.cols, control.output.rows] : undefined,
      ),
      [
        [81, 25],
        [82, 26],
        [83, 27],
      ],
    );
    assert.ok(snapshots[0]!.revision < snapshots[1]!.revision);
    assert.ok(snapshots[1]!.revision < snapshots[2]!.revision);
    const completed = await waitForTerminalShellRun(manager, initial.ref);
    assertShellRunSnapshot(completed);
    assert.equal(completed.output.mode, 'pty');
    if (completed.output.mode !== 'pty') throw new Error('expected pty output');
    assert.deepEqual([completed.output.cols, completed.output.rows], [83, 27]);
    assert.match(terminalText(completed.output), /SEEN:one\nSEEN:two\nSEEN:three/);
  });

  test('publishes raw PTY deltas and exposes a bounded replay snapshot', async () => {
    const cwd = await workspace();
    const events: ShellRunPtyDataEvent[] = [];
    const manager = createManager(createSqliteShellRunStore(cwd), undefined, {
      onPtyData: (event) => events.push(event),
    });
    const run = await manager.runBackgroundBash(
      shellInput({
        cwd,
        command:
          "printf 'RAW-READY\\n'; IFS= read -r line; " +
          'printf \'RAW-VALUE:%s\\n\' "$line"; while :; do sleep 1; done',
        pty: true,
        timeoutMs: 5_000,
      }),
    );
    assert.equal(run.kind, 'shell_run');
    await waitForPtyText(manager, run.ref, /RAW-READY/);

    const initial = manager.getLivePtySnapshot('session-1', run.ref);
    assert.ok(initial);
    assert.match(initial.buffer, /RAW-READY/);
    await waitUntil(() => events.length > 0);
    assert.ok((events.at(-1)?.sequence ?? 0) >= initial.sequence);
    assert.deepEqual(
      events.map(({ sessionId, ref }) => ({ sessionId, ref })),
      events.map(() => ({ sessionId: 'session-1', ref: run.ref })),
    );

    await manager.writeStdin({
      sessionId: 'session-1',
      ref: run.ref,
      input: 'hello\n',
    });
    await waitForPtyText(manager, run.ref, /RAW-VALUE:hello/);
    const latest = manager.getLivePtySnapshot('session-1', run.ref);
    assert.ok(latest);
    assert.ok(latest.sequence > initial.sequence);
    assert.match(latest.buffer, /RAW-VALUE:hello/);
    await manager.stopBackgroundTask('session-1', run.ref, NO_ABORT);
  });

  test('keeps concurrent PTY control and Read persistence in parser-cut order', async () => {
    const updates: ShellRunUpdate[] = [];
    const store = createSqliteShellRunStore(await workspace());
    const manager = createManager(store, (update) => updates.push(update));
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: nodeCommand(`
        process.stdout.write('READY\\n');
        setInterval(() => {}, 1000);
      `),
        pty: true,
        timeoutMs: 5_000,
      }),
    );
    assert.equal(initial.kind, 'shell_run');

    try {
      await waitForPtyText(manager, initial.ref, /READY/);
      const first = manager.writeStdin({
        sessionId: 'session-1',
        ref: initial.ref,
        size: { cols: 81, rows: 25 },
        abortSignal: NO_ABORT,
      });
      const second = manager.writeStdin({
        sessionId: 'session-1',
        ref: initial.ref,
        size: { cols: 82, rows: 26 },
        abortSignal: NO_ABORT,
      });
      const read = manager.inspectResource('session-1', initial.ref);
      const [firstControl, secondControl, observed] = await Promise.all([first, second, read]);

      assertShellRunSnapshot(firstControl);
      assertShellRunSnapshot(secondControl);
      assertShellRunSnapshot(observed);
      assert.equal(firstControl.output.mode, 'pty');
      assert.equal(secondControl.output.mode, 'pty');
      assert.equal(observed.output.mode, 'pty');
      if (
        firstControl.output.mode !== 'pty' ||
        secondControl.output.mode !== 'pty' ||
        observed.output.mode !== 'pty'
      )
        throw new Error('expected pty output');
      assert.deepEqual([firstControl.output.cols, firstControl.output.rows], [81, 25]);
      assert.deepEqual([secondControl.output.cols, secondControl.output.rows], [82, 26]);
      assert.deepEqual([observed.output.cols, observed.output.rows], [82, 26]);
      assert.ok(firstControl.revision < secondControl.revision);
      assert.equal(secondControl.revision, observed.revision);

      const controlSizes = updates.flatMap(({ result }) =>
        result.output?.mode === 'pty' && result.output.cols >= 81
          ? [[result.output.cols, result.output.rows]]
          : [],
      );
      assert.deepEqual(controlSizes, [
        [81, 25],
        [82, 26],
      ]);
      const durable = await store.readShellRun('session-1', 'shell-run-1');
      assert.equal(durable.output.mode, 'pty');
      if (durable.output.mode !== 'pty') throw new Error('expected durable pty output');
      assert.deepEqual([durable.output.cols, durable.output.rows], [82, 26]);
    } finally {
      await manager.stopBackgroundTask('session-1', initial.ref, NO_ABORT);
    }
  });

  test('joins finalization when a real PTY exits before a queued control cut', async () => {
    const cwd = await workspace();
    const dsrSeen = join(cwd, 'dsr-seen');
    const exitGate = join(cwd, 'exit-gate');
    const sizeBeforeExit = join(cwd, 'size-before-exit');
    const store = createSqliteShellRunStore(await workspace());
    const manager = createManager(store);
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd,
        command: nodeCommand(`
        const { readFileSync, writeFileSync } = require('node:fs');
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        let received = Buffer.alloc(0);
        let started = false;
        let armed = false;

        const exitWhenReleased = () => {
          try {
            readFileSync(${JSON.stringify(exitGate)});
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            setImmediate(exitWhenReleased);
            return;
          }
          writeFileSync(
            ${JSON.stringify(sizeBeforeExit)},
            process.stdout.columns + 'x' + process.stdout.rows,
          );
          process.exit(0);
        };

        process.stdin.on('data', (chunk) => {
          received = Buffer.concat([received, chunk]);
          if (!started && received.includes(Buffer.from('START'))) {
            started = true;
            process.stdout.write(
              '\\u001b[5n' + '\\u001b[2K\\r.'.repeat(256 * 1024),
            );
          }
          if (!armed && received.includes(Buffer.from('\\u001b[0n'))) {
            armed = true;
            writeFileSync(${JSON.stringify(dsrSeen)}, '1b5b306e');
            exitWhenReleased();
          }
        });

        process.stdout.write(
          'READY:' + process.stdout.columns + 'x' + process.stdout.rows + '\\n',
        );
      `),
        pty: true,
        timeoutMs: 15_000,
      }),
    );
    assert.equal(initial.kind, 'shell_run');

    try {
      await waitForPtyText(manager, initial.ref, /READY:80x24/);
      const prime = await manager.writeStdin({
        sessionId: 'session-1',
        ref: initial.ref,
        input: 'START',
        abortSignal: NO_ABORT,
      });
      assert.deepEqual(prime.operation, {
        kind: 'pty_control',
        failed: false,
        input: { bytes: 5, queued: true },
      });
      await waitUntil(async () => {
        try {
          return (await readFile(dsrSeen, 'utf8')) === '1b5b306e';
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
      }, 15_000);

      const pending = manager.writeStdin({
        sessionId: 'session-1',
        ref: initial.ref,
        size: { cols: 81, rows: 25 },
        abortSignal: NO_ABORT,
      });
      await writeFile(exitGate, 'exit');
      const control = await pending;

      assert.equal(await readFile(sizeBeforeExit, 'utf8'), '80x24');
      assertShellRunSnapshot(control);
      assert.equal(control.status, 'completed');
      assert.equal(control.exitCode, 0);
      assert.deepEqual(control.operation, {
        kind: 'pty_control',
        failed: false,
        resize: { cols: 81, rows: 25, applied: false, changed: false },
      });
      assert.equal(control.output.mode, 'pty');
      if (control.output.mode !== 'pty') throw new Error('expected pty output');
      assert.deepEqual([control.output.cols, control.output.rows], [80, 24]);

      const durable = await store.readShellRun('session-1', 'shell-run-1');
      assert.equal(durable.status, 'completed');
      assert.equal(durable.revision, control.revision);
      assert.equal(manager.liveCount(), 0);
    } finally {
      if (manager.liveCount() > 0) {
        await manager.stopBackgroundTask('session-1', initial.ref, NO_ABORT);
      }
    }
  });

  test('rejects WriteStdin aborted before commit without stopping the PTY', async () => {
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: nodeCommand(`
        process.stdin.setRawMode?.(true);
        process.stdin.setEncoding('utf8');
        process.stdout.write('READY\\n');
        process.stdin.once('data', (chunk) => process.stdout.write('SEEN:' + chunk + '\\n'));
        setInterval(() => {}, 1000);
      `),
        pty: true,
        timeoutMs: 5_000,
      }),
    );
    assert.equal(initial.kind, 'shell_run');
    await waitForPtyText(manager, initial.ref, /READY/);

    const abortedBeforeCommit = new AbortController();
    abortedBeforeCommit.abort();
    await assert.rejects(
      () =>
        manager.writeStdin({
          sessionId: 'session-1',
          ref: initial.ref,
          input: 'discarded',
          abortSignal: abortedBeforeCommit.signal,
        }),
      /aborted before the control operation was committed/,
    );

    assert.equal((await manager.inspectResource('session-1', initial.ref)).status, 'running');
    await manager.stopBackgroundTask('session-1', initial.ref, NO_ABORT);
  });

  test('restores the trailing PTY flush after a queued control aborts before commit', async () => {
    const cwd = await workspace();
    const dirtyTrigger = join(cwd, 'emit-dirty');
    const dirtyWritten = join(cwd, 'dirty-written');
    const store = createSqliteShellRunStore(await workspace());
    // The test owns flush timing: no automatic flush fires until it says so, so the
    // "not yet committed" window cannot be closed by a periodic flush racing the clock.
    const flushes = manualFlushScheduler();
    const manager = createManager(store, undefined, {
      flushIntervalMs: 60_000,
      scheduleFlush: flushes.schedule,
    });
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd,
        command: nodeCommand(`
        const { existsSync, writeFileSync } = require('node:fs');
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdout.write('READY\\n');
        let protocolReply = Buffer.alloc(0);
        const trigger = setInterval(() => {
          if (!existsSync(${JSON.stringify(dirtyTrigger)})) return;
          clearInterval(trigger);
          process.stdout.write('DIRTY\\n\\u001b[5n');
        }, 5);
        process.stdin.on('data', (chunk) => {
          protocolReply = Buffer.concat([protocolReply, chunk]);
          if (protocolReply.includes(Buffer.from('\\u001b[0n'))) {
            writeFileSync(${JSON.stringify(dirtyWritten)}, 'written');
          }
        });
        setInterval(() => {}, 1000);
      `),
        pty: true,
        // Far past the test's own waits: a run timeout would finalize the record and
        // advance the revision the assertions below pin.
        timeoutMs: 120_000,
      }),
    );
    assert.equal(initial.kind, 'shell_run');

    try {
      await waitForPtyText(manager, initial.ref, /READY/);
      const beforeDirty = await store.readShellRun('session-1', 'shell-run-1');
      await writeFile(dirtyTrigger, 'emit');
      await waitUntil(async () => {
        try {
          return (await readFile(dirtyWritten, 'utf8')) === 'written';
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
      });
      const beforeAbort = await store.readShellRun('session-1', 'shell-run-1');
      assert.equal(beforeAbort.revision, beforeDirty.revision);
      assert.equal(beforeAbort.output.mode, 'pty');
      if (beforeAbort.output.mode !== 'pty') throw new Error('expected durable pty output');
      assert.doesNotMatch(terminalText(beforeAbort.output), /DIRTY/);

      const abort = new AbortController();
      const control = manager.writeStdin({
        sessionId: 'session-1',
        ref: initial.ref,
        size: { cols: 81, rows: 25 },
        abortSignal: abort.signal,
      });
      abort.abort();
      await assert.rejects(control, /aborted before the control operation was committed/);

      // The contract: the aborted control restores the trailing flush instead of
      // dropping it, so a flush is pending again and commits the PTY output once it runs.
      await waitUntil(() => flushes.pending());
      flushes.runPending();
      await waitUntil(async () => {
        const durable = await store.readShellRun('session-1', 'shell-run-1');
        return (
          durable.revision > beforeDirty.revision &&
          durable.output.mode === 'pty' &&
          /DIRTY/.test(terminalText(durable.output))
        );
      });
    } finally {
      await manager.stopBackgroundTask('session-1', initial.ref, NO_ABORT);
    }
  });

  test('linearizes native resize, collector resize, input, and snapshot on a real PTY', async () => {
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: nodeCommand(`
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdout.write('ready\\n');
        process.stdin.once('data', () => setTimeout(() => {
          process.stdout.write(process.stdout.rows + ' ' + process.stdout.columns + '\\n', () => process.exit(0));
        }, 20));
      `),
        pty: true,
        timeoutMs: 5_000,
      }),
    );
    assert.equal(initial.kind, 'shell_run');
    await waitForPtyText(manager, initial.ref, /ready/i);

    const unchanged = await manager.writeStdin({
      sessionId: 'session-1',
      ref: initial.ref,
      size: { cols: 80, rows: 24 },
      abortSignal: NO_ABORT,
    });
    assert.deepEqual(unchanged.operation, {
      kind: 'pty_control',
      failed: false,
      resize: { cols: 80, rows: 24, applied: true, changed: false },
    });

    const result = await manager.writeStdin({
      sessionId: 'session-1',
      ref: initial.ref,
      size: { cols: 100, rows: 30 },
      input: '\r',
      abortSignal: NO_ABORT,
    });
    assert.equal(result.output?.mode, 'pty');
    if (result.output?.mode !== 'pty') throw new Error('expected pty output');
    assert.equal(result.output.cols, 100);
    assert.equal(result.output.rows, 30);
    assert.deepEqual(result.operation, {
      kind: 'pty_control',
      failed: false,
      input: { bytes: 1, queued: true },
      resize: { cols: 100, rows: 30, applied: true, changed: true },
    });
    const completed = await waitForTerminalShellRun(manager, initial.ref);
    assertShellRunSnapshot(completed);
    assert.equal(completed.output.mode, 'pty');
    if (completed.output.mode !== 'pty') throw new Error('expected pty output');
    assert.match(terminalText(completed.output), /30 100/);
  });

  test('uses Unicode 11 cell widths for CJK, combining marks, and emoji', async () => {
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: nodeCommand("process.stdout.write('A\\u754ce\\u0301\\u{1F642}')"),
        pty: true,
      }),
    );
    const result = await waitForTerminalShellRun(manager, initial.ref);

    assertShellRunSnapshot(result);
    assert.equal(result.output.mode, 'pty');
    if (result.output.mode !== 'pty') throw new Error('expected pty output');
    assert.equal(result.output.screen, 'A\u754ce\u0301\u{1F642}');
    assert.deepEqual(result.output.cursor, { x: 6, y: 0, visible: true });
  });

  test('joins soft-wrapped scrollback into logical lines', async () => {
    const manager = await createTestManager();
    const script =
      "for (let i = 0; i < 30; i += 1) process.stdout.write(String(i).padStart(2, '0') + ':' + 'x'.repeat(90) + '\\n');";
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: nodeCommand(script),
        pty: true,
      }),
    );
    const result = await waitForTerminalShellRun(manager, initial.ref);

    assertShellRunSnapshot(result);
    assert.equal(result.output.mode, 'pty');
    if (result.output.mode !== 'pty') throw new Error('expected pty output');
    assert.match(result.output.scrollback, new RegExp(`00:${'x'.repeat(90)}`));
  });

  test('drains the final frame after parser backpressure and drops an evicted wrapped prefix', async () => {
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: nodeCommand(
          "process.stdout.write('x'.repeat(1536 * 1024)); process.stdout.write('\\nFINAL-DRAIN\\n');",
        ),
        pty: true,
        timeoutMs: 15_000,
      }),
    );
    const result = await waitForTerminalShellRun(manager, initial.ref, 15_000);

    assertShellRunSnapshot(result);
    assert.equal(result.status, 'completed');
    assert.equal(result.output.mode, 'pty');
    if (result.output.mode !== 'pty') throw new Error('expected pty output');
    assert.equal(result.output.truncated, true);
    assert.match(terminalText(result.output), /FINAL-DRAIN/);
    assert.doesNotMatch(result.output.scrollback, /x{80}/);
  });

  test('returns the redrawn screen rather than stale pre-clear text', async () => {
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: nodeCommand(`
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdout.write('stale-screen');
        process.stdin.once('data', () => {
          process.stdout.write('\\u001b[2J\\u001b[HABCDE\\rXY\\u001b[K\\n', () => process.exit(0));
        });
      `),
        pty: true,
        timeoutMs: 5_000,
      }),
    );
    assert.equal(initial.kind, 'shell_run');
    await waitForPtyText(manager, initial.ref, /stale-screen/);
    const control = await manager.writeStdin({
      sessionId: 'session-1',
      ref: initial.ref,
      input: '\r',
      abortSignal: NO_ABORT,
    });
    assert.deepEqual(control.operation, {
      kind: 'pty_control',
      failed: false,
      input: { bytes: 1, queued: true },
    });
    const result = await waitForTerminalShellRun(manager, initial.ref);
    assertShellRunSnapshot(result);
    assert.equal(result.output.mode, 'pty');
    if (result.output.mode !== 'pty') throw new Error('expected pty output');
    assert.match(result.output.screen, /^XY$/m);
    assert.doesNotMatch(result.output.screen, /stale-screen|ABCDE/);
  });

  test('captures only the latest alternate-screen epoch when a real PTY program leaves it', async () => {
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: nodeCommand(
          "process.stdout.write('\\u001b[?1049hOLD-ALT\\u001b[?1049l\\u001b[?1049hNEW-ALT\\u001b[?1049lNORMAL-FRAME\\n')",
        ),
        pty: true,
      }),
    );
    const result = await waitForTerminalShellRun(manager, initial.ref);
    assertShellRunSnapshot(result);
    assert.equal(result.output.mode, 'pty');
    if (result.output.mode !== 'pty') throw new Error('expected pty output');
    assert.match(result.output.screen, /NORMAL-FRAME/);
    assert.match(result.output.lastAlternateScreen ?? '', /NEW-ALT/);
    assert.doesNotMatch(result.output.lastAlternateScreen ?? '', /OLD-ALT/);
  });

  test('consumes terminal side channels while preserving visible hyperlink text', async () => {
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: nodeCommand(
          "process.stdout.write('\\u001b]0;HIDDEN-TITLE-0\\u0007\\u001b]1;HIDDEN-TITLE-1\\u0007\\u001b]2;HIDDEN-TITLE-2\\u0007\\u001b]7;file:///HIDDEN-CWD\\u0007\\u001b]52;c;Q0xJUEJPQVJE\\u0007\\u001b]8;;https://hidden.example\\u0007VISIBLE-LINK\\u001b]8;;\\u0007\\u001b]9;HIDDEN-NOTICE-9\\u0007\\u001b]777;HIDDEN-NOTICE-777\\u0007\\u0007\\n')",
        ),
        pty: true,
      }),
    );
    const result = await waitForTerminalShellRun(manager, initial.ref);
    assertShellRunSnapshot(result);
    assert.equal(result.output.mode, 'pty');
    if (result.output.mode !== 'pty') throw new Error('expected pty output');
    const text = terminalText(result.output);
    assert.match(text, /VISIBLE-LINK/);
    assert.doesNotMatch(text, /HIDDEN-|Q0xJUEJPQVJE|hidden\.example/);
  });

  test('writes xterm protocol replies back to the real PTY synchronously', async () => {
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: nodeCommand(`
        process.stdin.setRawMode?.(true);
        let reply = Buffer.alloc(0);
        process.stdin.on('data', (chunk) => {
          reply = Buffer.concat([reply, chunk]);
          if (reply.length >= 4) {
            process.stdout.write('DSR:' + reply.subarray(0, 4).toString('hex') + '\\n', () => process.exit(0));
          }
        });
        process.stdout.write('\\u001b[5n');
      `),
        pty: true,
        timeoutMs: 5_000,
      }),
    );
    const result = await waitForTerminalShellRun(manager, initial.ref);
    assertShellRunSnapshot(result);
    assert.equal(result.output.mode, 'pty');
    if (result.output.mode !== 'pty') throw new Error('expected pty output');
    assert.match(terminalText(result.output), /DSR:1b5b306e/);
  });

  test('fails closed before terminal protocol replies can form an unbounded native write queue', async () => {
    const manager = await createTestManager();
    const queries = Math.floor(PTY_PROTOCOL_REPLY_MAX_BYTES / 4) + 1;
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: nodeCommand(`
        process.stdin.setRawMode?.(true);
        process.stdin.pause();
        const query = '\\u001b[5n'.repeat(${queries});
        process.stdout.write(query);
        setInterval(() => {}, 1000);
      `),
        pty: true,
        timeoutMs: 10_000,
      }),
    );
    const result = await waitForTerminalShellRun(manager, initial.ref, 10_000);
    assertShellRunSnapshot(result);
    assert.equal(result.status, 'failed');
    assert.match(result.failureMessage ?? '', /protocol replies exceeded/);
    assert.equal(manager.liveCount(), 0);
    assert.equal(manager.livePtyCount(), 0);
  });

  test('redacts a secret across a soft wrap and the scrollback/screen boundary', async () => {
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const manager = await createTestManager();
    const initial = await manager.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: nodeCommand(`
        process.stdout.write(${JSON.stringify(`${'x'.repeat(73)} ${secret}\n`)});
        for (let line = 1; line <= 22; line += 1) process.stdout.write('line-' + line + '\\n');
      `),
        pty: true,
      }),
    );
    const result = await waitForTerminalShellRun(manager, initial.ref);
    assertShellRunSnapshot(result);
    assert.equal(result.output.mode, 'pty');
    if (result.output.mode !== 'pty') throw new Error('expected pty output');
    const text = terminalText(result.output);
    assert.equal(result.output.redacted, true);
    assert.match(text, /\[redacted\]/);
    assert.doesNotMatch(text, new RegExp(secret));
  });

  test('settles after root exit when a detached descendant retains inherited stdout', {
    skip: process.platform === 'win32' ? 'POSIX detached process-group semantics required' : false,
  }, async () => {
    const cwd = await workspace();
    const childPidPath = join(cwd, 'escaped-child.pid');
    const manager = await createTestManager(undefined, { pipeOutputDrainMs: 100 });
    let childPid: number | undefined;
    try {
      const result = await manager.runForegroundBash(
        shellInput({
          cwd,
          command: 'root exits while detached child inherits stdout',
          argv: [
            process.execPath,
            '-e',
            `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',process.stdout,'ignore']});child.unref();writeFileSync(${JSON.stringify(childPidPath)},String(child.pid));process.stdout.write('ROOT\\n')`,
          ],
        }),
      );
      childPid = Number.parseInt(await readFile(childPidPath, 'utf8'), 10);
      assert.equal(result.status, 'failed');
      assert.equal(result.output.mode, 'pipes');
      if (result.output.mode !== 'pipes') throw new Error('expected pipes output');
      assert.equal(result.output.stdoutTruncated, true);
      assert.match(result.failureMessage ?? '', /output pipes drained completely/);
      assert.equal(manager.liveCount(), 0);
    } finally {
      if (childPid && isProcessAlive(childPid)) {
        try {
          process.kill(-childPid, 'SIGKILL');
        } catch {
          try {
            process.kill(childPid, 'SIGKILL');
          } catch {
            /* descendant already exited */
          }
        }
      }
    }
  });

  test('stops descendants that detach from the real PTY process group', async () => {
    const cwd = await workspace();
    const childPidPath = join(cwd, 'child.pid');
    const manager = await createTestManager();
    const result = await manager.runBackgroundBash(
      shellInput({
        cwd,
        command: nodeCommand(`
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
        process.stdout.write('READY\\n');
        setInterval(() => {}, 1000);
      `),
        pty: true,
        timeoutMs: 5_000,
      }),
    );

    assert.equal(result.kind, 'shell_run');
    await waitUntil(async () => {
      try {
        await readFile(childPidPath, 'utf8');
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    });
    const childPid = Number.parseInt(await readFile(childPidPath, 'utf8'), 10);
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
    const stopped = await manager.stopBackgroundTask('session-1', result.ref, NO_ABORT);
    assertShellRun(stopped);
    assert.equal(stopped.status, 'cancelled');
    assert.equal(stopped.exitCode, 130);
    await waitUntil(() => !isProcessAlive(childPid));
    assert.equal(manager.liveCount(), 0);
    assert.equal(manager.livePtyCount(), 0);
  });

  // The first-committed lifecycle cause must win the reported status across the
  // Stop/timeout race. Each scenario pins one arrival ordering with the injected
  // `scheduleTimeout` seam (see manualTimeoutScheduler) instead of betting on a
  // wall-clock `timeoutMs`, so the focused race is deterministic and CI-stable.
  // A far-future `timeoutMs` keeps the real timeout out of the way; `timeouts.fire()`
  // decides exactly when the timeout commits. `trap "" TERM` + SIGKILL escalation
  // stays real, but commit ownership is decided before the kill lands, so kill
  // timing cannot flip the cause.
  describe('keeps the first committed lifecycle cause across Stop and timeout races', {
    skip:
      process.platform === 'win32'
        ? 'Windows tree termination has no graceful SIGTERM phase'
        : false,
  }, () => {
    const stall = 'trap "" TERM; printf "READY\\n"; while :; do sleep 1; done';

    test('Stop commits first -> cancelled (Stop owns the termination)', async () => {
      const timeouts = manualTimeoutScheduler();
      const manager = await createTestManager(undefined, {
        killGraceMs: 500,
        scheduleTimeout: timeouts.schedule,
      });
      const run = await manager.runBackgroundBash(
        shellInput({ cwd: await workspace(), command: stall, pty: true, timeoutMs: 60_000 }),
      );
      assert.equal(run.kind, 'shell_run');

      const stopped = await manager.stopBackgroundTask('session-1', run.ref, NO_ABORT);
      // Fire after Stop already committed: the timeout callback sees live.termination
      // set and no-ops; on an empty pending set this is an explicit no-op anyway.
      timeouts.fire();

      assertShellRun(stopped);
      assert.equal(stopped.status, 'cancelled');
      assert.deepEqual(stopped.operation, { kind: 'stop', applied: true });
    });

    test('timeout kills, then Stop arrives -> timed_out (driverExit branch)', async () => {
      const timeouts = manualTimeoutScheduler();
      const manager = await createTestManager(undefined, {
        killGraceMs: 500,
        scheduleTimeout: timeouts.schedule,
      });
      const run = await manager.runBackgroundBash(
        shellInput({ cwd: await workspace(), command: stall, pty: true, timeoutMs: 60_000 }),
      );
      assert.equal(run.kind, 'shell_run');

      // Fire first: timeout commits 'timeout', SIGTERM is trapped, SIGKILL kills.
      timeouts.fire();
      await waitForTerminalShellRun(manager, run.ref);

      const stopped = await manager.stopBackgroundTask('session-1', run.ref, NO_ABORT);
      assertShellRun(stopped);
      assert.equal(stopped.status, 'timed_out');
      assert.deepEqual(stopped.operation, { kind: 'stop', applied: false });
    });

    test('timeout commits but process still alive, then Stop arrives -> timed_out (termination branch)', async () => {
      const timeouts = manualTimeoutScheduler();
      const manager = await createTestManager(undefined, {
        killGraceMs: 500,
        scheduleTimeout: timeouts.schedule,
      });
      const run = await manager.runBackgroundBash(
        shellInput({ cwd: await workspace(), command: stall, pty: true, timeoutMs: 60_000 }),
      );
      assert.equal(run.kind, 'shell_run');

      // Fire commits 'timeout' and sends SIGTERM, which `trap "" TERM` ignores, so
      // the process stays alive while the termination is in flight. writeStdin
      // refuses once termination is committed — that is exactly the in-flight state.
      timeouts.fire();
      await waitUntil(async () => {
        try {
          await manager.writeStdin({
            sessionId: 'session-1',
            ref: run.ref,
            input: 'x',
            abortSignal: NO_ABORT,
          });
          return false;
        } catch (error) {
          if (error instanceof ShellRunPtyControlClosedError) return true;
          throw error;
        }
      });

      // Stop arrives while the process is still alive but termination is committed:
      // stopBackgroundTask joins via the live.termination branch without re-arbitrating.
      const stopped = await manager.stopBackgroundTask('session-1', run.ref, NO_ABORT);
      assertShellRun(stopped);
      assert.equal(stopped.status, 'timed_out');
      assert.deepEqual(stopped.operation, { kind: 'stop', applied: false });
    });
  });

  test('releases failed startup slots and enforces total and PTY capacities independently', async () => {
    const cwd = await workspace();
    // Durable ShellRun creation fails once (the SQLite authority has no
    // filesystem seam to block on), then succeeds; the manager must release
    // the reserved slot on the failed startup.
    const backingStore = createSqliteShellRunStore(cwd);
    let durableFailureArmed = true;
    const store: ShellRunStore = {
      async createShellRun(record) {
        if (durableFailureArmed) {
          durableFailureArmed = false;
          throw new Error('durable ShellRun creation failed');
        }
        return backingStore.createShellRun(record);
      },
      updateShellRun: (...args) => backingStore.updateShellRun(...args),
      readShellRun: (...args) => backingStore.readShellRun(...args),
      listSessionShellRuns: (...args) => backingStore.listSessionShellRuns(...args),
    };
    const manager = createManager(store, undefined, { maxLiveShellRuns: 2, maxLivePtyRuns: 1 });
    try {
      await assert.rejects(() =>
        manager.runBackgroundBash(
          shellInput({
            cwd,
            command: waitForeverCommand('STARTED\n'),
            pty: true,
          }),
        ),
      );
      assert.equal(manager.liveCount(), 0);
      assert.equal(manager.livePtyCount(), 0);
      assert.deepEqual(await store.listSessionShellRuns('session-1'), []);

      const ptyRun = await manager.runBackgroundBash(
        shellInput({
          cwd,
          command: waitForeverCommand('PTY-READY\n'),
          pty: true,
          timeoutMs: 10_000,
        }),
      );
      assert.equal(ptyRun.kind, 'shell_run');
      await assert.rejects(
        () =>
          manager.runBackgroundBash(
            shellInput({
              cwd,
              command: waitForeverCommand(),
              pty: true,
            }),
          ),
        // Names no tool at all. The counters are manager-wide, and the caller
        // that most often hits this cap is a child agent, whose tool list is a
        // strict allowlist that carries Bash but not StopBackgroundTask. The
        // sentence describes the move instead; `non-cu-tool-refusal-text.test`
        // asserts that against the real child tool set.
        /No free interactive \(PTY\) background task slot: the runtime is at its limit of 1 .*Run this command as a non-interactive background task/s,
      );

      const pipeRun = await manager.runBackgroundBash(
        shellInput({
          cwd,
          command: waitForeverCommand('PIPE-READY\n'),
          timeoutMs: 10_000,
        }),
      );
      assert.equal(pipeRun.kind, 'shell_run');
      assert.equal(manager.liveCount(), 2);
      assert.equal(manager.livePtyCount(), 1);
      await assert.rejects(
        () =>
          manager.runBackgroundBash(
            shellInput({
              cwd,
              command: waitForeverCommand(),
            }),
          ),
        /No free background task slot: the runtime is at its limit of 2 .*Wait for a running background task to finish and try again/s,
      );

      await manager.stopBackgroundTask('session-1', ptyRun.ref, NO_ABORT);
      await manager.stopBackgroundTask('session-1', pipeRun.ref, NO_ABORT);
      assert.equal(manager.liveCount(), 0);
      assert.equal(manager.livePtyCount(), 0);
    } finally {
      await manager.terminateAll();
    }
  });

  test('keeps SIGTERM final output and escalates an ignored SIGTERM without leaking slots', {
    skip:
      process.platform === 'win32'
        ? 'Windows tree termination has no graceful SIGTERM phase'
        : false,
  }, async () => {
    const graceful = await createTestManager();
    const gracefulRun = await graceful.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command:
          'trap \'printf "\\nFINAL-SENTINEL\\n"; exit 0\' TERM; printf "ready\\n"; while :; do sleep 1; done',
        pty: true,
        timeoutMs: 5_000,
      }),
    );
    assert.equal(gracefulRun.kind, 'shell_run');
    await waitForPtyText(graceful, gracefulRun.ref, /ready/);
    const stopped = await graceful.stopBackgroundTask('session-1', gracefulRun.ref, NO_ABORT);
    assertShellRun(stopped);
    assert.equal(stopped.output?.mode, 'pty');
    if (stopped.output?.mode !== 'pty') throw new Error('expected pty output');
    assert.match(terminalText(stopped.output), /FINAL-SENTINEL/);
    assert.equal(graceful.liveCount(), 0);

    const forced = await createTestManager();
    const forcedRun = await forced.runBackgroundBash(
      shellInput({
        cwd: await workspace(),
        command: 'trap "" TERM; printf "ready\\n"; while :; do sleep 1; done',
        pty: true,
        timeoutMs: 5_000,
      }),
    );
    assert.equal(forcedRun.kind, 'shell_run');
    await waitForPtyText(forced, forcedRun.ref, /ready/);
    const forcedStop = await forced.stopBackgroundTask('session-1', forcedRun.ref, NO_ABORT);
    assertShellRun(forcedStop);
    assert.equal(forcedStop.status, 'cancelled');
    assert.equal(forcedStop.exitCode, 130);
    assert.equal(forced.liveCount(), 0);
    assert.equal(forced.livePtyCount(), 0);
  });
});

function createManager(
  store: ShellRunStore,
  onShellRunUpdate?: (update: ShellRunUpdate) => void,
  options: {
    maxLiveShellRuns?: number;
    maxLivePtyRuns?: number;
    killGraceMs?: number;
    flushIntervalMs?: number;
    pipeOutputDrainMs?: number;
    onPtyData?: ShellRunProcessManagerInput['onPtyData'];
    scheduleFlush?: ShellRunProcessManagerInput['scheduleFlush'];
    scheduleTimeout?: ShellRunProcessManagerInput['scheduleTimeout'];
  } = {},
): ShellRunProcessManager {
  let id = 0;
  let now = 1_000;
  return new ShellRunProcessManager({
    store,
    newId: () => `shell-run-${++id}`,
    now: () => ++now,
    flushIntervalMs: 10,
    killGraceMs: 100,
    exitAcknowledgementMs: 500,
    ...(onShellRunUpdate ? { onShellRunUpdate } : {}),
    ...(options.onPtyData ? { onPtyData: options.onPtyData } : {}),
    ...options,
  });
}

/** Holds automatic flushes until the test runs them, replacing wall-clock flush timing. */
function manualFlushScheduler(): {
  schedule: (run: () => void, delayMs: number) => () => void;
  pending: () => boolean;
  runPending: () => void;
} {
  const pending = new Set<() => void>();
  return {
    schedule: (run) => {
      pending.add(run);
      return () => pending.delete(run);
    },
    pending: () => pending.size > 0,
    runPending: () => {
      const due = [...pending];
      pending.clear();
      for (const run of due) run();
    },
  };
}

/** Holds run timeouts until the test fires them, replacing wall-clock timeout timing. */
function manualTimeoutScheduler(): {
  schedule: (run: () => void, delayMs: number) => () => void;
  fire: () => void;
} {
  const pending = new Set<() => void>();
  return {
    schedule: (run) => {
      pending.add(run);
      return () => pending.delete(run);
    },
    fire: () => {
      const due = [...pending];
      pending.clear();
      for (const run of due) run();
    },
  };
}

async function createTestManager(
  onShellRunUpdate?: (update: ShellRunUpdate) => void,
  options?: {
    maxLiveShellRuns?: number;
    maxLivePtyRuns?: number;
    killGraceMs?: number;
    flushIntervalMs?: number;
    pipeOutputDrainMs?: number;
    onPtyData?: ShellRunProcessManagerInput['onPtyData'];
    scheduleFlush?: ShellRunProcessManagerInput['scheduleFlush'];
    scheduleTimeout?: ShellRunProcessManagerInput['scheduleTimeout'];
  },
): Promise<ShellRunProcessManager> {
  return createManager(createSqliteShellRunStore(await workspace()), onShellRunUpdate, options);
}

function shellInput(input: {
  cwd: string;
  command: string;
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  fdInputs?: readonly { fd: number; data: Uint8Array }[];
  pty?: boolean;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  emitOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  shell?: ShellPlan;
  sourceToolCallId?: string;
  onCompletion?: (outcome: { successful: boolean }) => void;
}) {
  return {
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    sourceTurnId: 'turn-1',
    sourceToolCallId: input.sourceToolCallId ?? 'tool-1',
    cwd: input.cwd,
    command: input.command,
    ...(input.argv !== undefined ? { argv: input.argv } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.fdInputs !== undefined ? { fdInputs: input.fdInputs } : {}),
    ...(input.pty !== undefined ? { pty: input.pty } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
    ...(input.shell !== undefined ? { shell: input.shell } : {}),
    ...(input.onCompletion !== undefined ? { onCompletion: input.onCompletion } : {}),
    emitOutput: input.emitOutput ?? (() => undefined),
  };
}

function windowsPowerShellPlan(): ShellPlan | undefined {
  if (process.platform !== 'win32') return undefined;
  const executable = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  if (!existsSync(executable)) return undefined;
  return { kind: 'powershell', displayName: 'Windows PowerShell 5.1', exe: executable };
}

function record(input: { shellRunId: string; status: ShellRunRecord['status'] }): ShellRunRecord {
  return {
    shellRunId: input.shellRunId,
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'tool-1',
    cwd: '/workspace',
    command: 'sleep 10',
    status: input.status,
    startedAt: 1,
    updatedAt: 1,
    timeoutMs: 120_000,
    revision: 1,
    output: {
      mode: 'pipes',
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      redacted: false,
    },
  };
}

function assertShellRun(
  content: ToolResultContent,
): asserts content is Extract<ToolResultContent, { kind: 'shell_run' }> {
  assert.equal(content.kind, 'shell_run');
}

function assertShellRunSnapshot(content: ToolResultContent): asserts content is Extract<
  ToolResultContent,
  { kind: 'shell_run' }
> & {
  output: ShellRunRecord['output'];
} {
  assertShellRun(content);
  assert.ok(content.output);
}

type ShellRunResult = Extract<ToolResultContent, { kind: 'shell_run' }>;

async function waitForShellRun(
  manager: ShellRunProcessManager,
  ref: string,
  predicate: (result: ShellRunResult) => boolean,
  timeoutMs = 3_000,
): Promise<ShellRunResult> {
  let result: ShellRunResult | undefined;
  await waitUntil(async () => {
    result = await manager.inspectResource('session-1', ref);
    return predicate(result);
  }, timeoutMs);
  if (!result) throw new Error('ShellRun observation completed without a result');
  return result;
}

function waitForTerminalShellRun(
  manager: ShellRunProcessManager,
  ref: string,
  timeoutMs = 3_000,
): Promise<ShellRunResult> {
  return waitForShellRun(
    manager,
    ref,
    (result) => result.status !== 'starting' && result.status !== 'running',
    timeoutMs,
  );
}

function waitForPtyText(
  manager: ShellRunProcessManager,
  ref: string,
  pattern: RegExp,
  timeoutMs = 3_000,
): Promise<ShellRunResult> {
  return waitForShellRun(
    manager,
    ref,
    (result) => result.output?.mode === 'pty' && pattern.test(terminalText(result.output)),
    timeoutMs,
  );
}

function terminalText(output: Extract<ShellRunRecord['output'], { mode: 'pty' }>): string {
  return [output.scrollback, output.screen, output.lastAlternateScreen].filter(Boolean).join('\n');
}

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'maka-shell-run-'));
  TEMPORARY_WORKSPACES.add(path);
  return path;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for ShellRun state');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function nodeCommand(script: string): string {
  const payload = Buffer.from(script, 'utf8').toString('base64');
  const bootstrap = `eval(Buffer.from('${payload}','base64').toString('utf8'))`;
  const shell = defaultShellPlan();
  if (shell.kind === 'pwsh' || shell.kind === 'powershell') {
    return `& ${powerShellQuote(process.execPath)} -e ${powerShellQuote(bootstrap)}`;
  }
  if (shell.kind === 'cmd') {
    return `${cmdQuote(process.execPath)} -e ${cmdQuote(bootstrap)}`;
  }
  return `${shellQuote(process.execPath)} -e ${shellQuote(bootstrap)}`;
}

function waitForeverCommand(ready = ''): string {
  return nodeCommand(`
    process.stdout.write(${JSON.stringify(ready)});
    setInterval(() => {}, 1000);
  `);
}

function rawLineReaderCommand(input: { prompt?: string; label: string; lines: number }): string {
  return nodeCommand(`
    process.stdin.setRawMode?.(true);
    process.stdin.setEncoding('utf8');
    let current = '';
    let remaining = ${input.lines};
    process.stdout.write(${JSON.stringify(input.prompt ?? '')});
    process.stdin.on('data', (chunk) => {
      for (const character of chunk) {
        if (character !== '\\r' && character !== '\\n') {
          current += character;
          continue;
        }
        if (character === '\\n' && current.length === 0) continue;
        const line = ${JSON.stringify(input.label)} + current + '\\n';
        current = '';
        remaining -= 1;
        if (remaining === 0) process.stdout.write(line, () => process.exit(0));
        else process.stdout.write(line);
      }
    });
  `);
}

function controlCharacterCommand(character: string, marker: string): string {
  return nodeCommand(`
    process.stdin.setRawMode?.(true);
    process.stdin.setEncoding('utf8');
    process.stdout.write('READY\\n');
    process.stdin.on('data', (chunk) => {
      if (chunk.includes(${JSON.stringify(character)})) {
        process.stdout.write(${JSON.stringify(`${marker}\n`)}, () => process.exit(0));
      }
    });
  `);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function cmdQuote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function delayPosixProcessDiscovery(context: TestContext): {
  started: Promise<void>;
  release(): void;
} {
  const originalExecFile = childProcess.execFile;
  const processTableStarted = deferred<void>();
  const releaseProcessTable = deferred<void>();
  childProcess.execFile = ((
    file: string,
    args: readonly string[],
    options: ExecFileOptionsWithStringEncoding,
    callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
  ) => {
    const processTableRead = file === '/bin/ps' || file === '/usr/bin/ps';
    if (processTableRead) processTableStarted.resolve();
    return originalExecFile(file, [...args], options, (error, stdout, stderr) => {
      if (!processTableRead) {
        callback(error, stdout, stderr);
        return;
      }
      void releaseProcessTable.promise.then(() => callback(error, stdout, stderr));
    });
  }) as typeof childProcess.execFile;
  syncBuiltinESMExports();
  context.after(() => {
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
  });

  return {
    started: processTableStarted.promise,
    release: () => releaseProcessTable.resolve(),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
