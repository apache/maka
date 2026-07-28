import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { zodSchema } from 'ai';
import { z } from 'zod';
import { SHELL_RUN_ID_MAX_CHARS } from '@maka/core';
import {
  createWorkspaceWritePermissionProfile,
  type PermissionProfile,
} from '@maka/core/permission-profile';
import { expect } from '../test-helpers.js';
import { buildBuiltinTools } from '../builtin-tools.js';
import { assertAdditionalPermissionProposal } from '../additional-permissions.js';
import { SandboxManager } from '../sandbox/sandbox-manager.js';
import { LinuxBubblewrapBackend } from '../sandbox/linux-sandbox.js';
import { MacosSeatbeltBackend } from '../sandbox/macos-seatbelt.js';
import { SandboxCommandError } from '../sandbox/errors.js';
import { sandboxEscalationCommandHash } from '../sandbox-escalation.js';
import type { ShellRunLauncher } from '../shell-tools.js';
import {
  MAX_SHELL_RUN_RESOURCE_REF_CHARS,
  SHELL_RUN_RESOURCE_PREFIX,
  shellRunResourceRef,
  type BackgroundTaskStopper,
  type PtyControlWriter,
  type RuntimeResourceReader,
} from '../shell-run-contract.js';
import {
  LOCAL_WORKSPACE_EXECUTOR_FACTS,
  type WorkspaceExecInput,
  type WorkspaceExecutor,
  type WorkspaceExecutorFacts,
} from '../workspace-executor.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

describe('builtin tool activity kinds', () => {
  test('declares stable semantic categories independently of tool names', () => {
    const kinds = Object.fromEntries(
      buildBuiltinTools().map((tool) => [tool.name, tool.activityKind]),
    );

    expect(kinds).toEqual({
      Bash: 'command',
      Read: 'read',
      Write: 'edit',
      Edit: 'edit',
      FormatJson: 'edit',
      Glob: 'search',
      Grep: 'search',
    });
  });

  test('categorizes background task controls as command activity', () => {
    const shellRuns = {
      runForegroundBash: () => Promise.reject(new Error('not used')),
      runBackgroundBash: () => Promise.reject(new Error('not used')),
    } satisfies ShellRunLauncher;
    const backgroundTasks = {
      stopBackgroundTask: () => Promise.reject(new Error('not used')),
    } satisfies BackgroundTaskStopper;
    const ptyControls = {
      writeStdin: () => Promise.reject(new Error('not used')),
    } satisfies PtyControlWriter;
    const kinds = Object.fromEntries(
      buildBuiltinTools({
        shellRuns,
        backgroundTasks,
        ptyControls,
      }).map((tool) => [tool.name, tool.activityKind]),
    );

    expect(kinds.Bash).toBe('command');
    expect(kinds.StopBackgroundTask).toBe('command');
    expect(kinds.WriteStdin).toBe('command');
  });

  test('can omit Edit from a host surface that has no filesystem worker', () => {
    const tools = buildBuiltinTools({ includeEdit: false } as Parameters<
      typeof buildBuiltinTools
    >[0]);

    assert.equal(
      tools.some((tool) => tool.name === 'Edit'),
      false,
    );
    assert.ok(tools.some((tool) => tool.name === 'Write'));
  });
});

describe('builtin Read capabilities', () => {
  test('advertises image support only when image snapshots are available', () => {
    const textOnly = buildBuiltinTools().find((tool) => tool.name === 'Read')!;
    const withImages = buildBuiltinTools({
      snapshotImage: async (input) => ({
        kind: 'session_file',
        sessionId: input.sessionId,
        relativePath: 'image-1',
      }),
    }).find((tool) => tool.name === 'Read')!;

    assert.doesNotMatch(textOnly.description, /image/);
    assert.match(withImages.description, /image/);
  });
});

describe('builtin ArchiveRead capabilities', () => {
  test('is present only with a host reader and preserves the invoking session', async () => {
    const body = JSON.stringify({ kind: 'agent_swarm', items: [] });
    const bodySha256 = createHash('sha256').update(body).digest('hex');
    const artifactId = `tool-result-archive-${'a'.repeat(32)}`;
    const seen: unknown[] = [];
    const withoutReader = buildBuiltinTools().find((tool) => tool.name === 'ArchiveRead');
    const archiveRead = buildBuiltinTools({
      archiveResources: {
        readArchivedToolResultResource(input) {
          seen.push(input);
          return { ok: true, serializedResult: body };
        },
      },
    }).find((tool) => tool.name === 'ArchiveRead');
    if (!archiveRead) throw new Error('ArchiveRead tool missing');

    assert.equal(withoutReader, undefined);
    assert.equal(archiveRead.permissionRequired, false);
    assert.equal(archiveRead.activityKind, 'read');
    const result = await archiveRead.impl(
      {
        ref: `maka://archive/${artifactId}?sha256=${bodySha256}&bytes=${Buffer.byteLength(body)}`,
        operation: 'inspect',
      },
      {
        sessionId: 'session-1',
        runId: 'run-1',
        turnId: 'turn-1',
        cwd: '/workspace',
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      },
    );

    assert.equal((result as { operation: string }).operation, 'inspect');
    assert.equal((seen[0] as { sessionId: string }).sessionId, 'session-1');
  });
});

describe('builtin tool executor facts', () => {
  test('attaches executor facts to every built-in tool', () => {
    const facts: WorkspaceExecutorFacts = {
      isolation: 'worktree',
      writesAffectHost: false,
      writeBack: 'diff_review',
      network: 'sandbox',
      secrets: 'none',
    };

    const tools = buildBuiltinTools({ executor: fakeExecutor({ facts }) });

    expect(tools.length > 0).toBe(true);
    expect(tools.every((tool) => tool.executionFacts === facts)).toBe(true);
  });
});

describe('builtin Bash description declares the executing shell', () => {
  test('executor Bash keeps its durable command out of provider-facing results', async () => {
    const bash = buildBuiltinTools({
      executor: fakeExecutor({
        exec: async () => ({
          exitCode: 0,
          stdout: 'done',
          stderr: '',
          timedOut: false,
          aborted: false,
        }),
      }),
    }).find((tool) => tool.name === 'Bash')!;
    const result = await runTool(bash, { command: 'printf executor-marker' }, '/workspace');
    const modelOutput = await bash.toModelOutput?.({
      toolCallId: 'tool-1',
      input: { command: 'printf executor-marker' },
      output: result,
    });

    assert.equal((result as { cmd?: unknown }).cmd, 'printf executor-marker');
    assert.equal(
      Object.hasOwn(
        modelOutput && 'value' in modelOutput && typeof modelOutput.value === 'object'
          ? (modelOutput.value ?? {})
          : {},
        'cmd',
      ),
      false,
    );
  });

  test('executor Bash executes with the same shell it declares', async () => {
    // /bin/echo stands in for pwsh.exe: if the shell reaches the local
    // executor's spawn, stdout echoes the PowerShell flags back instead of a
    // bare 'wired-marker' from the default POSIX shell.
    const tools = buildBuiltinTools({
      shell: { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: '/bin/echo' },
    });
    const bash = tools.find((tool) => tool.name === 'Bash')!;
    const result = (await bash.impl(
      { command: 'echo wired-marker' },
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        cwd: process.cwd(),
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      },
    )) as { output: { mode: string; stdout: string } };
    expect(
      result.output.stdout.startsWith(
        '-NoLogo -NoProfile -NonInteractive -Command echo wired-marker\n',
      ),
    ).toBe(true);
  });

  test('executor Bash tells the model commands run under PowerShell 7', () => {
    const tools = buildBuiltinTools({
      executor: fakeExecutor({ facts: LOCAL_WORKSPACE_EXECUTOR_FACTS }),
      shell: { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: 'C:\\pf\\pwsh.exe' },
    });
    const bash = tools.find((tool) => tool.name === 'Bash');
    expect(bash !== undefined).toBe(true);
    expect(/PowerShell 7 \(pwsh\)/.test(bash!.description)).toBe(true);
    expect(/git ls-files/.test(bash!.description)).toBe(true);
  });
});

