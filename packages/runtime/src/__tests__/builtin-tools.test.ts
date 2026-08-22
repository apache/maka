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
import { z } from 'zod';
import { applySandboxBoundaryExpansion } from '@maka/core/sandbox-boundary';
import { SHELL_RUN_ID_MAX_CHARS } from '@maka/core/shell-run';
import {
  createDangerFullAccessPermissionProfile,
  createWorkspaceWritePermissionProfile,
  type PermissionProfile,
} from '@maka/core/permission-profile';
import { expect } from '../test-helpers.js';
import { buildBuiltinTools } from '../builtin-tools.js';
import { SandboxManager } from '../sandbox/sandbox-manager.js';
import { LinuxBubblewrapBackend } from '../sandbox/linux-sandbox.js';
import { MacosSeatbeltBackend } from '../sandbox/macos-seatbelt.js';
import { WindowsBrokerSandboxBackend } from '../sandbox/windows-sandbox.js';
import { SandboxCommandError } from '../sandbox/errors.js';
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

describe('builtin apply_patch', () => {
  test('rejects unsupported V4A Move before applying any file operation', async () => {
    let calls = 0;
    const applyPatch = buildBuiltinTools({
      executor: fakeExecutor({
        applyPatch: async (input) => {
          calls += 1;
          return { ok: true, path: input.path };
        },
      }),
    }).find((tool) => tool.name === 'apply_patch');
    if (!applyPatch) throw new Error('apply_patch tool missing');

    await assert.rejects(
      runTool(
        applyPatch,
        [
          '*** Begin Patch',
          '*** Add File: first.txt',
          '+first',
          '*** Update File: old.txt',
          '*** Move to: new.txt',
          '@@',
          '-old',
          '+new',
          '*** End Patch',
        ].join('\n'),
        '/workspace',
      ),
      /Move is not supported/,
    );
    assert.equal(calls, 0);
  });

  test('reports the applied prefix when a later V4A operation fails', async () => {
    const applyPatch = buildBuiltinTools({
      executor: fakeExecutor({
        applyPatch: async ({ path }) => {
          if (path === 'missing.txt') throw new Error('target is missing');
          return { ok: true, path };
        },
      }),
    }).find((tool) => tool.name === 'apply_patch');
    if (!applyPatch) throw new Error('apply_patch tool missing');

    const result = (await runTool(
      applyPatch,
      [
        '*** Begin Patch',
        '*** Add File: first.txt',
        '+first',
        '*** Update File: missing.txt',
        '@@',
        '-before',
        '+after',
        '*** End Patch',
      ].join('\n'),
      '/workspace',
    )) as {
      status: string;
      applied: unknown;
      failed: unknown;
      error: string;
    };

    assert.equal(result.status, 'failed');
    assert.deepEqual(result.applied, [{ type: 'create_file', path: 'first.txt' }]);
    assert.deepEqual(result.failed, { type: 'update_file', path: 'missing.txt' });
    assert.match(result.error, /target is missing/);
  });

  test('does not start another V4A operation after the turn is stopped', async () => {
    const abortController = new AbortController();
    const paths: string[] = [];
    const applyPatch = buildBuiltinTools({
      executor: fakeExecutor({
        applyPatch: async ({ path }) => {
          paths.push(path);
          abortController.abort();
          return { ok: true, path };
        },
      }),
    }).find((tool) => tool.name === 'apply_patch');
    if (!applyPatch) throw new Error('apply_patch tool missing');

    const result = (await runTool(
      applyPatch,
      [
        '*** Begin Patch',
        '*** Add File: first.txt',
        '+first',
        '*** Delete File: second.txt',
        '*** Add File: third.txt',
        '+third',
        '*** End Patch',
      ].join('\n'),
      '/workspace',
      abortController.signal,
    )) as {
      status: string;
      applied: unknown;
      stoppedBefore: unknown;
      error: string;
    };

    assert.deepEqual(paths, ['first.txt']);
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.applied, [{ type: 'create_file', path: 'first.txt' }]);
    assert.deepEqual(result.stoppedBefore, { type: 'delete_file', path: 'second.txt' });
    assert.match(result.error, /stopped before delete_file second\.txt/);
  });

  test('applies freeform V4A contents to real files', async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-freeform-apply-patch-'));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await writeFile(join(cwd, 'changed.txt'), 'before\n', 'utf8');
    const applyPatch = buildBuiltinTools().find((tool) => tool.name === 'apply_patch');
    if (!applyPatch) throw new Error('apply_patch tool missing');

    await runTool(
      applyPatch,
      [
        '*** Begin Patch',
        '*** Add File: added.txt',
        '+hello',
        '*** Update File: changed.txt',
        '@@',
        '-before',
        '+after',
        '*** End Patch',
      ].join('\n'),
      cwd,
    );

    assert.equal(await readFile(join(cwd, 'added.txt'), 'utf8'), 'hello\n');
    assert.equal(await readFile(join(cwd, 'changed.txt'), 'utf8'), 'after\n');
  });
});

