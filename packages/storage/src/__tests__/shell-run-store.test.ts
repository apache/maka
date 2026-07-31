import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ShellRunPatch, ShellRunRecord } from '@maka/core';
import { createShellRunStore } from '../shell-run-store.js';

describe('ShellRunStore', () => {
  it('creates, updates, reads, and lists ShellRuns under a session', async () => {
    await withStore(async (store, root) => {
      await store.createShellRun(record({ shellRunId: 'shell-2', startedAt: 2, updatedAt: 2 }));
      await store.createShellRun(record({ shellRunId: 'shell-1', startedAt: 1, updatedAt: 1 }));

      const updated = await store.updateShellRun('session-1', 'shell-1', {
        status: 'completed',
        exitCode: 0,
        output: pipeOutput({ stdout: 'done', latestStream: 'stdout' }),
        completedAt: 10,
        updatedAt: 10,
      });

      assert.equal(updated.status, 'completed');
      assert.equal(updated.output.mode === 'pipes' ? updated.output.stdout : '', 'done');
      assert.equal(
        updated.output.mode === 'pipes' ? updated.output.latestStream : undefined,
        'stdout',
      );
      assert.equal(updated.revision, 2);
      assert.deepEqual(
        (await store.listSessionShellRuns('session-1')).map((run) => run.shellRunId),
        ['shell-1', 'shell-2'],
      );
      assert.equal((await store.readShellRun('session-1', 'shell-1')).completedAt, 10);
      assert.equal(
        JSON.parse(
          await readFile(
            join(root, 'sessions', 'session-1', 'shell-runs', 'shell-1', 'shell-run.json'),
            'utf8',
          ),
        ).shellRunId,
        'shell-1',
      );
    });
  });

  it('rejects duplicate create without overwriting the existing record', async () => {
    await withStore(async (store, root) => {
      await store.createShellRun(record({ shellRunId: 'shell-1', command: 'first' }));

      await assert.rejects(
        () => store.createShellRun(record({ shellRunId: 'shell-1', command: 'second' })),
        /ShellRun already exists: shell-1/,
      );

      const raw = await readFile(
        join(root, 'sessions', 'session-1', 'shell-runs', 'shell-1', 'shell-run.json'),
        'utf8',
      );
      assert.equal(JSON.parse(raw).command, 'first');
    });
  });

  it('preserves forward-only starting, running, and terminal lifecycle transitions', async () => {
    await withStore(async (store) => {
      await store.createShellRun(record({ shellRunId: 'shell-1', status: 'starting' }));
      const running = await store.updateShellRun('session-1', 'shell-1', {
        status: 'running',
        updatedAt: 2,
      });
      const completed = await store.updateShellRun('session-1', 'shell-1', {
        status: 'completed',
        exitCode: 0,
        completedAt: 3,
        updatedAt: 3,
      });

      assert.equal(running.revision, 2);
      assert.equal(completed.revision, 3);
      await assert.rejects(
        () =>
          store.updateShellRun('session-1', 'shell-1', {
            status: 'running',
            completedAt: undefined,
            exitCode: undefined,
            updatedAt: 4,
          }),
        /Invalid ShellRun status transition: completed -> running/,
      );
    });
  });

  it('terminalizes failed or lost starts and keeps terminal outcomes immutable', async () => {
    await withStore(async (store) => {
      await store.createShellRun(record({ shellRunId: 'failed-launch', status: 'starting' }));
      const failed = await store.updateShellRun('session-1', 'failed-launch', {
        status: 'failed',
        failureMessage: 'spawn failed',
        completedAt: 2,
        updatedAt: 2,
      });
      assert.equal(failed.status, 'failed');

      await store.createShellRun(record({ shellRunId: 'lost-launch', status: 'starting' }));
      const orphaned = await store.updateShellRun('session-1', 'lost-launch', {
        status: 'orphaned',
        failureMessage: 'host restarted before launch outcome was known',
        completedAt: 2,
        updatedAt: 2,
      });
      assert.equal(orphaned.status, 'orphaned');

      await assert.rejects(
        () =>
          store.updateShellRun('session-1', 'failed-launch', {
            failureMessage: 'different failure',
            updatedAt: 3,
          }),
        /ShellRun terminal outcome is immutable: failed/,
      );
    });
  });

  it('round-trips sandbox execution and one-shot escalation audit facts', async () => {
    await withStore(async (store) => {
      const created = await store.createShellRun({
        ...record({ shellRunId: 'shell-escalated' }),
        sandboxExecution: { type: 'none', enforced: false },
        sandboxEscalation: { commandHash: 'command-hash', unsandboxed: true },
      });

      assert.deepEqual(created.sandboxExecution, { type: 'none', enforced: false });
      assert.deepEqual(created.sandboxEscalation, {
        commandHash: 'command-hash',
        unsandboxed: true,
      });
      assert.deepEqual(
        (await store.readShellRun('session-1', 'shell-escalated')).sandboxEscalation,
        created.sandboxEscalation,
      );
    });
  });

  it('rejects inconsistent sandbox execution audit facts', async () => {
    await withStore(async (store) => {
      await assert.rejects(
        () =>
          store.createShellRun({
            ...record({ shellRunId: 'shell-invalid-enforcement' }),
            sandboxExecution: { type: 'macos-seatbelt', enforced: false },
          }),
        /malformed fields/,
      );
      await assert.rejects(
        () =>
          store.createShellRun({
            ...record({ shellRunId: 'shell-invalid-escalation' }),
            sandboxExecution: { type: 'macos-seatbelt', enforced: true },
            sandboxEscalation: { commandHash: 'command-hash', unsandboxed: true },
          }),
        /malformed fields/,
      );
    });
  });

  it('increments revision only when durable state changes', async () => {
    await withStore(async (store) => {
      await store.createShellRun(record({ shellRunId: 'shell-1' }));

      const unchanged = await store.updateShellRun('session-1', 'shell-1', {
        exitCode: undefined,
        failureMessage: undefined,
      });
      const changed = await store.updateShellRun('session-1', 'shell-1', {
        output: pipeOutput({ stdout: 'next' }),
        updatedAt: 2,
      });

      assert.equal(unchanged.revision, 1);
      assert.equal(changed.revision, 2);
    });
  });

  it('records only the first terminal observation under concurrent updates', async () => {
    await withStore(async (store) => {
      await store.createShellRun(
        record({
          shellRunId: 'shell-1',
          status: 'completed',
          completedAt: 2,
          exitCode: 0,
        }),
      );

      const [first, second] = await Promise.all([
        store.updateShellRun('session-1', 'shell-1', { observedAt: 10 }),
        store.updateShellRun('session-1', 'shell-1', { observedAt: 20 }),
      ]);

      assert.equal(first.observedAt, 10);
      assert.equal(second.observedAt, 10);
      assert.equal(second.revision, 2);
      assert.equal((await store.readShellRun('session-1', 'shell-1')).revision, 2);
    });
  });

  it('keeps launch identity and output mode immutable', async () => {
    await withStore(async (store) => {
      await store.createShellRun(record({ shellRunId: 'shell-1' }));

      await assert.rejects(
        () =>
          store.updateShellRun('session-1', 'shell-1', {
            command: 'replacement',
          } as unknown as ShellRunPatch),
        /ShellRun field is immutable: command/,
      );
      await assert.rejects(
        () =>
          store.updateShellRun('session-1', 'shell-1', {
            output: {
              mode: 'pty',
              screen: '',
              scrollback: '',
              cols: 80,
              rows: 24,
              cursor: { x: 0, y: 0, visible: true },
              alternateScreen: false,
              truncated: false,
              redacted: false,
            },
          }),
        /ShellRun output mode is immutable: pipes/,
      );
      await assert.rejects(
        () =>
          store.createShellRun({
            ...record({ shellRunId: 'shell-with-operation' }),
            operation: { kind: 'stop', applied: true },
          } as unknown as ShellRunRecord),
        /malformed fields/,
      );
    });
  });

  it('rejects malformed records and ignores malformed folders while listing', async () => {
    await withStore(async (store, root) => {
      await store.createShellRun(record({ shellRunId: 'shell-good' }));
      const badPath = join(
        root,
        'sessions',
        'session-1',
        'shell-runs',
        'shell-bad',
        'shell-run.json',
      );
      await mkdir(join(root, 'sessions', 'session-1', 'shell-runs', 'shell-bad'), {
        recursive: true,
      });
      await writeFile(
        badPath,
        JSON.stringify({
          shellRunId: 'shell-bad',
          sessionId: 'session-1',
          status: 'mystery',
        }) + '\n',
        'utf8',
      );

      await assert.rejects(
        () => store.readShellRun('session-1', 'shell-bad'),
        /Invalid ShellRun record for shell-bad: malformed fields/,
      );
      assert.deepEqual(
        (await store.listSessionShellRuns('session-1')).map((run) => run.shellRunId),
        ['shell-good'],
      );
    });
  });

  it('normalizes an exact legacy ShellRun record and writes only the current shape on update', async () => {
    await withStore(async (store, root) => {
      const dir = join(root, 'sessions', 'session-1', 'shell-runs', 'shell-legacy');
      const path = join(dir, 'shell-run.json');
      await mkdir(dir, { recursive: true });
      await writeFile(
        path,
        JSON.stringify({
          shellRunId: 'shell-legacy',
          sessionId: 'session-1',
          sourceRunId: 'run-1',
          sourceTurnId: 'turn-1',
          sourceToolCallId: 'tool-1',
          cwd: '/workspace',
          command: 'printf ready; sleep 30',
          status: 'running',
          startedAt: 1,
          updatedAt: 1,
          timeoutMs: 30_000,
          stdoutTail: 'ready',
          stderrTail: '',
          latestOutputStream: 'stdout',
          stdoutTruncated: false,
          stderrTruncated: false,
          pid: 123,
        }) + '\n',
        'utf8',
      );

      const restored = await store.readShellRun('session-1', 'shell-legacy');
      assert.equal(restored.revision, 1);
      assert.deepEqual(restored.output, {
        mode: 'pipes',
        stdout: 'ready',
        stderr: '',
        latestStream: 'stdout',
        stdoutTruncated: false,
        stderrTruncated: false,
        redacted: false,
      });

      await store.updateShellRun('session-1', 'shell-legacy', {
        updatedAt: 2,
        output: pipeOutput({ stdout: 'ready\nnext', latestStream: 'stdout' }),
      });
      const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      assert.equal(written.revision, 2);
      assert.equal(Object.hasOwn(written, 'stdoutTail'), false);
      assert.equal(Object.hasOwn(written, 'pid'), false);
      assert.deepEqual(written.output, {
        mode: 'pipes',
        stdout: 'ready\nnext',
        stderr: '',
        latestStream: 'stdout',
        stdoutTruncated: false,
        stderrTruncated: false,
        redacted: false,
      });
    });
  });

  it('rejects legacy ShellRun records that violate the preceding state invariants', async () => {
    await withStore(async (store, root) => {
      const cases = [
        {
          shellRunId: 'legacy-completed-with-orphan-reason',
          status: 'completed',
          completedAt: 2,
          exitCode: 0,
          orphanedReason: 'contradictory',
        },
        {
          shellRunId: 'legacy-failed-without-exit',
          status: 'failed',
          completedAt: 2,
          failureMessage: 'old store required a non-zero exit code',
        },
      ] as const;
      for (const invalid of cases) {
        const dir = join(root, 'sessions', 'session-1', 'shell-runs', invalid.shellRunId);
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, 'shell-run.json'),
          JSON.stringify({
            sessionId: 'session-1',
            sourceRunId: 'run-1',
            sourceTurnId: 'turn-1',
            sourceToolCallId: 'tool-1',
            cwd: '/workspace',
            command: 'printf ready',
            ...invalid,
            startedAt: 1,
            updatedAt: 2,
            stdoutTail: 'ready',
            stderrTail: '',
            latestOutputStream: 'stdout',
            stdoutTruncated: false,
            stderrTruncated: false,
          }) + '\n',
          'utf8',
        );
        await assert.rejects(
          () => store.readShellRun('session-1', invalid.shellRunId),
          /Invalid ShellRun record/,
        );
      }
    });
  });

  it('rejects inconsistent ShellRun state fields', async () => {
    await withStore(async (store) => {
      await assert.rejects(
        () => store.createShellRun(record({ shellRunId: 'bad-completed', status: 'completed' })),
        /inconsistent state fields/,
      );

      await store.createShellRun(record({ shellRunId: 'running-1' }));
      await assert.rejects(
        () =>
          store.updateShellRun('session-1', 'running-1', {
            exitCode: 0,
            updatedAt: 2,
          }),
        /inconsistent state fields/,
      );
      await assert.rejects(
        () =>
          store.updateShellRun('session-1', 'running-1', {
            status: 'completed',
            updatedAt: 3,
          }),
        /inconsistent state fields/,
      );
    });
  });

  it('rejects unsafe session and shell run ids', async () => {
    await withStore(async (store) => {
      await assert.rejects(
        () => store.createShellRun(record({ sessionId: '../outside', shellRunId: 'shell-1' })),
        /Invalid session id/,
      );
      await assert.rejects(
        () => store.createShellRun(record({ sessionId: 'session-1', shellRunId: '../outside' })),
        /Invalid shell run id/,
      );
    });
  });
});