describe('builtin Bash streaming output', () => {
  test('requires a sandbox manager and supports Linux Bash one-shot permissions', () => {
    assert.throws(
      () => buildBuiltinTools({ enableBashAdditionalPermissions: true }),
      /require a sandbox manager/,
    );

    const linuxBash = buildBuiltinTools({
      sandboxManager: availableLinuxManager(),
      sandboxPlatform: 'linux',
      enableBashAdditionalPermissions: true,
    }).find((tool) => tool.name === 'Bash');
    assert.ok(linuxBash?.planAdditionalPermissions);
    assert.ok(linuxBash.planSandboxEscalation);
    assert.equal(
      (linuxBash.parameters as z.ZodTypeAny).safeParse({
        command: 'echo unsafe',
        sandbox_permissions: {
          mode: 'require_escalated',
          justification: 'The sandbox cannot perform this action.',
        },
      }).success,
      true,
    );

    assert.throws(
      () =>
        buildBuiltinTools({
          sandboxManager: availableLinuxManager(),
          sandboxPlatform: 'win32',
          enableBashAdditionalPermissions: true,
        }),
      /supported only on macOS and Linux/,
    );
  });

  test('Bash schema exposes only explicit background execution', () => {
    const bash = buildBuiltinTools({
      shellRuns: {
        runForegroundBash: () => Promise.reject(new Error('not used')),
        runBackgroundBash: () => Promise.reject(new Error('not used')),
      },
    }).find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');
    const parameters = bash.parameters as { safeParse(input: unknown): { success: boolean } };

    expect(parameters.safeParse({ command: 'sleep 60', run_in_background: true }).success).toBe(
      true,
    );
    expect(
      parameters.safeParse({ command: 'sleep 60', run_in_background: true, pty: true }).success,
    ).toBe(true);
    expect(parameters.safeParse({ command: 'sleep 60', pty: true }).success).toBe(false);
    expect(parameters.safeParse({ command: 'sleep 60', yield_time_ms: 250 }).success).toBe(false);
    expect(parameters.safeParse({ command: 'sleep 60', timeout_ms: 600_001 }).success).toBe(false);
    expect(
      parameters.safeParse({ command: 'sleep 60', timeout_ms: 600_001, run_in_background: true })
        .success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        command: 'sleep 60',
        sandbox_permissions: { mode: 'use_default' },
      }).success,
    ).toBe(false);
  });

  test('background-capable Bash stays foreground unless explicitly requested', async () => {
    const calls: string[] = [];
    const shellRuns = {
      async runForegroundBash() {
        calls.push('foreground');
        return {
          kind: 'terminal',
          cwd: '/workspace',
          cmd: 'sleep 60',
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
        } as const;
      },
      async runBackgroundBash() {
        calls.push('background');
        throw new Error('unexpected background execution');
      },
      async readResource() {
        throw new Error('not used');
      },
      async stopResource() {
        throw new Error('not used');
      },
    };
    const bash = buildBuiltinTools({ shellRuns }).find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    const result = await bash.impl(
      { command: 'sleep 60' },
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        cwd: '/workspace',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      },
    );

    expect((result as { kind: string }).kind).toBe('terminal');
    expect(calls).toEqual(['foreground']);
  });

  test('explicit background Bash returns runtime refs and forwards its optional timeout', async () => {
    const calls: unknown[] = [];
    const shellRuns = {
      async runForegroundBash() {
        throw new Error('not used');
      },
      async runBackgroundBash(input: unknown) {
        calls.push(input);
        return {
          kind: 'shell_run',
          ref: 'maka://runtime/background-tasks/shell-run-1',
          mode: 'pty',
          status: 'running',
          cwd: '/workspace',
          cmd: 'sleep 60',
          startedAt: 1,
          updatedAt: 1,
          revision: 1,
        };
      },
    } satisfies ShellRunLauncher;
    const tools = buildBuiltinTools({ shellRuns });
    const names = tools.map((tool) => tool.name);

    expect(names.filter((name) => name === 'Bash')).toHaveLength(1);
    expect(names.includes('StopBackgroundTask')).toBe(false);
    const bash = tools.find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');
    const result = await bash.impl(
      { command: 'sleep 60', timeout_ms: 2_000, run_in_background: true, pty: true },
      {
        sessionId: 'session-1',
        runId: 'run-1',
        turnId: 'turn-1',
        cwd: '/workspace',
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      },
    );

    expect((result as { kind: string }).kind).toBe('shell_run');
    expect((result as { ref?: string }).ref).toBe('maka://runtime/background-tasks/shell-run-1');
    expect((calls[0] as { timeoutMs?: number }).timeoutMs).toBe(2_000);
    expect((calls[0] as { sourceRunId?: string }).sourceRunId).toBe('run-1');
    expect((calls[0] as { pty?: boolean }).pty).toBe(true);
  });

  test('wraps managed pipe Bash with bubblewrap argv and seccomp fd input', async () => {
    const calls: any[] = [];
    const shellRuns = {
      async runForegroundBash(input: any) {
        calls.push(input);
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
        } as const;
      },
      async runBackgroundBash() {
        throw new Error('not used');
      },
    };
    const bash = buildBuiltinTools({
      shellRuns,
      permissionProfile: createWorkspaceWritePermissionProfile(),
      sandboxManager: availableLinuxManager(),
      sandboxPlatform: 'linux',
    }).find((candidate) => candidate.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    await bash.impl(
      { command: 'node --version' },
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        cwd: '/workspace',
        permissionMode: 'execute',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      },
    );

    expect(calls[0]?.argv?.[0]).toBe('/usr/bin/bwrap');
    expect(calls[0]?.argv?.slice(-3)).toEqual(['/bin/sh', '-c', 'node --version']);
    expect(calls[0]?.fdInputs?.[0]?.fd).toBe(3);
    expect(typeof bash.sandbox).toBe('function');
    if (typeof bash.sandbox !== 'function') throw new Error('dynamic sandbox metadata missing');
    expect(
      bash.sandbox({
        permissionMode: 'execute',
        cwd: '/workspace',
        args: { command: 'node --version' },
      }),
    ).toEqual({ platformSandboxAvailable: true });
  });

  test('pins a missing exact-write target and removes an untouched successful placeholder', async () => {
    const fixture = await linuxMissingExactWriteFixture();
    let launchInput: any;
    const bash = fixture.buildBash({
      async runForegroundBash(input: any) {
        launchInput = input;
        assert.equal(await pathExists(fixture.target), true);
        input.onCompletion?.({ successful: true });
        return terminalResult(input, 'completed', 0);
      },
      async runBackgroundBash() {
        throw new Error('not used');
      },
    });

    try {
      await bash.impl(fixture.args, fixture.context);

      const pinned = launchInput.fdInputs.find(
        (input: { sourceFd?: number }) => input.sourceFd !== undefined,
      );
      assert.ok(pinned);
      assert.ok(Number.isInteger(pinned.sourceFd));
      assert.equal(typeof pinned.releaseSource, 'function');
      assert.ok(
        hasArgTriple(launchInput.argv, '--bind', `/proc/self/fd/${pinned.fd}`, fixture.target),
      );
      assert.equal(await pathExists(fixture.target), false);
    } finally {
      await fixture.cleanup();
    }
  });

  test('removes missing exact-write placeholders after launch rejection and failed completion', async () => {
    for (const outcome of ['launch_rejected', 'failed', 'cancelled', 'timed_out'] as const) {
      const fixture = await linuxMissingExactWriteFixture();
      const bash = fixture.buildBash({
        async runForegroundBash(input: any) {
          if (outcome === 'launch_rejected') throw new Error('spawn failed');
          input.onCompletion?.({ successful: false });
          return terminalResult(input, outcome, outcome === 'failed' ? 7 : 130);
        },
        async runBackgroundBash() {
          throw new Error('not used');
        },
      });

      try {
        if (outcome === 'launch_rejected') {
          await assert.rejects(
            () => Promise.resolve(bash.impl(fixture.args, fixture.context)),
            /spawn failed/,
          );
        } else {
          await bash.impl(fixture.args, fixture.context);
        }
        assert.equal(await pathExists(fixture.target), false, outcome);
      } finally {
        await fixture.cleanup();
      }
    }
  });

  test('preserves an intentionally written empty exact-write target after success', async () => {
    const fixture = await linuxMissingExactWriteFixture();
    const bash = fixture.buildBash({
      async runForegroundBash(input: any) {
        assert.ok(input.onCompletion);
        await writeFile(fixture.target, '');
        input.onCompletion({ successful: true });
        return terminalResult(input, 'completed', 0);
      },
      async runBackgroundBash() {
        throw new Error('not used');
      },
    });

    try {
      await bash.impl(fixture.args, fixture.context);
      assert.equal(await pathExists(fixture.target), true);
      assert.equal(await readFile(fixture.target, 'utf8'), '');
    } finally {
      await fixture.cleanup();
    }
  });

  test('preserves an intentionally written empty exact-write target after failure', async () => {
    for (const outcome of ['failed', 'cancelled', 'timed_out'] as const) {
      const fixture = await linuxMissingExactWriteFixture();
      const bash = fixture.buildBash({
        async runForegroundBash(input: any) {
          await writeFile(fixture.target, '');
          input.onCompletion?.({ successful: false });
          return terminalResult(input, outcome, outcome === 'failed' ? 7 : 130);
        },
        async runBackgroundBash() {
          throw new Error('not used');
        },
      });

      try {
        await bash.impl(fixture.args, fixture.context);
        assert.equal(await pathExists(fixture.target), true, outcome);
      } finally {
        await fixture.cleanup();
      }
    }
  });

  test('completion cannot close a descriptor number reused after spawn handoff', async () => {
    const fixture = await linuxMissingExactWriteFixture();
    let reusedFd: number | undefined;
    const openedFds: number[] = [];
    const bash = fixture.buildBash({
      async runForegroundBash(input: any) {
        const pinned = input.fdInputs.find(
          (candidate: { sourceFd?: number }) => candidate.sourceFd !== undefined,
        );
        assert.ok(pinned);
        assert.equal(typeof pinned.releaseSource, 'function');
        pinned.releaseSource();
        for (let attempt = 0; attempt <= pinned.sourceFd + 16; attempt += 1) {
          const fd = openSync(join(dirname(fixture.target), `reused-${attempt}.txt`), 'w');
          openedFds.push(fd);
          if (fd === pinned.sourceFd) {
            reusedFd = fd;
            break;
          }
        }
        assert.equal(reusedFd, pinned.sourceFd, 'test could not force fd-number reuse');
        input.onCompletion?.({ successful: false });
        return terminalResult(input, 'failed', 7);
      },
      async runBackgroundBash() {
        throw new Error('not used');
      },
    });

    try {
      await bash.impl(fixture.args, fixture.context);
      assert.ok(reusedFd !== undefined);
      assert.doesNotThrow(() => fstatSync(reusedFd!));
    } finally {
      for (const fd of openedFds.reverse()) closeSync(fd);
      await fixture.cleanup();
    }
  });

  test('keeps a background placeholder owned until the shell run completes', async () => {
    const fixture = await linuxMissingExactWriteFixture();
    let onCompletion: ((outcome: { successful: boolean }) => void) | undefined;
    const bash = fixture.buildBash({
      async runForegroundBash() {
        throw new Error('not used');
      },
      async runBackgroundBash(input: any) {
        onCompletion = input.onCompletion;
        return {
          kind: 'shell_run',
          ref: 'maka://runtime/background-tasks/shell-run-1',
          mode: 'pipes',
          status: 'running',
          cwd: input.cwd,
          cmd: input.command,
          startedAt: 1,
          updatedAt: 1,
          revision: 1,
        } as const;
      },
    });

    try {
      await bash.impl({ ...fixture.args, run_in_background: true }, fixture.context);
      assert.equal(await pathExists(fixture.target), true);
      assert.ok(onCompletion);
      onCompletion({ successful: true });
      assert.equal(await pathExists(fixture.target), false);
    } finally {
      await fixture.cleanup();
    }
  });

  test('fails closed for sandbox-required PTY Bash unless exact host execution was approved', async () => {
    const calls: any[] = [];
    const shellRuns = {
      async runForegroundBash() {
        throw new Error('not used');
      },
      async runBackgroundBash(input: any) {
        calls.push(input);
        return {
          kind: 'shell_run',
          ref: 'maka://runtime/background-tasks/shell-run-1',
          mode: 'pty',
          status: 'running',
          cwd: input.cwd,
          cmd: input.command,
          startedAt: 1,
          updatedAt: 1,
          revision: 1,
        } as const;
      },
    };
    const bash = buildBuiltinTools({
      shellRuns,
      permissionProfile: createWorkspaceWritePermissionProfile(),
      sandboxManager: availableLinuxManager(),
      sandboxPlatform: 'linux',
    }).find((candidate) => candidate.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    const ptyArgs = { command: 'bash', run_in_background: true, pty: true };
    await assert.rejects(async () => {
      await bash.impl(ptyArgs, {
        sessionId: 'session-1',
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        cwd: '/workspace',
        permissionMode: 'execute',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      });
    }, /PTY Bash is unavailable/);
    expect(calls.length).toBe(0);

    await bash.impl(ptyArgs, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'tool-2',
      cwd: '/workspace',
      permissionMode: 'execute',
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
      permissionContext: {
        sandboxEscalationGrant: {
          grantId: 'grant-pty',
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolUseId: 'tool-2',
          toolName: 'Bash',
          intentHash: 'intent',
          commandHash: sandboxEscalationCommandHash('bash', '/workspace'),
          command: 'bash',
          cwd: '/workspace',
          risk: {
            unsandboxedExecution: true,
            unrestrictedFileSystem: true,
            unrestrictedNetwork: true,
            protectedMetadataExposed: true,
          },
          issuedAt: 1,
          expiresAt: 2,
        },
      },
    });

    expect(calls[0]?.argv).toBe(undefined);
    expect(calls[0]?.fdInputs).toBe(undefined);
    expect(Boolean(calls[0]?.shell)).toBe(true);
    expect(calls[0]?.sandboxType).toBe('none');
    expect(typeof bash.sandbox).toBe('function');
    if (typeof bash.sandbox !== 'function') throw new Error('dynamic sandbox metadata missing');
    expect(
      bash.sandbox({
        permissionMode: 'execute',
        cwd: '/workspace',
        args: { command: 'bash', run_in_background: true, pty: true },
      }),
    ).toEqual({ platformSandboxAvailable: false });
  });

  test('fails closed when a required command sandbox is unavailable', async () => {
    const calls: any[] = [];
    const shellRuns = {
      async runForegroundBash(input: any) {
        calls.push(input);
        return {
          kind: 'terminal',
          cwd: input.cwd,
          cmd: input.command,
          status: 'completed',
          exitCode: 0,
          output: {
            mode: 'pipes',
            stdout: 'host',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            redacted: false,
          },
        } as const;
      },
      async runBackgroundBash() {
        throw new Error('not used');
      },
    };
    const bash = buildBuiltinTools({
      shellRuns,
      permissionProfile: createWorkspaceWritePermissionProfile(),
      sandboxManager: unavailableLinuxManager(),
      sandboxPlatform: 'linux',
    }).find((candidate) => candidate.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    await assert.rejects(async () => {
      await bash.impl(
        { command: 'echo host' },
        {
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolCallId: 'tool-1',
          cwd: '/workspace',
          permissionMode: 'execute',
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
        },
      );
    }, /sandbox is required but unavailable/);

    expect(calls.length).toBe(0);
    expect(typeof bash.sandbox).toBe('function');
    if (typeof bash.sandbox !== 'function') throw new Error('dynamic sandbox metadata missing');
    expect(
      bash.sandbox({
        permissionMode: 'execute',
        cwd: '/workspace',
        args: { command: 'echo host' },
      }),
    ).toEqual({ platformSandboxAvailable: false });
  });

  test('plans and applies one-call Bash permissions to the macOS sandbox argv', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-bash-additional-'));
    try {
      const workspace = join(root, 'workspace');
      const outside = join(root, 'outside');
      await Promise.all([mkdir(workspace), mkdir(outside)]);
      const canonicalWorkspace = await realpath(workspace);
      const target = join(await realpath(outside), 'allowed.txt');
      const profile: PermissionProfile = {
        type: 'managed',
        name: 'custom',
        fileSystem: {
          kind: 'restricted',
          entries: [{ kind: 'path', access: 'write', path: canonicalWorkspace }],
        },
        network: { kind: 'restricted' },
      };
      let execInput: WorkspaceExecInput | undefined;
      const executor = fakeExecutor({
        exec: async (input) => {
          execInput = input;
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
        },
      });
      const sandboxManager = new SandboxManager([new MacosSeatbeltBackend()]);
      const disabledBash = buildBuiltinTools({
        executor,
        permissionProfile: profile,
        sandboxManager,
        sandboxPlatform: 'darwin',
      }).find((candidate) => candidate.name === 'Bash');
      assert.equal(disabledBash?.planAdditionalPermissions, undefined);
      assert.equal(
        (disabledBash!.parameters as z.ZodTypeAny).safeParse({
          command: 'echo unchanged',
          sandbox_permissions: { mode: 'use_default' },
        }).success,
        false,
      );

      const bash = buildBuiltinTools({
        executor,
        permissionProfile: profile,
        sandboxManager,
        enableBashAdditionalPermissions: true,
        sandboxPlatform: 'darwin',
      }).find((candidate) => candidate.name === 'Bash');
      if (!bash?.planAdditionalPermissions)
        throw new Error('Bash additional permission planner missing');
      if (!bash.planSandboxEscalation) throw new Error('Bash sandbox escalation planner missing');

      const args = {
        command: `printf ok > ${JSON.stringify(target)}`,
        sandbox_permissions: {
          mode: 'with_additional_permissions' as const,
          file_system: {
            entries: [{ path: target, access: 'write' as const, scope: 'exact' as const }],
          },
          network: true as const,
          justification: 'Write the selected output and notify a service.',
        },
      };
      const parameters = bash.parameters as z.ZodTypeAny;
      expect(parameters.safeParse(args).success).toBe(true);
      expect(
        parameters.safeParse({
          command: 'echo unsafe',
          sandbox_permissions: {
            mode: 'require_escalated',
            justification: 'The sandbox cannot perform this action.',
          },
        }).success,
      ).toBe(true);

      const plannerContext = {
        sessionId: 'session-1',
        turnId: 'turn-1',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        category: 'shell_unsafe' as const,
        cwd: canonicalWorkspace,
        mode: 'execute' as const,
        args,
      };
      const plan = await bash.planAdditionalPermissions(args, plannerContext);
      assert.equal(plan.kind, 'request');
      if (plan.kind !== 'request') throw new Error('Additional permission request missing');
      assert.doesNotThrow(() =>
        assertAdditionalPermissionProposal({
          proposal: plan.proposal,
          toolName: 'Bash',
          args,
        }),
      );

      await bash.impl(args, {
        sessionId: 'session-1',
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        cwd: canonicalWorkspace,
        permissionMode: 'execute',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
        permissionContext: {
          additionalGrant: {
            grantId: 'grant-1',
            sessionId: 'session-1',
            turnId: 'turn-1',
            toolUseId: 'tool-1',
            toolName: 'Bash',
            intentHash: plan.proposal.intentHash,
            permissionsHash: plan.proposal.permissionsHash,
            profile: plan.proposal.profile,
            normalizedPaths: plan.proposal.normalizedPaths,
            risk: plan.proposal.risk,
            issuedAt: 1,
            expiresAt: 2,
          },
        },
      });

      const argv = execInput?.argv;
      assert.ok(argv);
      assert.equal(argv[0], '/usr/bin/sandbox-exec');
      assert.deepEqual(argv.slice(-3), ['/bin/sh', '-c', args.command]);
      const policy = argv.find((value) => value.includes('(version 1)')) ?? '';
      assert.match(policy, /\(literal \(param "WRITABLE_ROOT_1"\)\)/);
      assert.match(policy, /\(allow network\*\)/);
      assert.equal(profile.network.kind, 'restricted');

      const ptyPlan = await bash.planAdditionalPermissions(
        { ...args, run_in_background: true, pty: true },
        { ...plannerContext, args: { ...args, run_in_background: true, pty: true } },
      );
      assert.equal(ptyPlan.kind, 'block');
      if (ptyPlan.kind === 'block') assert.match(ptyPlan.message, /PTY/);

      const escalatedArgs = {
        command: `printf escalated > ${JSON.stringify(target)}`,
        sandbox_permissions: {
          mode: 'require_escalated' as const,
          justification: 'The exact command requires host execution.',
        },
      };
      const escalationPlan = await bash.planSandboxEscalation(escalatedArgs, {
        ...plannerContext,
        args: escalatedArgs,
      });
      assert.equal(escalationPlan.kind, 'request');
      if (escalationPlan.kind !== 'request') throw new Error('Sandbox escalation request missing');
      await bash.impl(escalatedArgs, {
        sessionId: 'session-1',
        turnId: 'turn-1',
        toolCallId: 'tool-2',
        cwd: canonicalWorkspace,
        permissionMode: 'execute',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
        permissionContext: {
          sandboxEscalationGrant: {
            grantId: 'grant-2',
            sessionId: 'session-1',
            turnId: 'turn-1',
            toolUseId: 'tool-2',
            toolName: 'Bash',
            intentHash: escalationPlan.proposal.intentHash,
            commandHash: escalationPlan.proposal.commandHash,
            command: escalationPlan.proposal.command,
            cwd: escalationPlan.proposal.cwd,
            risk: escalationPlan.proposal.risk,
            issuedAt: 1,
            expiresAt: 2,
          },
        },
      });
      assert.deepEqual(execInput?.argv, ['/bin/sh', '-c', escalatedArgs.command]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('canonicalizes macOS Bash cwd and exposes the runtime executable roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-bash-runtime-roots-'));
    try {
      const workspace = join(root, 'workspace');
      const workspaceAlias = join(root, 'workspace-alias');
      await mkdir(workspace);
      await symlink(workspace, workspaceAlias, 'dir');
      const canonicalWorkspace = await realpath(workspace);
      let input: Parameters<ShellRunLauncher['runForegroundBash']>[0] | undefined;
      const shellRuns: ShellRunLauncher = {
        async runForegroundBash(value) {
          input = value;
          return {
            kind: 'terminal',
            cwd: value.cwd,
            cmd: value.command,
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
        async runBackgroundBash() {
          throw new Error('not used');
        },
      };
      const bash = buildBuiltinTools({
        shellRuns,
        permissionProfile: createWorkspaceWritePermissionProfile(),
        sandboxManager: new SandboxManager([new MacosSeatbeltBackend()]),
        sandboxPlatform: 'darwin',
      }).find((candidate) => candidate.name === 'Bash');
      if (!bash) throw new Error('Bash tool missing');

      await bash.impl(
        { command: 'node --version' },
        {
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolCallId: 'tool-1',
          cwd: workspaceAlias,
          permissionMode: 'execute',
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
        },
      );

      assert.equal(input?.cwd, canonicalWorkspace);
      const argv = input?.argv;
      assert.ok(argv);
      const executableDirectory = dirname(process.execPath);
      const executableRoot =
        basename(executableDirectory) === 'bin'
          ? dirname(executableDirectory)
          : executableDirectory;
      assert.ok(argv.includes(`-DEXECUTABLE_ROOT_0=${executableRoot}`));
      if (process.execPath.startsWith('/opt/homebrew/')) {
        assert.ok(argv.includes('-DEXECUTABLE_ROOT_1=/opt/homebrew'));
      }
      if (process.execPath.startsWith('/usr/local/')) {
        assert.ok(argv.includes('-DEXECUTABLE_ROOT_1=/usr/local'));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('Read treats runtime background task refs as whole resources', async () => {
    const calls: unknown[] = [];
    const runtimeResources = {
      async readRuntimeResource(sessionId: string, ref: string, abortSignal: AbortSignal) {
        calls.push({ sessionId, ref });
        return {
          kind: 'shell_run',
          ref,
          mode: 'pipes',
          status: 'running',
          cwd: '/workspace',
          cmd: 'sleep 60',
          startedAt: 1,
          updatedAt: 2,
          revision: 2,
          output: {
            mode: 'pipes',
            stdout: 'background task detail',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            redacted: false,
          },
        };
      },
    } satisfies RuntimeResourceReader;
    const read = buildBuiltinTools({ runtimeResources }).find((tool) => tool.name === 'Read');
    if (!read) throw new Error('Read tool missing');
    const parameters = read.parameters as {
      jsonSchema: PromiseLike<Record<string, unknown>> | Record<string, unknown>;
      validate(value: unknown): PromiseLike<{ success: boolean }> | { success: boolean };
    };
    const providerSchema = await parameters.jsonSchema;
    // Anthropic-compatible: a plain top-level object with properties, and no
    // top-level union combinator (#1228).
    expect(providerSchema.type).toBe('object');
    expect(providerSchema.anyOf).toBeUndefined();
    expect(providerSchema.oneOf).toBeUndefined();
    expect(providerSchema.allOf).toBeUndefined();
    expect(Object.keys(providerSchema.properties as Record<string, unknown>).sort()).toEqual([
      'limit',
      'offset',
      'path',
      'ref',
    ]);
    // The strict file-vs-ref union remains the authoritative runtime validator.
    expect((await parameters.validate({ path: 'README.md', offset: 2, limit: 10 })).success).toBe(
      true,
    );
    expect(
      (await parameters.validate({ ref: 'maka://runtime/background-tasks/shell-run-1' })).success,
    ).toBe(true);
    expect((await parameters.validate({})).success).toBe(false);
    expect(
      (
        await parameters.validate({
          ref: 'maka://runtime/background-tasks/shell-run-1',
          offset: 2,
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await parameters.validate({
          path: 'README.md',
          ref: 'maka://runtime/background-tasks/shell-run-1',
        })
      ).success,
    ).toBe(false);
    const context = {
      sessionId: 'session-1',
      runId: 'run-1',
      turnId: 'turn-1',
      cwd: '/workspace',
      toolCallId: 'tool-1',
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
    };
    await assert.rejects(
      async () => read.impl({ path: 'maka://runtime/background-tasks/shell-run-1' }, context),
      /must be read with the ref parameter/,
    );
    const result = await read.impl({ ref: 'maka://runtime/background-tasks/shell-run-1' }, context);

    expect(result).toEqual({
      kind: 'shell_run',
      ref: 'maka://runtime/background-tasks/shell-run-1',
      mode: 'pipes',
      status: 'running',
      cwd: '/workspace',
      cmd: 'sleep 60',
      startedAt: 1,
      updatedAt: 2,
      revision: 2,
      output: {
        mode: 'pipes',
        stdout: 'background task detail',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        redacted: false,
      },
    });
    expect(calls).toEqual([
      {
        sessionId: 'session-1',
        ref: 'maka://runtime/background-tasks/shell-run-1',
      },
    ]);
  });

  test('StopBackgroundTask stops a runtime ref in the current session', async () => {
    const calls: unknown[] = [];
    const backgroundTasks = {
      async stopBackgroundTask(sessionId: string, ref: string, abortSignal: AbortSignal) {
        calls.push({ sessionId, ref });
        return {
          kind: 'shell_run',
          ref,
          mode: 'pipes',
          status: 'cancelled',
          cwd: '/workspace',
          cmd: 'sleep 60',
          startedAt: 1,
          updatedAt: 2,
          completedAt: 2,
          exitCode: 130,
          failureMessage: 'Command cancelled',
          revision: 3,
          output: {
            mode: 'pipes',
            stdout: '',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            redacted: false,
          },
          operation: { kind: 'stop', applied: true },
        };
      },
    } satisfies BackgroundTaskStopper;
    const stop = buildBuiltinTools({ backgroundTasks }).find(
      (tool) => tool.name === 'StopBackgroundTask',
    );
    if (!stop) throw new Error('StopBackgroundTask tool missing');

    const result = await stop.impl(
      { ref: 'maka://runtime/background-tasks/shell-run-1' },
      {
        sessionId: 'session-1',
        runId: 'run-1',
        turnId: 'turn-1',
        cwd: '/workspace',
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      },
    );

    expect(result).toMatchObject({
      kind: 'shell_run',
      status: 'cancelled',
      operation: { kind: 'stop', applied: true },
    });
    expect(calls).toEqual([
      {
        sessionId: 'session-1',
        ref: 'maka://runtime/background-tasks/shell-run-1',
      },
    ]);
  });

  test('WriteStdin exposes the bounded PTY control schema', () => {
    const ptyControls = {
      writeStdin: () => Promise.reject(new Error('not used')),
    } satisfies PtyControlWriter;
    const write = buildBuiltinTools({ ptyControls }).find((tool) => tool.name === 'WriteStdin');
    if (!write) throw new Error('WriteStdin tool missing');
    const parameters = write.parameters as z.ZodTypeAny;
    const maxRef = shellRunResourceRef('x'.repeat(SHELL_RUN_ID_MAX_CHARS));
    const refSchema = zodSchema(parameters).jsonSchema as {
      properties?: { ref?: { maxLength?: number } };
    };

    expect(maxRef.length).toBe(MAX_SHELL_RUN_RESOURCE_REF_CHARS);
    expect(refSchema.properties?.ref?.maxLength).toBe(MAX_SHELL_RUN_RESOURCE_REF_CHARS);
    expect(parameters.safeParse({ ref: maxRef, input: 'hello\r' }).success).toBe(true);
    expect(
      parameters.safeParse({
        ref: `${SHELL_RUN_RESOURCE_PREFIX}/shell-run-1`,
        size: { cols: 240, rows: 100 },
      }).success,
    ).toBe(true);
    for (const ref of [
      'ref',
      `${SHELL_RUN_RESOURCE_PREFIX}/shell/run`,
      `${SHELL_RUN_RESOURCE_PREFIX}/decoy/../shell-run-1`,
      `${SHELL_RUN_RESOURCE_PREFIX}/shell-run-1?view=full`,
      `${maxRef}x`,
    ]) {
      expect(parameters.safeParse({ ref, input: 'hello\r' }).success).toBe(false);
    }
    expect(parameters.safeParse({ ref: maxRef }).success).toBe(false);
    expect(parameters.safeParse({ ref: maxRef, input: '' }).success).toBe(false);
    expect(parameters.safeParse({ ref: maxRef, input: '\uD800' }).success).toBe(false);
    expect(parameters.safeParse({ ref: maxRef, input: 'x'.repeat(64 * 1024 + 1) }).success).toBe(
      false,
    );
    expect(parameters.safeParse({ ref: maxRef, size: { cols: 1, rows: 24 } }).success).toBe(false);
  });

  test('delegates Bash execution to an injected workspace executor', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-bash-executor-'));
    const calls: WorkspaceExecInput[] = [];
    const events: Array<{ stream: 'stdout' | 'stderr'; chunk: string }> = [];
    const bash = buildBuiltinTools({
      executor: fakeExecutor({
        exec: async (input) => {
          calls.push(input);
          input.emitOutput?.('stdout', 'delegated-out');
          return {
            exitCode: 0,
            stdout: 'delegated-out',
            stderr: 'delegated-err',
            timedOut: false,
            aborted: false,
          };
        },
      }),
    }).find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    const result = await bash.impl(
      { command: 'npm test', timeout_ms: 12_345 },
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        cwd,
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: (stream, chunk) => events.push({ stream, chunk }),
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('npm test');
    expect(calls[0]?.cwd).toBe(cwd);
    expect(calls[0]?.timeoutMs).toBe(12_345);
    expect(events).toEqual([{ stream: 'stdout', chunk: 'delegated-out' }]);
    expect(result).toMatchObject({
      kind: 'terminal',
      cwd,
      cmd: 'npm test',
      exitCode: 0,
      output: {
        mode: 'pipes',
        stdout: 'delegated-out',
        stderr: 'delegated-err',
        stdoutTruncated: false,
        stderrTruncated: false,
        redacted: false,
      },
    });
  });

  test('preserves Bash failure contract when the executor reports non-zero exit', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-bash-executor-'));
    const bash = buildBuiltinTools({
      executor: fakeExecutor({
        exec: async () => ({
          exitCode: 4,
          stdout: 'out-data',
          stderr: 'err-data',
          timedOut: false,
          aborted: false,
        }),
      }),
    }).find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    let err: { code?: number; stdout?: string; stderr?: string } | null = null;
    try {
      await bash.impl(
        { command: 'fail', timeout_ms: 5_000 },
        {
          sessionId: 'session-1',
          turnId: 'turn-1',
          cwd,
          toolCallId: 'tool-1',
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
        },
      );
    } catch (e: unknown) {
      err = e as { code?: number; stdout?: string; stderr?: string };
    }

    expect(err?.code).toBe(4);
    expect(err?.stdout).toBe('out-data');
    expect(err?.stderr).toBe('err-data');
  });

  test('emits stdout/stderr chunks before returning terminal result', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-bash-'));
    const events: Array<{ stream: 'stdout' | 'stderr'; chunk: string }> = [];
    const bash = buildBuiltinTools().find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    const result = await bash.impl(
      {
        command: 'printf "out"; printf "err" >&2',
        timeout_ms: 5_000,
      },
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        cwd,
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: (stream, chunk) => events.push({ stream, chunk }),
      },
    );

    expect(events.some((event) => event.stream === 'stdout' && event.chunk.includes('out'))).toBe(
      true,
    );
    expect(events.some((event) => event.stream === 'stderr' && event.chunk.includes('err'))).toBe(
      true,
    );
    expect(result).toMatchObject({
      kind: 'terminal',
      cwd,
      cmd: 'printf "out"; printf "err" >&2',
      exitCode: 0,
      output: {
        mode: 'pipes',
        stdout: 'out',
        stderr: 'err',
        stdoutTruncated: false,
        stderrTruncated: false,
        redacted: false,
      },
    });
  });

  test('aborted Bash command rejects and keeps already emitted output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-bash-'));
    const events: Array<{ stream: 'stdout' | 'stderr'; chunk: string }> = [];
    const abort = new AbortController();
    const bash = buildBuiltinTools().find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    const run = bash.impl(
      {
        command: 'printf "started"; sleep 5',
        timeout_ms: 10_000,
      },
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        cwd,
        toolCallId: 'tool-1',
        abortSignal: abort.signal,
        emitOutput: (stream, chunk) => events.push({ stream, chunk }),
      },
    );
    await waitFor(() => events.length > 0);
    abort.abort();

    await expectRejects(Promise.resolve(run), /Command aborted/);
    expect(
      events.some((event) => event.stream === 'stdout' && event.chunk.includes('started')),
    ).toBe(true);
  });

  test('large output is bounded to a tail instead of being discarded', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-bash-'));
    const bash = buildBuiltinTools().find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    const result = (await bash.impl(
      { command: 'awk \'BEGIN{for(i=1;i<=5000;i++)print "line"i}\'', timeout_ms: 10_000 },
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        cwd,
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      },
    )) as { exitCode: number; output: { stdout: string; stdoutTruncated: boolean } };

    expect(result.exitCode).toBe(0); // no reject — the old code threw away everything past the cap
    expect(result.output.stdout.includes('line5000')).toBe(true); // tail preserved
    expect(result.output.stdout.includes('truncated')).toBe(true); // truncation marker present
    expect(result.output.stdout.includes('line1\n')).toBe(false); // head dropped, not the whole output
    expect(result.output.stdoutTruncated).toBe(true);
  });

  test('foreground Bash marks retained-tail truncation even when model shaping does not truncate again', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-bash-'));
    const bash = buildBuiltinTools().find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    const result = (await bash.impl(
      { command: 'perl -e \'print "x" x 2000000\'', timeout_ms: 10_000 },
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        cwd,
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      },
    )) as { output: { stdout: string; stdoutTruncated: boolean } };

    expect(result.output.stdoutTruncated).toBe(true);
    expect(result.output.stdout).toContain('omitted for safety');
  });

  test('a failing command surfaces stdout/stderr on the rejection error', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-bash-'));
    const bash = buildBuiltinTools().find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    let err: { code?: number; stdout?: string; stderr?: string } | null = null;
    try {
      await bash.impl(
        { command: 'printf "out-data"; printf "err-data" >&2; exit 3', timeout_ms: 5_000 },
        {
          sessionId: 'session-1',
          turnId: 'turn-1',
          cwd,
          toolCallId: 'tool-1',
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
        },
      );
    } catch (e: unknown) {
      err = e as { code?: number; stdout?: string; stderr?: string };
    }

    expect(err?.code).toBe(3);
    expect(err?.stdout).toBe('out-data');
    expect(err?.stderr).toBe('err-data');
  });

  test('a timed-out command still surfaces the stdout/stderr captured before the timeout', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-bash-'));
    const bash = buildBuiltinTools().find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    let err: { code?: number; stdout?: string; stderr?: string } | null = null;
    try {
      await bash.impl(
        { command: 'printf "out-before"; printf "err-before" >&2; sleep 5', timeout_ms: 200 },
        {
          sessionId: 'session-1',
          turnId: 'turn-1',
          cwd,
          toolCallId: 'tool-1',
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
        },
      );
    } catch (e: unknown) {
      err = e as { code?: number; stdout?: string; stderr?: string };
    }

    expect(err?.code).toBe(124);
    expect(err?.stdout).toBe('out-before');
    expect(err?.stderr).toBe('err-before');
  });
});

