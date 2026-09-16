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
import { formatTextWithInlineRefs } from '../model-history.js';
import { readParameters } from '../read-page.js';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { SHELL_RUN_ID_MAX_CHARS } from '@maka/core/shell-run';
import { buildBuiltinTools } from '../builtin-tools.js';
import { encodeDefaultDurableToolResultOutput } from '../durable-tool-result-projection.js';

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
  type WorkspaceExecutor,
  type WorkspaceExecutorFacts,
} from '../workspace-executor.js';
import { waitFor as pollFor } from '@maka/core/test-only/async-primitives';
import { BASH_MAX_RETAINED_CHARS } from '../shell-exec.js';

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

    assert.strictEqual(tools.length > 0, true);
    assert.strictEqual(
      tools.every((tool) => tool.executionFacts === facts),
      true,
    );
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
    assert.strictEqual(
      result.output.stdout.startsWith(
        '-NoLogo -NoProfile -NonInteractive -Command $__makaUtf8 = [System.Text.UTF8Encoding]::new($false)\n',
      ),
      true,
    );
  });
});

describe('builtin Bash streaming output', () => {
  test('Bash supports background and PTY execution without sandbox arguments', () => {
    const bash = buildBuiltinTools({
      shellRuns: {
        runForegroundBash: () => Promise.reject(new Error('not used')),
        runBackgroundBash: () => Promise.reject(new Error('not used')),
      },
    }).find((tool) => tool.name === 'Bash')!;
    const parameters = bash.parameters as z.ZodTypeAny;
    assert.equal(parameters.safeParse({ command: 'sleep 60' }).success, true);
    assert.equal(
      parameters.safeParse({ command: 'sleep 60', run_in_background: true, pty: true }).success,
      true,
    );
    assert.equal(parameters.safeParse({ command: 'sleep 60', pty: true }).success, false);
    assert.equal(
      parameters.safeParse({ command: 'sleep 60', boundary_intent: 'expand' }).success,
      false,
    );
    assert.equal(parameters.safeParse({ command: 'sleep 60', timeout_ms: 600_001 }).success, false);
    assert.equal(
      parameters.safeParse({ command: 'sleep 60', run_in_background: true, timeout_ms: 600_001 })
        .success,
      true,
    );
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

    assert.strictEqual((result as { kind: string }).kind, 'terminal');
    assert.deepStrictEqual(calls, ['foreground']);
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

    assert.strictEqual(names.filter((name) => name === 'Bash').length, 1);
    assert.strictEqual(names.includes('StopBackgroundTask'), false);
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

    assert.strictEqual((result as { kind: string }).kind, 'shell_run');
    assert.strictEqual(
      (result as { ref?: string }).ref,
      'maka://runtime/background-tasks/shell-run-1',
    );
    assert.strictEqual((calls[0] as { timeoutMs?: number }).timeoutMs, 2_000);
    assert.strictEqual((calls[0] as { sourceRunId?: string }).sourceRunId, 'run-1');
    assert.strictEqual((calls[0] as { pty?: boolean }).pty, true);
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
    const context = {
      sessionId: 'session-1',
      runId: 'run-1',
      turnId: 'turn-1',
      cwd: '/workspace',
      toolCallId: 'tool-1',
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
    };
    const result = (await read.impl(
      { path: 'maka://runtime/background-tasks/shell-run-1' },
      context,
    )) as { kind: string; status: string };
    assert.equal(result.kind, 'shell_run');
    assert.equal(result.status, 'running');
    const projected = read.toModelOutput!({
      toolCallId: 'tool-1',
      input: { path: 'maka://runtime/background-tasks/shell-run-1' },
      output: result,
    });
    assert.equal(projected?.type, 'json');
    if (projected?.type === 'json')
      assert.equal((projected.value as { content: string }).content, 'background task detail');
    assert.deepStrictEqual(calls, [
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

    const prompt = formatTextWithInlineRefs('read this', {
      attachments: [
        {
          kind: 'doc',
          name: 'notes.txt',
          mimeType: 'text/plain',
          bytes: 17,
          ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'attachment-1' },
        },
      ],
    });
    const args = readParameters.parse(JSON.parse(prompt.match(/Read argument: (.*)/)![1]!));
    const result = await read.impl(args, context);
    assert.deepEqual(result, { kind: 'text', text: 'attachment marker' });
    const projection = read.toModelOutput!({ toolCallId: 'tool-1', input: args, output: result });
    assert.deepEqual(projection, {
      type: 'json',
      value: {
        content: 'attachment marker',
        offset: 0,
        returnedLines: 1,
        totalLines: 1,
        next: null,
      },
    });
    assert.deepEqual(calls, [{ sessionId: 'session-1', artifactId: 'attachment-1' }]);
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

    assert.partialDeepStrictEqual(result, { kind: 'shell_run', status: 'cancelled' });
    assert.deepStrictEqual((result as Record<string, unknown>).operation, {
      kind: 'stop',
      applied: true,
    });
    assert.deepStrictEqual(calls, [
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

    assert.strictEqual(maxRef.length, MAX_SHELL_RUN_RESOURCE_REF_CHARS);
    assert.strictEqual(refSchema.properties?.ref?.maxLength, MAX_SHELL_RUN_RESOURCE_REF_CHARS);
    assert.strictEqual(refSchema.properties?.input, undefined);
    assert.deepStrictEqual(
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
      {
        success: true,
        value: {
          ref: maxRef,
          actions: [
            { type: 'text', text: 'hello' },
            { type: 'key', key: 'enter' },
            { type: 'mouse', event: 'click', x: 2, y: 3, button: 'left' },
          ],
        },
      },
    );
    assert.strictEqual(
      (
        await parameters.validate({
          ref: `${SHELL_RUN_RESOURCE_PREFIX}/shell-run-1`,
          actions: [],
          size: { cols: 240, rows: 100 },
        })
      ).success,
      true,
    );
    assert.strictEqual(
      (
        await parameters.validate({
          ref: `${SHELL_RUN_RESOURCE_PREFIX}/shell-run-1`,
          actions: [{ type: 'key', key: 'b', text: 'not-empty' }],
        })
      ).success,
      false,
    );
    assert.strictEqual(
      (
        await parameters.validate({
          ref: `${SHELL_RUN_RESOURCE_PREFIX}/shell-run-1`,
          actions: [{ type: 'text', text: null, key: null }],
        })
      ).success,
      false,
    );
    for (const ref of [
      'ref',
      `${SHELL_RUN_RESOURCE_PREFIX}/shell/run`,
      `${SHELL_RUN_RESOURCE_PREFIX}/decoy/../shell-run-1`,
      `${SHELL_RUN_RESOURCE_PREFIX}/shell-run-1?view=full`,
      `${maxRef}x`,
    ]) {
      assert.strictEqual(
        (await parameters.validate({ ref, actions: [{ type: 'key', key: 'enter' }] })).success,
        false,
      );
    }
    assert.strictEqual((await parameters.validate({ ref: maxRef })).success, false);
    assert.strictEqual(
      (
        await parameters.validate({
          ref: maxRef,
          actions: [{ type: 'text', text: '' }],
        })
      ).success,
      false,
    );
    assert.strictEqual(
      (await parameters.validate({ ref: maxRef, size: { cols: 1, rows: 24 } })).success,
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

    assert.strictEqual(err?.code, 4);
    assert.strictEqual(err?.stdout, 'out-data');
    assert.strictEqual(err?.stderr, 'err-data');
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

    assert.strictEqual(
      events.some((event) => event.stream === 'stdout' && event.chunk.includes('out')),
      true,
    );
    assert.strictEqual(
      events.some((event) => event.stream === 'stderr' && event.chunk.includes('err')),
      true,
    );
    assert.partialDeepStrictEqual(result, {
      kind: 'terminal',
      cwd,
      cmd: 'printf "out"; printf "err" >&2',
      exitCode: 0,
    });
    assert.deepStrictEqual((result as Record<string, unknown>).output, {
      mode: 'pipes',
      stdout: 'out',
      stderr: 'err',
      stdoutTruncated: false,
      stderrTruncated: false,
      redacted: false,
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
    assert.strictEqual(
      events.some((event) => event.stream === 'stdout' && event.chunk.includes('started')),
      true,
    );
  });

  test('large output is bounded to a tail instead of being discarded', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-bash-'));
    const bash = buildBuiltinTools().find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    const result = (await bash.impl(
      {
        command: 'perl -e \'print "HEAD\\n", "x" x 2000000, "\\nTAIL\\n"\'',
        timeout_ms: 10_000,
      },
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        cwd,
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      },
    )) as { exitCode: number; output: { stdout: string; stdoutTruncated: boolean } };

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.output.stdout.endsWith('\nTAIL\n'), true);
    assert.strictEqual(result.output.stdout.includes('HEAD\n'), false);
    assert.ok(result.output.stdout.length <= BASH_MAX_RETAINED_CHARS);
    assert.strictEqual(result.output.stdoutTruncated, true);
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

    assert.strictEqual(err?.code, 3);
    assert.strictEqual(err?.stdout, 'out-data');
    assert.strictEqual(err?.stderr, 'err-data');
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

    assert.strictEqual(err?.code, 124);
    assert.strictEqual(err?.stdout, 'out-before');
    assert.strictEqual(err?.stderr, 'err-before');
  });
});

describe('builtin Bash sandbox denial classification', () => {});

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

  test('Grep carries exact omitted-line counts through the executor and model projection', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-grep-completeness-'));
    try {
      await writeFile(join(cwd, 'matches.txt'), 'token token\n'.repeat(51));
      const grep = tool('Grep');
      const input = (grep.parameters as z.ZodTypeAny).parse({
        pattern: 'token',
        path: '',
        glob: '',
      });
      const result = await runTool(grep, input, cwd);
      assert.partialDeepStrictEqual(result, {
        matchedLines: 51,
        returnedLines: 50,
        omittedLines: 1,
        truncated: true,
      });
      assert.partialDeepStrictEqual(encodeDefaultDurableToolResultOutput(result, 'session-1'), {
        kind: 'json',
        value: result,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
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

    assert.deepStrictEqual(writes, [
      {
        cwd: '/workspace',
        path: '/workspace/created.txt',
        content: 'from-executor',
      },
    ]);
    assert.partialDeepStrictEqual(result, { kind: 'file_diff' });
    assert.deepStrictEqual((result as { paths: string[] }).paths, ['/workspace/created.txt']);
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

  test('Edit returns a file diff for a localized change in a large file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-edit-large-diff-'));
    const content = Array.from({ length: 900 }, (_, index) => `const v${index} = ${index};`).join(
      '\n',
    );
    await writeFile(join(root, 'large.ts'), `${content}\n`, 'utf8');

    const result = await runTool(
      tool('Edit'),
      { path: 'large.ts', old_string: 'const v500 = 500;', new_string: 'const v500 = -1;' },
      root,
    );

    assert.partialDeepStrictEqual(result, { kind: 'file_diff' });
    assert.match((result as { diff: string }).diff, /-const v500 = 500;/);
    assert.match((result as { diff: string }).diff, /\+const v500 = -1;/);
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
    assert.strictEqual(
      results.every((r) => (r as { kind: string }).kind === 'file_diff'),
      true,
    );
    const expected = `${Array.from({ length: n }, (_, i) => `done-${String(i).padStart(2, '0')}`).join('\n')}\n`;
    assert.strictEqual(await readFile(join(root, 'data.txt'), 'utf8'), expected);
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
    assert.strictEqual(
      results.every((r) => (r as { kind: string }).kind === 'file_diff'),
      true,
    );
    const expected = `${Array.from({ length: n }, (_, i) => `done-${String(i).padStart(2, '0')}`).join('\n')}\n`;
    assert.strictEqual(await readFile(join(root, 'data.txt'), 'utf8'), expected);
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
    assert.strictEqual(
      results.every((r) => (r as { kind: string }).kind === 'file_diff'),
      true,
    );
    const expected = `${Array.from({ length: n }, (_, i) => `done-${String(i).padStart(2, '0')}`).join('\n')}\n`;
    assert.strictEqual(await readFile(join(workspace, 'data.txt'), 'utf8'), expected);
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
    assert.strictEqual(await readFile(join(root, 'fresh.txt'), 'utf8'), 'hello Maka\n');
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
    assert.strictEqual(await readFile(join(root, 'data.txt'), 'utf8'), 'hello Maka\n');
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
    assert.strictEqual(Object.prototype.hasOwnProperty.call(parsed, '__proto__'), true);
    assert.deepStrictEqual(parsed['__proto__'], { polluted: true });
    assert.strictEqual(parsed.a, 1);
  });

  test('invalid JSON returns a structured error diagnostic (no write, byteDelta 0)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-formatjson-'));
    const name = await writeInput(root, 'data.json', 'not json');

    const result = await runFormatJson({ path: name }, root);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.valid, false);
    assert.match(String(result.error), /FormatJson: invalid JSON/);
    assert.strictEqual(result.byteDelta, 0);
    assert.strictEqual(result.changed, false);
    // File is left untouched on invalid input.
    assert.strictEqual(await readFile(join(root, name), 'utf8'), 'not json');
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  await pollFor(predicate, {
    timeoutMs: 1_000,
    pollMs: 10,
    message: 'timed out waiting for predicate',
  });
}

async function expectRejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert.match(String(error instanceof Error ? error.message : String(error)), pattern);
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
    grepFiles: async () => ({
      matches: [],
      matchedLines: 0,
      returnedLines: 0,
      omittedLines: 0,
      truncated: false,
    }),
  };
  return Object.assign(base, overrides);
}