async function withStore(
  fn: (store: ReturnType<typeof createShellRunStore>, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-shell-run-store-'));
  try {
    await fn(createShellRunStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function record(input: {
  sessionId?: string;
  shellRunId: string;
  command?: string;
  status?: ShellRunRecord['status'];
  startedAt?: number;
  updatedAt?: number;
  completedAt?: number;
  exitCode?: number;
}): ShellRunRecord {
  return {
    shellRunId: input.shellRunId,
    sessionId: input.sessionId ?? 'session-1',
    sourceRunId: 'run-1',
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'tool-1',
    cwd: '/workspace',
    command: input.command ?? 'printf "ok"',
    status: input.status ?? 'running',
    startedAt: input.startedAt ?? 1,
    updatedAt: input.updatedAt ?? 1,
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    revision: 1,
    output: pipeOutput(),
  };
}

function pipeOutput(
  input: { stdout?: string; stderr?: string; latestStream?: 'stdout' | 'stderr' } = {},
): Extract<ShellRunRecord['output'], { mode: 'pipes' }> {
  return {
    mode: 'pipes',
    stdout: input.stdout ?? '',
    stderr: input.stderr ?? '',
    ...(input.latestStream ? { latestStream: input.latestStream } : {}),
    stdoutTruncated: false,
    stderrTruncated: false,
    redacted: false,
  };
}