describe('builtin Bash sandbox denial classification', () => {
  test('throws SandboxCommandError when a sandboxed command emits a denial message', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-bash-sandbox-denial-'));
    try {
      const executor = fakeExecutor({
        exec: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'Operation not permitted',
          timedOut: false,
          aborted: false,
        }),
      });
      const bash = buildBuiltinTools({
        executor,
        permissionProfile: createWorkspaceWritePermissionProfile(),
        sandboxManager: new SandboxManager([new MacosSeatbeltBackend()]),
        sandboxPlatform: 'darwin',
      }).find((candidate) => candidate.name === 'Bash');
      if (!bash) throw new Error('Bash tool missing');

      let err: unknown = null;
      try {
        await bash.impl(
          { command: 'rm -rf /', timeout_ms: 5_000 },
          {
            sessionId: 'session-1',
            turnId: 'turn-1',
            cwd,
            toolCallId: 'tool-1',
            abortSignal: new AbortController().signal,
            emitOutput: () => {},
          },
        );
      } catch (e: unknown) {
        err = e;
      }

      assert.ok(err instanceof SandboxCommandError, 'expected a SandboxCommandError');
      assert.equal((err as SandboxCommandError).reason, 'sandbox_denial');
      assert.equal((err as SandboxCommandError).recoverable, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('builtin read tools path containment', () => {
  test('Read snapshots the complete image returned by the workspace executor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-read-image-'));
    const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const snapshots: unknown[] = [];
    const read = buildBuiltinTools({
      executor: fakeExecutor({
        readFile: async () => ({ bytes: imageBytes, mimeType: 'image/png' }),
      }),
      snapshotImage: async (input) => {
        snapshots.push(input);
        return { kind: 'session_file', sessionId: input.sessionId, relativePath: 'artifact-1' };
      },
    }).find((candidate) => candidate.name === 'Read');
    if (!read) throw new Error('Read tool missing');

    const result = await runTool(read, { path: 'PHOTO.PNG', offset: 1, limit: 1 }, root);

    expect(result).toEqual({
      kind: 'image',
      mimeType: 'image/png',
      ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'artifact-1' },
    });
    expect(snapshots).toEqual([
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'PHOTO.PNG',
        bytes: imageBytes,
        mimeType: 'image/png',
      },
    ]);
  });

  test('Read rejects image content without snapshot support, regardless of extension', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-read-image-'));
    await writeFile(join(root, 'photo.png'), ONE_PIXEL_PNG);
    await symlink('photo.png', join(root, 'notes.txt'));
    const readWithoutSnapshots = buildBuiltinTools().find((candidate) => candidate.name === 'Read');
    if (!readWithoutSnapshots) throw new Error('Read tool missing');

    await expectRejects(
      runTool(readWithoutSnapshots, { path: 'notes.txt' }, root),
      /snapshots are not available/,
    );
  });

  test('Read delegates file loading to the injected workspace executor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-read-executor-'));
    await writeFile(join(root, 'inside.txt'), 'local-content', 'utf8');
    const readInputs: unknown[] = [];
    const read = buildBuiltinTools({
      executor: fakeExecutor({
        readFile: async (input) => {
          readInputs.push(input);
          return { content: 'executor-window' };
        },
      }),
    }).find((candidate) => candidate.name === 'Read');
    if (!read) throw new Error('Read tool missing');

    const result = await runTool(read, { path: 'inside.txt', offset: 1, limit: 1 }, root);

    expect(readInputs).toHaveLength(1);
    expect(readInputs[0]).toMatchObject({
      offset: 1,
      limit: 1,
    });
    expect(String((readInputs[0] as { path?: string }).path)).toMatch(/inside\.txt$/);
    expect(result).toMatchObject({ content: 'executor-window' });
  });

  test('Read rejects absolute, parent traversal, and symlink escape paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-read-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-read-outside-'));
    await writeFile(join(root, 'inside.txt'), 'inside', 'utf8');
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(root, 'secret-link.txt'));
    const read = tool('Read');

    await expectRejects(runTool(read, { path: '/etc/hosts' }, root), /Read path must be relative/);
    await expectRejects(
      runTool(read, { path: '../outside.txt' }, root),
      /Read path must stay inside/,
    );
    await expectRejects(
      runTool(read, { path: 'secret-link.txt' }, root),
      /Read path must stay inside/,
    );

    const result = await runTool(read, { path: 'inside.txt' }, root);
    expect(result).toMatchObject({ content: 'inside' });
  });

  test('Glob and Grep constrain search roots to session cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-read-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-read-outside-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'main.ts'), 'export const token = 1;\n', 'utf8');
    await symlink(outside, join(root, 'outside-link'));
    const glob = tool('Glob');
    const grep = tool('Grep');

    await expectRejects(
      runTool(glob, { pattern: '../*.txt' }, root),
      /Glob pattern must stay inside/,
    );
    await expectRejects(
      runTool(glob, { pattern: '*.txt', cwd: 'outside-link' }, root),
      /Glob cwd path must stay inside/,
    );
    await expectRejects(
      runTool(grep, { pattern: 'token', path: '/etc' }, root),
      /Grep path must be relative/,
    );
    await expectRejects(
      runTool(grep, { pattern: 'secret', path: 'outside-link' }, root),
      /Grep path must stay inside/,
    );

    const globResult = await runTool(glob, { pattern: '**/*.ts' }, root);
    expect(globResult).toMatchObject({ files: ['src/main.ts'] });
    const grepResult = await runTool(grep, { pattern: 'token', path: 'src' }, root);
    expect(JSON.stringify(grepResult).includes('main.ts')).toBe(true);
  });

  test('Glob delegates matching to the injected workspace executor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-glob-executor-'));
    await mkdir(join(root, 'src'), { recursive: true });
    const calls: Array<{ cwd: string; pattern: string; limit?: number }> = [];
    const glob = buildBuiltinTools({
      executor: fakeExecutor({
        globFiles: async (input) => {
          calls.push(input);
          return { files: ['from-executor.ts'] };
        },
      }),
    }).find((candidate) => candidate.name === 'Glob');
    if (!glob) throw new Error('Glob tool missing');

    const result = await runTool(glob, { pattern: '**/*.ts', cwd: 'src' }, root);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd.endsWith('src')).toBe(true);
    expect(calls[0]?.pattern).toBe('**/*.ts');
    expect(calls[0]?.limit).toBe(200);
    expect(result).toMatchObject({ files: ['from-executor.ts'] });
  });

  test('Grep delegates searching to the injected workspace executor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-grep-executor-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'main.ts'), 'local token\n', 'utf8');
    const calls: Array<{
      cwd: string;
      pattern: string;
      path: string;
      glob?: string;
      maxCountPerFile: number;
      limit: number;
    }> = [];
    const grep = buildBuiltinTools({
      executor: fakeExecutor({
        grepFiles: async (input) => {
          calls.push(input);
          return { matches: ['from-executor.ts:1:token'] };
        },
      }),
    }).find((candidate) => candidate.name === 'Grep');
    if (!grep) throw new Error('Grep tool missing');

    const result = await runTool(grep, { pattern: 'token', path: 'src', glob: '*.ts' }, root);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(root);
    expect(calls[0]?.path.endsWith('src')).toBe(true);
    expect(calls[0]?.glob).toBe('*.ts');
    expect(calls[0]?.maxCountPerFile).toBe(50);
    expect(calls[0]?.limit).toBe(200);
    expect(result).toMatchObject({ matches: ['from-executor.ts:1:token'] });
  });
});