describe('builtin ArchiveRead capabilities', () => {
  test('is not a built-in tool', () => {
    // The archive decoder travels with the archive capability and is bound by
    // the backend (#2026). A host that assembles built-ins can no longer
    // forget it, and can no longer register it without a writer behind it.
    assert.equal(
      buildBuiltinTools().find((tool) => tool.name === 'ArchiveRead'),
      undefined,
    );
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

describe('builtin Bash projection and shell execution', () => {
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
    // executor's spawn, stdout echoes the PowerShell flags and wrapper instead
    // of a bare 'wired-marker' from the default POSIX shell.
    const tools = buildBuiltinTools({
      shell: { plan: { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: '/bin/echo' } },
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
        '-NoLogo -NoProfile -NonInteractive -Command $__makaUtf8 = [System.Text.UTF8Encoding]::new($false)\n',
      ),
    ).toBe(true);
  });
});

describe('builtin Bash streaming output', () => {
  test('exposes no one-shot permission schema', () => {
    const linuxBash = buildBuiltinTools({
      sandboxManager: availableLinuxManager(),
      sandboxPlatform: 'linux',
    }).find((tool) => tool.name === 'Bash');
    assert.ok(linuxBash);
    assert.equal(
      (linuxBash.parameters as z.ZodTypeAny).safeParse({
        command: 'echo unsafe',
        sandbox_permissions: {
          mode: 'require_escalated',
          justification: 'The sandbox cannot perform this action.',
        },
      }).success,
      false,
    );
  });

  test('Bash schema exposes explicit background execution and boundary declarations', () => {
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
    expect(
      parameters.safeParse({
        command: 'curl https://example.com',
        required_boundary: { network: { enabled: true } },
      }).success,
    ).toBe(true);
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
        (input: { sourceFd?: number; fd: number }) =>
          input.sourceFd !== undefined &&
          hasArgTriple(launchInput.argv, '--bind', `/proc/self/fd/${input.fd}`, fixture.target),
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

  test('pins an existing active exact target without deleting it after completion', async () => {
    const fixture = await linuxMissingExactWriteFixture();
    let launchInput: any;
    const bash = fixture.buildBash({
      async runForegroundBash(input: any) {
        launchInput = input;
        input.onCompletion?.({ successful: true });
        return terminalResult(input, 'completed', 0);
      },
      async runBackgroundBash() {
        throw new Error('not used');
      },
    });

    try {
      await writeFile(fixture.target, 'existing');
      await bash.impl(fixture.args, fixture.context);

      const pinned = launchInput.fdInputs.find(
        (input: { sourceFd?: number; fd: number }) =>
          input.sourceFd !== undefined &&
          hasArgTriple(launchInput.argv, '--bind', `/proc/self/fd/${input.fd}`, fixture.target),
      );
      assert.ok(pinned);
      assert.equal(await readFile(fixture.target, 'utf8'), 'existing');
    } finally {
      await fixture.cleanup();
    }
  });

  test('omits an inactive exact target that was replaced by a symlink', async () => {
    const fixture = await linuxMissingExactWriteFixture();
    const replacement = join(dirname(fixture.target), 'replacement.txt');
    let launchInput: any;
    const bash = fixture.buildBash({
      async runForegroundBash(input: any) {
        launchInput = input;
        return terminalResult(input, 'completed', 0);
      },
      async runBackgroundBash() {
        throw new Error('not used');
      },
    });

    try {
      await writeFile(replacement, 'outside');
      await symlink(replacement, fixture.target);

      await bash.impl({ command: 'true' }, fixture.context);

      assert.ok(launchInput);
      assert.equal(launchInput.argv.includes(fixture.target), false);
      assert.equal(launchInput.argv.includes(replacement), false);
    } finally {
      await fixture.cleanup();
    }
  });

  test('omits a missing subtree grant from an unrelated Linux Bash mount plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-linux-missing-subtree-'));
    const workspace = await realpath(
      await mkdir(join(root, 'workspace')).then(() => join(root, 'workspace')),
    );
    const missingSubtree = join(root, 'missing-subtree');
    let launchInput: any;
    const bash = buildBuiltinTools({
      shellRuns: {
        async runForegroundBash(input: any) {
          launchInput = input;
          return terminalResult(input, 'completed', 0);
        },
        async runBackgroundBash() {
          throw new Error('not used');
        },
      },
      permissionProfile: createWorkspaceWritePermissionProfile(),
      sandboxManager: availableLinuxManager(),
      sandboxPlatform: 'linux',
    }).find((candidate) => candidate.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    try {
      await bash.impl(
        { command: 'true' },
        {
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolCallId: 'tool-1',
          cwd: workspace,
          permissionMode: 'execute',
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
          executionBoundary: {
            kind: 'managed',
            revision: 1,
            profile: applySandboxBoundaryExpansion(createWorkspaceWritePermissionProfile(), {
              filesystem: {
                entries: [{ path: missingSubtree, access: 'read', scope: 'subtree' }],
              },
            }),
          },
        },
      );

      assert.ok(launchInput);
      assert.equal(launchInput.argv.includes(missingSubtree), false);
    } finally {
      await rm(root, { recursive: true, force: true });
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
          (candidate: { sourceFd?: number; fd: number }) =>
            candidate.sourceFd !== undefined &&
            hasArgTriple(input.argv, '--bind', `/proc/self/fd/${candidate.fd}`, fixture.target),
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

  test('does not let an unrelated stale exact-write grant block Bash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-linux-stale-exact-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const cwd = await realpath(workspace);
    const staleTarget = join(root, 'removed-parent', 'stale.txt');
    const calls: unknown[] = [];
    const bash = buildBuiltinTools({
      shellRuns: {
        async runForegroundBash(input) {
          calls.push(input);
          return terminalResult(input, 'completed', 0);
        },
        async runBackgroundBash() {
          throw new Error('not used');
        },
      },
      sandboxManager: availableLinuxManager(),
      sandboxPlatform: 'linux',
    }).find((candidate) => candidate.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    try {
      await bash.impl(
        { command: 'true' },
        {
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolCallId: 'tool-1',
          cwd,
          permissionMode: 'execute',
          executionBoundary: {
            kind: 'managed',
            revision: 1,
            profile: applySandboxBoundaryExpansion(createWorkspaceWritePermissionProfile(), {
              filesystem: {
                entries: [{ path: staleTarget, access: 'write', scope: 'exact' }],
              },
            }),
          },
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
        },
      );
      expect(calls).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reports requires_bypass for managed PTY Bash and runs it only at a bypass boundary', async () => {
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
    await assert.rejects(
      async () => {
        await bash.impl(ptyArgs, {
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolCallId: 'tool-1',
          cwd: '/workspace',
          permissionMode: 'execute',
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
          executionBoundary: {
            kind: 'managed',
            revision: 0,
            profile: createWorkspaceWritePermissionProfile(),
          },
        });
      },
      (error) => error instanceof SandboxCommandError && error.reason === 'requires_bypass',
    );
    expect(calls.length).toBe(0);

    await bash.impl(ptyArgs, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'tool-2',
      cwd: '/workspace',
      permissionMode: 'execute',
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
      executionBoundary: { kind: 'bypass', revision: 1 },
    });

    expect(calls[0]?.argv).toBe(undefined);
    expect(calls[0]?.fdInputs).toBe(undefined);
    expect(Boolean(calls[0]?.shell)).toBe(true);
    expect(calls[0]?.sandboxType).toBe(undefined);
  });

  test('requires an approved network expansion before declared Bash network access', async () => {
    const calls: any[] = [];
    const shellRuns: ShellRunLauncher = {
      async runForegroundBash(input) {
        calls.push(input);
        return {
          kind: 'terminal',
          cwd: input.cwd,
          cmd: input.command,
          status: 'completed',
          exitCode: 0,
          output: {
            mode: 'pipes',
            stdout: 'network',
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
      sandboxManager: availableLinuxManager(),
      sandboxPlatform: 'linux',
    }).find((candidate) => candidate.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');
    const args = {
      command: 'curl https://example.com',
      required_boundary: { network: { enabled: true as const } },
    };
    const context = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      cwd: '/workspace',
      permissionMode: 'ask' as const,
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
      executionBoundary: {
        kind: 'managed' as const,
        revision: 0,
        profile: createWorkspaceWritePermissionProfile(),
      },
    };

    await assert.rejects(
      async () => await bash.impl(args as never, context),
      (error: unknown) =>
        error instanceof SandboxCommandError &&
        error.reason === 'sandbox_boundary_required' &&
        (error as SandboxCommandError & { requiredExpansion?: { network?: { enabled?: boolean } } })
          .requiredExpansion?.network?.enabled === true,
    );
    expect(calls).toHaveLength(0);

    await bash.impl(args as never, {
      ...context,
      executionBoundary: {
        ...context.executionBoundary,
        revision: 1,
        profile: applySandboxBoundaryExpansion(context.executionBoundary.profile, {
          network: { enabled: true },
        }),
      },
    });
    expect(calls).toHaveLength(1);
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
  });

  test('fails closed for an authoritative managed boundary without a sandbox manager', async () => {
    const calls: WorkspaceExecInput[] = [];
    const executor = fakeExecutor({
      exec: async (input) => {
        calls.push(input);
        return { exitCode: 0, stdout: 'host', stderr: '', timedOut: false, aborted: false };
      },
    });
    const bash = buildBuiltinTools({ executor }).find((candidate) => candidate.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    await assert.rejects(
      async () => {
        await bash.impl(
          { command: 'echo host' },
          {
            sessionId: 'session-1',
            turnId: 'turn-1',
            toolCallId: 'tool-1',
            cwd: '/workspace',
            permissionMode: 'bypass',
            executionBoundary: {
              kind: 'managed',
              revision: 0,
              profile: createWorkspaceWritePermissionProfile(),
            },
            abortSignal: new AbortController().signal,
            emitOutput: () => {},
          },
        );
      },
      (error: unknown) =>
        error instanceof SandboxCommandError && error.reason === 'requires_bypass',
    );
    expect(calls).toHaveLength(0);
  });

  test('applies the session boundary to the macOS sandbox argv without one-call permission arguments', async () => {
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
      const bash = buildBuiltinTools({
        executor,
        permissionProfile: profile,
        sandboxManager,
        sandboxPlatform: 'darwin',
      }).find((candidate) => candidate.name === 'Bash');
      if (!bash) throw new Error('Bash tool missing');
      assert.equal(
        (bash!.parameters as z.ZodTypeAny).safeParse({
          command: 'echo unsafe',
          sandbox_permissions: { mode: 'use_default' },
        }).success,
        false,
      );
      const args = {
        command: `printf ok > ${JSON.stringify(target)}`,
      };
      const parameters = bash.parameters as z.ZodTypeAny;
      expect(parameters.safeParse(args).success).toBe(true);

      await bash.impl(args, {
        sessionId: 'session-1',
        turnId: 'turn-1',
        toolCallId: 'tool-1',
        cwd: canonicalWorkspace,
        permissionMode: 'execute',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
        executionBoundary: {
          kind: 'managed',
          revision: 1,
          profile: {
            type: 'managed',
            name: 'expanded',
            fileSystem: {
              kind: 'restricted',
              entries: [
                { kind: 'path', access: 'write', path: canonicalWorkspace },
                { kind: 'path', access: 'write', path: target },
              ],
            },
            network: { kind: 'enabled' },
          },
        },
      });

      const argv = execInput?.argv;
      assert.ok(argv);
      assert.equal(argv[0], '/usr/bin/sandbox-exec');
      assert.deepEqual(argv.slice(-3), ['/bin/sh', '-c', args.command]);
      const policy = argv.find((value) => value.includes('(version 1)')) ?? '';
      assert.match(policy, /\(subpath \(param "WRITABLE_ROOT_1"\)\)/);
      assert.match(policy, /\(allow network\*\)/);
      assert.equal(profile.network.kind, 'restricted');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  function windowsSandboxManager(): SandboxManager {
    // The broker never runs in this test: sandboxCommand short-circuits on
    // win32 before consulting the backend. A well-formed backend is included so
    // the manager mirrors the real app's registration.
    return new SandboxManager([
      new WindowsBrokerSandboxBackend({
        clientPath: String.raw`C:\resources\windows-sandbox\maka-windows-sandbox.exe`,
        writeManifest: () => String.raw`C:\Temp\manifest.json`,
        isAvailable: () => true,
      }),
    ]);
  }

  test('fails Windows Bash closed when the profile requires a command sandbox the broker cannot enforce', async () => {
    // The Windows broker sandboxes the filesystem worker, not an arbitrary
    // shell (cmd.exe/pwsh fail DLL init inside the AppContainer). A
    // sandbox-requiring profile must fail closed with a clear error rather than
    // handing the broker an unlaunchable `/bin/sh` manifest.
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-win-bash-closed-')));
    try {
      let called = false;
      const executor = fakeExecutor({
        exec: async () => {
          called = true;
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
        },
      });
      const bash = buildBuiltinTools({
        executor,
        permissionProfile: createWorkspaceWritePermissionProfile(),
        sandboxManager: windowsSandboxManager(),
        sandboxPlatform: 'win32',
      }).find((candidate) => candidate.name === 'Bash');
      if (!bash) throw new Error('Bash tool missing');

      await assert.rejects(
        async () => {
          await bash.impl(
            { command: 'echo hi' },
            {
              sessionId: 'session-1',
              turnId: 'turn-1',
              toolCallId: 'tool-1',
              cwd,
              permissionMode: 'execute',
              abortSignal: new AbortController().signal,
              emitOutput: () => {},
              executionBoundary: {
                kind: 'managed',
                revision: 1,
                profile: createWorkspaceWritePermissionProfile(),
              },
            },
          );
        },
        (error: unknown) =>
          error instanceof SandboxCommandError &&
          error.reason === 'backend_not_available' &&
          /unavailable on platform win32/.test(error.message),
      );
      assert.equal(called, false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('runs Windows Bash unsandboxed via the detected shell when the profile does not require a sandbox', async () => {
    // A permissive profile does not require containment, so Bash must fall back
    // to the raw command executed through the detected Windows shell (no argv
    // override, no `/bin/sh`), exactly as an explicit bypass boundary does.
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-win-bash-open-')));
    try {
      let execInput: WorkspaceExecInput | undefined;
      const executor = fakeExecutor({
        exec: async (input) => {
          execInput = input;
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
        },
      });
      const bash = buildBuiltinTools({
        executor,
        permissionProfile: createDangerFullAccessPermissionProfile(),
        sandboxManager: windowsSandboxManager(),
        sandboxPlatform: 'win32',
      }).find((candidate) => candidate.name === 'Bash');
      if (!bash) throw new Error('Bash tool missing');

      const result = await bash.impl(
        { command: 'echo hi' },
        {
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolCallId: 'tool-1',
          cwd,
          permissionMode: 'execute',
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
          executionBoundary: {
            kind: 'managed',
            revision: 1,
            profile: createDangerFullAccessPermissionProfile(),
          },
        },
      );

      assert.ok(result);
      assert.equal(execInput?.command, 'echo hi');
      assert.equal(execInput?.argv, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
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

  test('Read routes opaque attachment refs through the Session-bound attachment reader', async () => {
    const calls: unknown[] = [];
    const read = buildBuiltinTools({
      attachmentResources: {
        async readAttachmentResource(sessionId, artifactId) {
          calls.push({ sessionId, artifactId });
          return { kind: 'text', text: 'attachment marker' };
        },
      },
    }).find((tool) => tool.name === 'Read');
    if (!read) throw new Error('Read tool missing');
    const context = {
      sessionId: 'session-1',
      runId: 'run-1',
      turnId: 'turn-1',
      cwd: '/workspace',
      toolCallId: 'tool-1',
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
    };

    assert.deepEqual(await read.impl({ ref: 'maka://runtime/attachments/attachment-1' }, context), {
      kind: 'text',
      text: 'attachment marker',
    });
    assert.deepEqual(calls, [{ sessionId: 'session-1', artifactId: 'attachment-1' }]);
  });

  test('Read normalizes a blank ref to "no ref" before validating the file-or-resource union', async () => {
    const read = buildBuiltinTools({
      runtimeResources: {
        readRuntimeResource: async () => ({ kind: 'text', text: 'unused' }),
      },
    }).find((tool) => tool.name === 'Read');
    if (!read) throw new Error('Read tool missing');
    const parameters = read.parameters as {
      validate(value: unknown): PromiseLike<{
        success: boolean;
        value?: unknown;
        error?: unknown;
      }>;
    };

    // A blank ref alongside a path passes, and the ref key is dropped so the
    // canonical input is the pure file variant.
    const normalized = await parameters.validate({
      path: 'config.yaml',
      ref: '',
      offset: 2,
    });
    assert.equal(normalized.success, true);
    if (normalized.success) {
      assert.deepEqual(normalized.value, { path: 'config.yaml', offset: 2 });
      assert.ok(!('ref' in (normalized.value as Record<string, unknown>)));
    }
    assert.equal((await parameters.validate({ path: 'config.yaml', ref: '   ' })).success, true);
    // A lone blank ref still fails: there is no readable target.
    assert.equal((await parameters.validate({ ref: '' })).success, false);
    assert.equal((await parameters.validate({ ref: '   ' })).success, false);
  });

  test('Read ignores provider defaults beside a non-empty runtime ref', async () => {
    const read = buildBuiltinTools({
      runtimeResources: {
        readRuntimeResource: async () => ({ kind: 'text', text: 'unused' }),
      },
    }).find((tool) => tool.name === 'Read');
    if (!read) throw new Error('Read tool missing');
    const parameters = read.parameters as {
      validate(value: unknown): PromiseLike<{
        success: boolean;
        value?: unknown;
      }>;
    };
    const ref = 'maka://runtime/background-tasks/shell-run-1';

    const normalized = await parameters.validate({
      path: '',
      offset: 0,
      limit: 1,
      ref,
    });
    assert.equal(normalized.success, true);
    if (normalized.success) assert.deepEqual(normalized.value, { ref });

    assert.equal(
      (
        await parameters.validate({
          path: 'README.md',
          offset: 0,
          limit: 1,
          ref,
        })
      ).success,
      false,
    );
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

  test('WriteStdin exposes a provider-tolerant terminal action schema', async () => {
    const ptyControls = {
      writeStdin: () => Promise.reject(new Error('not used')),
    } satisfies PtyControlWriter;
    const write = buildBuiltinTools({ ptyControls }).find((tool) => tool.name === 'WriteStdin');
    if (!write) throw new Error('WriteStdin tool missing');
    const parameters = write.parameters as {
      jsonSchema: PromiseLike<{
        properties?: { ref?: { maxLength?: number }; input?: unknown };
      }>;
      validate(value: unknown): PromiseLike<{ success: boolean; value?: unknown }>;
    };
    const maxRef = shellRunResourceRef('x'.repeat(SHELL_RUN_ID_MAX_CHARS));
    const refSchema = await parameters.jsonSchema;

    expect(maxRef.length).toBe(MAX_SHELL_RUN_RESOURCE_REF_CHARS);
    expect(refSchema.properties?.ref?.maxLength).toBe(MAX_SHELL_RUN_RESOURCE_REF_CHARS);
    expect(refSchema.properties?.input).toBeUndefined();
    expect(
      await parameters.validate({
        ref: maxRef,
        actions: [
          {
            type: 'text',
            text: 'hello',
            key: null,
            event: null,
            x: 0,
            y: 0,
            button: null,
            direction: null,
            modifiers: null,
          },
          {
            type: 'key',
            key: 'enter',
            text: null,
            event: null,
            x: 0,
            y: 0,
            button: null,
            direction: null,
            modifiers: null,
          },
          {
            type: 'mouse',
            event: 'click',
            x: 2,
            y: 3,
            button: 'left',
            text: null,
            key: null,
            direction: null,
            modifiers: null,
          },
        ],
        size: { cols: 0, rows: 0 },
      }),
    ).toEqual({
      success: true,
      value: {
        ref: maxRef,
        actions: [
          { type: 'text', text: 'hello' },
          { type: 'key', key: 'enter' },
          { type: 'mouse', event: 'click', x: 2, y: 3, button: 'left' },
        ],
      },
    });
    expect(
      (
        await parameters.validate({
          ref: `${SHELL_RUN_RESOURCE_PREFIX}/shell-run-1`,
          actions: [],
          size: { cols: 240, rows: 100 },
        })
      ).success,
    ).toBe(true);
    expect(
      (
        await parameters.validate({
          ref: `${SHELL_RUN_RESOURCE_PREFIX}/shell-run-1`,
          actions: [{ type: 'key', key: 'b', text: 'not-empty' }],
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await parameters.validate({
          ref: `${SHELL_RUN_RESOURCE_PREFIX}/shell-run-1`,
          actions: [{ type: 'text', text: null, key: null }],
        })
      ).success,
    ).toBe(false);
    for (const ref of [
      'ref',
      `${SHELL_RUN_RESOURCE_PREFIX}/shell/run`,
      `${SHELL_RUN_RESOURCE_PREFIX}/decoy/../shell-run-1`,
      `${SHELL_RUN_RESOURCE_PREFIX}/shell-run-1?view=full`,
      `${maxRef}x`,
    ]) {
      expect(
        (await parameters.validate({ ref, actions: [{ type: 'key', key: 'enter' }] })).success,
      ).toBe(false);
    }
    expect((await parameters.validate({ ref: maxRef })).success).toBe(false);
    expect(
      (
        await parameters.validate({
          ref: maxRef,
          actions: [{ type: 'text', text: '' }],
        })
      ).success,
    ).toBe(false);
    expect((await parameters.validate({ ref: maxRef, size: { cols: 1, rows: 24 } })).success).toBe(
      false,
    );
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

  test('Read accepts contained absolute paths and rejects workspace escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-read-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-read-outside-'));
    await writeFile(join(root, 'inside.txt'), 'inside', 'utf8');
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(root, 'secret-link.txt'));
    const read = tool('Read');

    const absoluteResult = await runTool(read, { path: join(root, 'inside.txt') }, root);
    expect(absoluteResult).toMatchObject({ content: 'inside' });
    await expectRejects(
      runTool(read, { path: join(outside, 'secret.txt') }, root),
      /Read path must stay inside/,
    );
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
      runTool(glob, { pattern: '*.txt', cwd: outside }, root),
      /Glob cwd path must stay inside/,
    );
    await expectRejects(
      runTool(grep, { pattern: 'token', path: outside }, root),
      /Grep path must stay inside/,
    );
    await expectRejects(
      runTool(grep, { pattern: 'secret', path: 'outside-link' }, root),
      /Grep path must stay inside/,
    );

    const globResult = await runTool(glob, { pattern: '**/*.ts' }, root);
    expect(globResult).toMatchObject({ files: ['src/main.ts'] });
    const absoluteGlobResult = await runTool(glob, { pattern: '**/*.ts', cwd: root }, root);
    expect(absoluteGlobResult).toMatchObject({ files: ['src/main.ts'] });
    const grepResult = await runTool(grep, { pattern: 'token', path: 'src' }, root);
    expect(JSON.stringify(grepResult).includes('main.ts')).toBe(true);
    const absoluteGrepResult = await runTool(
      grep,
      { pattern: 'token', path: join(root, 'src') },
      root,
    );
    expect(JSON.stringify(absoluteGrepResult).includes('main.ts')).toBe(true);
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
    expect(result).toMatchObject({ kind: 'file_diff', paths: ['/workspace/created.txt'] });
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

  test('Write accepts contained absolute paths and rejects workspace escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-write-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-write-outside-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await symlink(outside, join(root, 'outside-link'));
    const write = tool('Write');

    const absoluteWritePath = join(root, 'src', 'absolute.txt');
    await runTool(write, { path: absoluteWritePath, content: 'absolute-inside' }, root);
    expect(await readFile(absoluteWritePath, 'utf8')).toBe('absolute-inside');
    await expectRejects(
      runTool(write, { path: join(outside, 'outside.txt'), content: 'x' }, root),
      /Write path must stay inside/,
    );
    await expectRejects(
      runTool(write, { path: '../outside.txt', content: 'x' }, root),
      /Write path must stay inside/,
    );
    await expectRejects(
      runTool(write, { path: 'outside-link/new.txt', content: 'x' }, root),
      /Write path must stay inside/,
    );

    await runTool(write, { path: 'src/new.txt', content: 'inside' }, root);
    expect(await readFile(join(root, 'src', 'new.txt'), 'utf8')).toBe('inside');
  });

  test('Edit accepts contained absolute paths and rejects workspace escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-edit-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-edit-outside-'));
    await writeFile(join(root, 'inside.txt'), 'hello world', 'utf8');
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(root, 'secret-link.txt'));
    const edit = tool('Edit');

    await expectRejects(
      runTool(
        edit,
        { path: join(outside, 'secret.txt'), old_string: 'secret', new_string: 'edited' },
        root,
      ),
      /Edit path must stay inside/,
    );
    await expectRejects(
      runTool(edit, { path: '../outside.txt', old_string: 'x', new_string: 'y' }, root),
      /Edit path must stay inside/,
    );
    await expectRejects(
      runTool(edit, { path: 'secret-link.txt', old_string: 'secret', new_string: 'edited' }, root),
      /Edit path must stay inside/,
    );

    await runTool(
      edit,
      { path: join(root, 'inside.txt'), old_string: 'world', new_string: 'Maka' },
      root,
    );
    expect(await readFile(join(root, 'inside.txt'), 'utf8')).toBe('hello Maka');
  });

  test('file tools stay usable when the session cwd is reached through a symlink', async () => {
    // The session cwd itself sits under a symlink (macOS hands out `/var/...`
    // tmpdirs whose realpath is `/private/var/...`, and workspace roots are often
    // organised with symlinks). Containment must be decided in one path space, so
    // absolute paths spelled through the link are inside — and escapes still are not.
    const base = await realpath(await mkdtemp(join(tmpdir(), 'maka-symlink-cwd-')));
    const workspace = join(base, 'workspace');
    const outside = join(base, 'outside');
    await mkdir(join(workspace, 'src'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(workspace, 'src', 'inside.txt'), 'inside token\n', 'utf8');
    await writeFile(join(outside, 'secret.txt'), 'secret\n', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(workspace, 'escape.txt'));
    await symlink(outside, join(workspace, 'outside-link'));
    const cwd = join(base, 'link-to-workspace');
    await symlink(workspace, cwd);

    const read = tool('Read');
    const write = tool('Write');
    const edit = tool('Edit');
    const glob = tool('Glob');
    const grep = tool('Grep');

    expect(await runTool(read, { path: join(cwd, 'src', 'inside.txt') }, cwd)).toMatchObject({
      content: 'inside token\n',
    });
    await runTool(write, { path: join(cwd, 'src', 'written.txt'), content: 'written\n' }, cwd);
    expect(await readFile(join(workspace, 'src', 'written.txt'), 'utf8')).toBe('written\n');
    await runTool(
      edit,
      { path: join(cwd, 'src', 'inside.txt'), old_string: 'token', new_string: 'edited' },
      cwd,
    );
    expect(await readFile(join(workspace, 'src', 'inside.txt'), 'utf8')).toBe('inside edited\n');
    expect(await runTool(glob, { pattern: '*.txt', cwd: join(cwd, 'src') }, cwd)).toMatchObject({
      files: ['inside.txt', 'written.txt'],
    });
    const grepResult = await runTool(grep, { pattern: 'edited', path: join(cwd, 'src') }, cwd);
    expect(JSON.stringify(grepResult).includes('inside.txt')).toBe(true);

    // Resolving into the canonical space must not turn "follow a symlink out of
    // the workspace" into a legal path.
    await expectRejects(
      runTool(read, { path: join(outside, 'secret.txt') }, cwd),
      /Read path must stay inside/,
    );
    await expectRejects(
      runTool(read, { path: join(cwd, 'escape.txt') }, cwd),
      /Read path must stay inside/,
    );
    await expectRejects(
      runTool(write, { path: join(cwd, 'escape.txt'), content: 'x' }, cwd),
      /Write path must stay inside/,
    );
    await expectRejects(
      runTool(write, { path: join(cwd, 'outside-link', 'new.txt'), content: 'x' }, cwd),
      /Write path must stay inside/,
    );
    // A link whose target does not exist yet cannot be realpath'd, but a write
    // through it still lands outside the workspace, so it must be followed by
    // hand rather than treated as a plain missing leaf.
    await symlink(join(outside, 'not-yet.txt'), join(workspace, 'dangling-escape.txt'));
    await expectRejects(
      runTool(write, { path: join(cwd, 'dangling-escape.txt'), content: 'x' }, cwd),
      /Write path must stay inside/,
    );
    await expectRejects(access(join(outside, 'not-yet.txt')), /ENOENT|no such file/);
    await expectRejects(
      runTool(grep, { pattern: 'secret', path: join(cwd, 'outside-link') }, cwd),
      /Grep path must stay inside/,
    );
    await expectRejects(
      runTool(glob, { pattern: '*.txt', cwd: join(cwd, 'outside-link') }, cwd),
      /Glob cwd path must stay inside/,
    );
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
    expect(results.every((r) => (r as { kind: string }).kind === 'file_diff')).toBe(true);
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
    expect(results.every((r) => (r as { kind: string }).kind === 'file_diff')).toBe(true);
    const expected = `${Array.from({ length: n }, (_, i) => `done-${String(i).padStart(2, '0')}`).join('\n')}\n`;
    expect(await readFile(join(root, 'data.txt'), 'utf8')).toBe(expected);
  });

  test('concurrent Edits through a symlinked cwd serialize on one key', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'maka-edit-symlink-')));
    const workspace = join(base, 'workspace');
    await mkdir(workspace, { recursive: true });
    const cwd = join(base, 'link-to-workspace');
    await symlink(workspace, cwd);
    const n = 20;
    const markers = Array.from({ length: n }, (_, i) => `marker-${String(i).padStart(2, '0')}`);
    await writeFile(join(workspace, 'data.txt'), `${markers.join('\n')}\n`, 'utf8');
    const edit = tool('Edit');
    // The relative spelling resolves against the canonical cwd while the absolute
    // one is spelled through the link. Unless the lock key canonicalises both, the
    // two groups take different locks and clobber each other.
    const results = await Promise.all(
      markers.map((m, i) =>
        runTool(
          edit,
          {
            path: i % 2 === 0 ? 'data.txt' : join(cwd, 'data.txt'),
            old_string: m,
            new_string: `done-${String(i).padStart(2, '0')}`,
          },
          cwd,
        ),
      ),
    );
    expect(results.every((r) => (r as { kind: string }).kind === 'file_diff')).toBe(true);
    const expected = `${Array.from({ length: n }, (_, i) => `done-${String(i).padStart(2, '0')}`).join('\n')}\n`;
    expect(await readFile(join(workspace, 'data.txt'), 'utf8')).toBe(expected);
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

  test('sort_keys: true preserves __proto__ as a data property', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-formatjson-'));
    const name = await writeInput(root, 'data.json', '{"__proto__":{"polluted":true},"a":1}');

    await runFormatJson({ path: name, sort_keys: true }, root);

    const parsed = JSON.parse(await readFile(join(root, name), 'utf8')) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect(parsed['__proto__']).toEqual({ polluted: true });
    expect(parsed.a).toBe(1);
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
    required_boundary: {
      filesystem: {
        entries: [{ path: target, access: 'write' as const, scope: 'exact' as const }],
      },
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
    executionBoundary: {
      kind: 'managed' as const,
      revision: 1,
      profile: applySandboxBoundaryExpansion(createWorkspaceWritePermissionProfile(), {
        filesystem: {
          entries: [{ path: target, access: 'write' as const, scope: 'exact' as const }],
        },
      }),
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
  abortSignal = new AbortController().signal,
): Promise<unknown> {
  return Promise.resolve(
    tool.impl(args as never, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      cwd,
      toolCallId: 'tool-1',
      abortSignal,
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