describe('builtin write tools path containment', () => {
  test('Write can delegate path resolution to a remote executor when cwd is not on the host', async () => {
    const writes: Array<{ cwd: string; path: string; content: string }> = [];
    const write = buildBuiltinTools({
      executor: fakeExecutor({
        writeLockKey: async ({ cwd, path }) => ({ key: JSON.stringify([cwd, path]) }),
        resolveWritablePath: async ({ cwd, path }) => ({ path: `${cwd}/${path}` }),
        writeFile: async ({ cwd, path, content }) => {
          writes.push({ cwd, path, content });
          return { ok: true, path, bytes: Buffer.byteLength(content, 'utf8') };
        },
      }),
    }).find((candidate) => candidate.name === 'Write');
    if (!write) throw new Error('Write tool missing');

    const result = await runTool(
      write,
      { path: 'created.txt', content: 'from-executor' },
      '/workspace',
    );

    expect(writes).toEqual([
      {
        cwd: '/workspace',
        path: '/workspace/created.txt',
        content: 'from-executor',
      },
    ]);
    expect(result).toMatchObject({ ok: true, path: '/workspace/created.txt', bytes: 13 });
  });

  test('Write delegates file writing to the injected workspace executor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-write-executor-'));
    const writes: Array<{ path: string; content: string }> = [];
    const write = buildBuiltinTools({
      executor: fakeExecutor({
        writeFile: async ({ path, content }) => {
          writes.push({ path, content });
          return { ok: true, path, bytes: Buffer.byteLength(content, 'utf8') };
        },
      }),
    }).find((candidate) => candidate.name === 'Write');
    if (!write) throw new Error('Write tool missing');

    const result = await runTool(write, { path: 'created.txt', content: 'from-executor' }, root);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.path.endsWith('created.txt')).toBe(true);
    expect(writes[0]?.content).toBe('from-executor');
    expect(result).toMatchObject({ ok: true, bytes: 13 });
  });

  test('Edit reads and writes through the injected workspace executor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-edit-executor-'));
    await writeFile(join(root, 'data.txt'), 'local content that should not be used', 'utf8');
    const reads: string[] = [];
    const writes: Array<{ path: string; content: string }> = [];
    const edit = buildBuiltinTools({
      executor: fakeExecutor({
        readFile: async ({ path }) => {
          reads.push(path);
          return { content: 'hello world\n' };
        },
        writeFile: async ({ path, content }) => {
          writes.push({ path, content });
          return { ok: true, path, bytes: Buffer.byteLength(content, 'utf8') };
        },
      }),
    }).find((candidate) => candidate.name === 'Edit');
    if (!edit) throw new Error('Edit tool missing');

    const result = await runTool(
      edit,
      { path: 'data.txt', old_string: 'world', new_string: 'Maka' },
      root,
    );

    expect(reads).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.content).toBe('hello Maka\n');
    expect(result).toMatchObject({
      ok: true,
      replacements: 1,
    });
  });

  test('Edit rejects image results from the workspace executor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-edit-image-'));
    const edit = buildBuiltinTools({
      executor: fakeExecutor({
        readFile: async () => ({ bytes: new Uint8Array([1]), mimeType: 'image/png' }),
      }),
    }).find((candidate) => candidate.name === 'Edit');
    if (!edit) throw new Error('Edit tool missing');

    await expectRejects(
      runTool(edit, { path: 'image.png', old_string: 'x', new_string: 'y' }, root),
      /Edit does not support image files/,
    );
  });

  test('Write rejects absolute, parent traversal, and symlink-parent escape paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-write-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-write-outside-'));
    await symlink(outside, join(root, 'outside-link'));
    const write = tool('Write');

    await expectRejects(
      runTool(write, { path: '/tmp/outside.txt', content: 'x' }, root),
      /Write path must be relative/,
    );
    await expectRejects(
      runTool(write, { path: '../outside.txt', content: 'x' }, root),
      /Write path must stay inside/,
    );
    await expectRejects(
      runTool(write, { path: 'outside-link/new.txt', content: 'x' }, root),
      /Write path must stay inside/,
    );

    await mkdir(join(root, 'src'), { recursive: true });
    await runTool(write, { path: 'src/new.txt', content: 'inside' }, root);
    expect(await readFile(join(root, 'src', 'new.txt'), 'utf8')).toBe('inside');
  });

  test('Edit rejects absolute, parent traversal, and symlink file escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-edit-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-edit-outside-'));
    await writeFile(join(root, 'inside.txt'), 'hello world', 'utf8');
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(root, 'secret-link.txt'));
    const edit = tool('Edit');

    await expectRejects(
      runTool(edit, { path: '/tmp/outside.txt', old_string: 'x', new_string: 'y' }, root),
      /Edit path must be relative/,
    );
    await expectRejects(
      runTool(edit, { path: '../outside.txt', old_string: 'x', new_string: 'y' }, root),
      /Edit path must stay inside/,
    );
    await expectRejects(
      runTool(edit, { path: 'secret-link.txt', old_string: 'secret', new_string: 'edited' }, root),
      /Edit path must stay inside/,
    );

    await runTool(edit, { path: 'inside.txt', old_string: 'world', new_string: 'Maka' }, root);
    expect(await readFile(join(root, 'inside.txt'), 'utf8')).toBe('hello Maka');
  });

  test('concurrent Edits to the same file serialize — no lost update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-edit-lock-'));
    const n = 20;
    const markers = Array.from({ length: n }, (_, i) => `marker-${String(i).padStart(2, '0')}`);
    await writeFile(join(root, 'data.txt'), `${markers.join('\n')}\n`, 'utf8');
    const edit = tool('Edit');
    // Each Edit is a read-modify-write (fs.readFile -> replace -> fs.writeFile).
    // Fired concurrently without the per-path lock, the writes clobber each other
    // and most edits are lost; the lock serializes them so every one lands.
    const results = await Promise.all(
      markers.map((m, i) =>
        runTool(
          edit,
          { path: 'data.txt', old_string: m, new_string: `done-${String(i).padStart(2, '0')}` },
          root,
        ),
      ),
    );
    expect(
      results.every(
        (r) =>
          (r as { ok: boolean; replacements: number }).ok === true &&
          (r as { replacements: number }).replacements === 1,
      ),
    ).toBe(true);
    const expected = `${Array.from({ length: n }, (_, i) => `done-${String(i).padStart(2, '0')}`).join('\n')}\n`;
    expect(await readFile(join(root, 'data.txt'), 'utf8')).toBe(expected);
  });

  test('concurrent Edits via different path spellings serialize on one key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-edit-spelling-'));
    const n = 20;
    const markers = Array.from({ length: n }, (_, i) => `marker-${String(i).padStart(2, '0')}`);
    await writeFile(join(root, 'data.txt'), `${markers.join('\n')}\n`, 'utf8');
    const edit = tool('Edit');
    // Alternate the spelling of the same file. The key resolves both spellings to
    // one absolute path, so all edits share a lock; without that collapse the two
    // groups would run concurrently and clobber each other.
    const results = await Promise.all(
      markers.map((m, i) =>
        runTool(
          edit,
          {
            path: i % 2 === 0 ? 'data.txt' : './data.txt',
            old_string: m,
            new_string: `done-${String(i).padStart(2, '0')}`,
          },
          root,
        ),
      ),
    );
    expect(results.every((r) => (r as { ok: boolean }).ok === true)).toBe(true);
    const expected = `${Array.from({ length: n }, (_, i) => `done-${String(i).padStart(2, '0')}`).join('\n')}\n`;
    expect(await readFile(join(root, 'data.txt'), 'utf8')).toBe(expected);
  });

  test('Write then Edit on one file resolves inside the lock — the fresh file is found', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-write-edit-'));
    const write = tool('Write');
    const edit = tool('Edit');
    // Edit now resolves its target inside the lock (containment + existence check
    // moved in). This guards that flow: a Write creates a brand-new file, then an
    // Edit on the same path still resolves and rewrites it.
    await runTool(write, { path: 'fresh.txt', content: 'hello world\n' }, root);
    await runTool(edit, { path: 'fresh.txt', old_string: 'world', new_string: 'Maka' }, root);
    expect(await readFile(join(root, 'fresh.txt'), 'utf8')).toBe('hello Maka\n');
  });

  test('a failing Edit releases the lock for the next op on the same file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-edit-wedge-'));
    await writeFile(join(root, 'data.txt'), 'hello world\n', 'utf8');
    const edit = tool('Edit');
    // An Edit whose old_string is absent rejects; the lock must not wedge, so the
    // next Edit on the same file still runs.
    await expectRejects(
      runTool(edit, { path: 'data.txt', old_string: 'absent', new_string: 'x' }, root),
      /./,
    );
    await runTool(edit, { path: 'data.txt', old_string: 'world', new_string: 'Maka' }, root);
    expect(await readFile(join(root, 'data.txt'), 'utf8')).toBe('hello Maka\n');
  });
});

describe('builtin FormatJson (file in place)', () => {
  async function writeInput(root: string, name: string, content: string): Promise<string> {
    const path = join(root, name);
    await writeFile(path, content, 'utf8');
    return name;
  }

  async function runFormatJson(args: { path: string; sort_keys?: boolean }, root: string) {
    const t = tool('FormatJson');
    return (await runTool(t, args, root)) as {
      ok: boolean;
      path: string;
      valid: boolean;
      error?: string;
      bytesBefore: number;
      bytesAfter?: number;
      byteDelta: number;
      changed: boolean;
    };
  }

  test('happy path: validates and rewrites a minified JSON file in place', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-formatjson-'));
    const input = '{"b":1,"a":[2,3],"c":{"d":true}}';
    const name = await writeInput(root, 'data.json', input);

    const result = await runFormatJson({ path: name }, root);

    const onDisk = await readFile(join(root, name), 'utf8');
    expect(onDisk).toBe(JSON.stringify(JSON.parse(input), null, 2));
    expect(result.ok).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.bytesBefore).toBe(Buffer.byteLength(input, 'utf8'));
    expect(result.bytesAfter).toBe(Buffer.byteLength(onDisk, 'utf8'));
    expect(result.byteDelta).toBe((result.bytesAfter ?? 0) - result.bytesBefore);
  });

  test('rejects image results from the workspace executor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-formatjson-image-'));
    const formatJson = buildBuiltinTools({
      executor: fakeExecutor({
        readFile: async () => ({ bytes: new Uint8Array([1]), mimeType: 'image/png' }),
      }),
    }).find((candidate) => candidate.name === 'FormatJson');
    if (!formatJson) throw new Error('FormatJson tool missing');

    await expectRejects(
      runTool(formatJson, { path: 'image.png' }, root),
      /FormatJson does not support image files/,
    );
  });

  test('sort_keys: true orders object keys lexicographically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-formatjson-'));
    const name = await writeInput(root, 'data.json', '{"z":1,"a":2,"m":3}');

    const result = await runFormatJson({ path: name, sort_keys: true }, root);

    const onDisk = await readFile(join(root, name), 'utf8');
    expect(onDisk).toBe('{\n  "a": 2,\n  "m": 3,\n  "z": 1\n}');
    expect(result.changed).toBe(true);
  });

  test('sort_keys: true preserves __proto__ as a data property', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-formatjson-'));
    const name = await writeInput(root, 'data.json', '{"__proto__":{"polluted":true},"a":1}');

    await runFormatJson({ path: name, sort_keys: true }, root);

    const parsed = JSON.parse(await readFile(join(root, name), 'utf8')) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect(parsed['__proto__']).toEqual({ polluted: true });
    expect(parsed.a).toBe(1);
  });

  test('sort_keys: true sorts nested objects recursively', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-formatjson-'));
    const name = await writeInput(
      root,
      'data.json',
      '{"outer":{"z":1,"a":2},"list":[{"b":1,"a":2}]}',
    );

    await runFormatJson({ path: name, sort_keys: true }, root);

    const parsed = JSON.parse(await readFile(join(root, name), 'utf8'));
    expect(Object.keys(parsed.outer)).toEqual(['a', 'z']);
    expect(Object.keys(parsed.list[0])).toEqual(['a', 'b']);
  });

  test('invalid JSON returns a structured error diagnostic (no write, byteDelta 0)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-formatjson-'));
    const name = await writeInput(root, 'data.json', 'not json');

    const result = await runFormatJson({ path: name }, root);

    expect(result.ok).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/FormatJson: invalid JSON/);
    expect(result.byteDelta).toBe(0);
    expect(result.changed).toBe(false);
    // File is left untouched on invalid input.
    expect(await readFile(join(root, name), 'utf8')).toBe('not json');
  });

  test('already-canonical content reports changed: false with zero byte delta', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-formatjson-'));
    const name = await writeInput(root, 'empty.json', '{}');

    const result = await runFormatJson({ path: name }, root);

    expect(result.changed).toBe(false);
    expect(result.byteDelta).toBe(0);
    expect(await readFile(join(root, name), 'utf8')).toBe('{}');
  });

  test('handles unicode and special characters in strings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-formatjson-'));
    const name = await writeInput(root, 'data.json', '{"emoji":"🎉","cjk":"你好"}');

    const result = await runFormatJson({ path: name }, root);

    const onDisk = await readFile(join(root, name), 'utf8');
    expect(result.valid).toBe(true);
    expect(onDisk).toContain('🎉');
    expect(onDisk).toContain('你好');
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for predicate');
}

async function linuxMissingExactWriteFixture() {
  const root = await mkdtemp(join(tmpdir(), 'maka-linux-exact-write-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  const canonicalWorkspace = await realpath(workspace);
  const target = join(await realpath(outside), 'new.txt');
  const args = {
    command: 'true',
    sandbox_permissions: {
      mode: 'with_additional_permissions' as const,
      file_system: {
        entries: [{ path: target, access: 'write' as const, scope: 'exact' as const }],
      },
      justification: 'Write the selected output.',
    },
  };
  const context = {
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    cwd: canonicalWorkspace,
    permissionMode: 'execute' as const,
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
    permissionContext: {
      additionalGrant: {
        grantId: 'grant-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        intentHash: 'intent',
        permissionsHash: 'permissions',
        profile: {
          fileSystem: {
            entries: [{ path: target, access: 'write' as const, scope: 'exact' as const }],
          },
        },
        normalizedPaths: [
          {
            displayPath: target,
            enforcementPath: target,
            access: 'write' as const,
            scope: 'exact' as const,
            targetType: 'missing' as const,
          },
        ],
        risk: { outsideWorkspace: true, protectedMetadata: false, networkEnabled: false },
        issuedAt: 1,
        expiresAt: 2,
      },
    },
  };

  return {
    target,
    args,
    context,
    buildBash(shellRuns: ShellRunLauncher) {
      const bash = buildBuiltinTools({
        shellRuns,
        permissionProfile: createWorkspaceWritePermissionProfile(),
        sandboxManager: availableLinuxManager(),
        sandboxPlatform: 'linux',
        enableBashAdditionalPermissions: true,
      }).find((candidate) => candidate.name === 'Bash');
      if (!bash) throw new Error('Bash tool missing');
      return bash;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function terminalResult(
  input: { cwd: string; command: string },
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out',
  exitCode: number,
) {
  return {
    kind: 'terminal',
    cwd: input.cwd,
    cmd: input.command,
    status,
    exitCode,
    output: {
      mode: 'pipes',
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      redacted: false,
    },
  } as const;
}

function hasArgTriple(
  argv: readonly string[],
  option: string,
  source: string,
  target: string,
): boolean {
  return argv.some(
    (value, index) => value === option && argv[index + 1] === source && argv[index + 2] === target,
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function expectRejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error instanceof Error ? error.message : String(error)).toMatch(pattern);
    return;
  }
  throw new Error('expected promise to reject');
}

function tool(name: string) {
  const found = buildBuiltinTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`${name} tool missing`);
  return found;
}

function runTool(
  tool: ReturnType<typeof buildBuiltinTools>[number],
  args: unknown,
  cwd: string,
): Promise<unknown> {
  return Promise.resolve(
    tool.impl(args as never, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      cwd,
      toolCallId: 'tool-1',
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
    }),
  );
}

function fakeExecutor(overrides: Partial<WorkspaceExecutor>): WorkspaceExecutor {
  const base: WorkspaceExecutor = {
    facts: LOCAL_WORKSPACE_EXECUTOR_FACTS,
    exec: async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: false,
    }),
    readFile: async () => ({ content: '' }),
    writeFile: async ({ path, content }) => ({
      ok: true,
      path,
      bytes: Buffer.byteLength(content, 'utf8'),
    }),
    resolveExistingPath: async ({ path }) => ({ path }),
    resolveWritablePath: async ({ path }) => ({ path }),
    writeLockKey: async ({ cwd, path }) => ({ key: `${cwd}:${path}` }),
    globFiles: async () => ({ files: [] }),
    grepFiles: async () => ({ matches: [] }),
  };
  return Object.assign(base, overrides);
}

function availableLinuxManager(): SandboxManager {
  return new SandboxManager([
    new LinuxBubblewrapBackend({
      capability: { available: true, bwrapPath: '/usr/bin/bwrap' },
    }),
  ]);
}

function unavailableLinuxManager(): SandboxManager {
  return new SandboxManager([
    new LinuxBubblewrapBackend({
      capability: { available: false, reason: 'missing-bwrap', bwrapPath: '/usr/bin/bwrap' },
    }),
  ]);
}
