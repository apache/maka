import assert from 'node:assert/strict';
import { exec as childExec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  AGENT_SWARM_TOOL_NAME,
  buildChildAgentTools,
  LOAD_TOOLS_NAME,
  ToolAvailabilityRuntime,
} from '@maka/runtime';
import { createHeavyTaskEvidenceRecorder } from '../heavy-task-evidence.js';
import {
  createInMemoryTaskLedgerExperimentStore,
  TASK_LEDGER_EXPERIMENT_TODO_TOOL_NAMES,
} from '../task-ledger-experiment.js';
import { createInMemoryTaskRunStore } from '../task-run-store.js';
import {
  buildIsolatedBashTool,
  buildIsolatedHeadlessToolAvailability,
  buildIsolatedHeadlessTools,
} from '../tools.js';
import type { IsolatedToolExecutor } from '../isolation.js';

const execAsync = promisify(childExec);

describe('isolated headless tools', () => {
  test('Bash delegates execution to the isolated executor', async () => {
    const calls: unknown[] = [];
    const emitted: Array<{ stream: string; chunk: string }> = [];
    const bash = buildIsolatedBashTool({
      async exec(input) {
        calls.push(input);
        return { exitCode: 7, stdout: 'out\n', stderr: 'err\n' };
      },
    });

    const result = await bash.impl(
      { command: 'npm test', timeout_ms: 12_000 },
      {
        sessionId: 's',
        turnId: 't',
        cwd: '/workspace',
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: (stream, chunk) => emitted.push({ stream, chunk }),
      },
    );

    assert.deepEqual(calls, [
      { command: 'npm test', cwd: '/workspace', timeoutMs: 12_000, boundedTail: true },
    ]);
    assert.deepEqual(emitted, [
      { stream: 'stdout', chunk: 'out\n' },
      { stream: 'stderr', chunk: 'err\n' },
    ]);
    assert.deepEqual(result, {
      kind: 'terminal',
      cwd: '/workspace',
      cmd: 'npm test',
      status: 'failed',
      exitCode: 7,
      output: {
        mode: 'pipes',
        stdout: 'out\n',
        stderr: 'err\n',
        stdoutTruncated: false,
        stderrTruncated: false,
        redacted: false,
      },
    });
  });

  test('Bash declares the executor shell dialect to the model, and stays silent on POSIX', () => {
    // Selection without declaration is the original Windows bug (shell-detect.ts):
    // createHarborCellLocalToolExecutor runs PowerShell on Windows, so the
    // isolated Bash description must tell the model that dialect.
    const pwshBash = buildIsolatedBashTool({
      shell: { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: 'C:/pwsh.exe' },
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    assert.match(pwshBash.description, /PowerShell 7 \(pwsh\)/);
    assert.match(pwshBash.description, /write PowerShell syntax, not cmd or bash syntax/);

    // No shell (POSIX / remote container): the historical description is the
    // contract; no dialect sentence is added.
    const posixBash = buildIsolatedBashTool({
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    assert.doesNotMatch(posixBash.description, /PowerShell|cmd syntax/);
  });

  test('Bash leaves the default timeout to the isolated executor', async () => {
    const calls: unknown[] = [];
    const bash = buildIsolatedBashTool({
      async exec(input) {
        calls.push(input);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    await bash.impl({ command: 'long build' }, toolCtx('/workspace'));

    assert.deepEqual(calls, [{ command: 'long build', cwd: '/workspace', boundedTail: true }]);
  });

  test('Bash surfaces the executor result to history and bounds it for the model', async () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    const emitted: Array<{ stream: string; chunk: string }> = [];
    const bash = buildIsolatedBashTool({
      async exec() {
        return { exitCode: 0, stdout: big, stderr: '' };
      },
    });

    const result = (await bash.impl(
      { command: 'noisy' },
      {
        sessionId: 's',
        turnId: 't',
        cwd: '/workspace',
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: (stream, chunk) => emitted.push({ stream, chunk }),
      },
    )) as { output: { stdout: string } };

    // emitOutput surfaces whatever the executor RETURNS to history (there is no
    // live per-chunk channel across the executor boundary — see the Harbor tests
    // for the real bounded path). The model-facing result is bounded further.
    assert.equal(emitted.find((event) => event.stream === 'stdout')?.chunk, big);
    assert.ok(result.output.stdout.includes('line5000'));
    assert.ok(result.output.stdout.includes('truncated'));
    assert.ok(!result.output.stdout.includes('line1\n'));
    assert.ok(result.output.stdout.length < big.length);
  });

  test('Bash preserves retained-tail truncation flags from the isolated executor', async () => {
    const bash = buildIsolatedBashTool({
      async exec() {
        return {
          exitCode: 0,
          stdout: 'tail',
          stderr: '',
          stdoutTruncated: true,
          stderrTruncated: false,
        };
      },
    });

    const result = (await bash.impl({ command: 'noisy' }, toolCtx('/workspace'))) as {
      output: { stdoutTruncated: boolean; stderrTruncated: boolean };
    };

    assert.equal(result.output.stdoutTruncated, true);
    assert.equal(result.output.stderrTruncated, false);
  });

  test('Bash delegates cleanup commands to the isolated executor', async () => {
    const calls: unknown[] = [];
    const emitted: Array<{ stream: string; chunk: string }> = [];
    const bash = buildIsolatedBashTool({
      async exec(input) {
        calls.push(input);
        return { exitCode: 0, stdout: 'cleaned\n', stderr: '' };
      },
    });

    const result = (await bash.impl(
      { command: 'rm -f *.gcda *.gcno *.gcov' },
      {
        sessionId: 's',
        turnId: 't',
        cwd: '/workspace',
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: (stream, chunk) => emitted.push({ stream, chunk }),
      },
    )) as { exitCode: number; output: { stdout: string; stderr: string } };

    assert.deepEqual(calls, [
      {
        command: 'rm -f *.gcda *.gcno *.gcov',
        cwd: '/workspace',
        timeoutMs: 120_000,
        boundedTail: true,
      },
    ]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.output.stdout, 'cleaned\n');
    assert.equal(result.output.stderr, '');
    assert.deepEqual(emitted, [{ stream: 'stdout', chunk: 'cleaned\n' }]);
  });

  test('only Bash opts into bounded-tail; Read/Glob/Grep request full output', async () => {
    // Records the boundedTail flag of every exec() and returns empty output, so
    // the command-backed Read/Glob/Grep complete without running anything.
    const seen: Array<{ boundedTail: unknown }> = [];
    const tools = buildIsolatedHeadlessTools({
      async exec(input) {
        seen.push({ boundedTail: (input as { boundedTail?: boolean }).boundedTail });
        return { exitCode: 0, stdout: fileToolOutputForCommand(input.command), stderr: '' };
      },
    });

    await tool(tools, 'Bash').impl({ command: 'echo hi' }, toolCtx('/workspace'));
    await tool(tools, 'Read').impl({ path: 'src/f.txt' }, toolCtx('/workspace'));
    await tool(tools, 'Glob').impl({ pattern: '**/*.txt' }, toolCtx('/workspace'));
    await tool(tools, 'Grep').impl({ pattern: 'hello' }, toolCtx('/workspace'));

    assert.equal(seen[0].boundedTail, true, 'Bash opts into bounded tail');
    assert.ok(
      seen.slice(1).every((call) => !call.boundedTail),
      'Read/Glob/Grep must request full output, not a bounded tail',
    );
  });

  test('command-backed file tools forward active-turn cancellation to the isolated executor', async () => {
    const seenSignals: Array<AbortSignal | undefined> = [];
    const tools = buildIsolatedHeadlessTools({
      async exec(input, control) {
        seenSignals.push(control?.abortSignal);
        return { exitCode: 0, stdout: fileToolOutputForCommand(input.command), stderr: '' };
      },
    });
    const ctx = toolCtx('/workspace');

    await tool(tools, 'Read').impl({ path: 'src/f.txt' }, ctx);
    await tool(tools, 'Glob').impl({ pattern: '**/*.txt' }, ctx);
    await tool(tools, 'Grep').impl({ pattern: 'hello' }, ctx);

    assert.deepEqual(seenSignals, [ctx.abortSignal, ctx.abortSignal, ctx.abortSignal]);
  });

  test('standard isolated tool surface excludes parent-facing agent tools by default', () => {
    const tools = buildIsolatedHeadlessTools({
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const names = tools.map((tool) => tool.name);
    assert.equal(names[0], 'Bash');
    assert.ok(names.includes('Read'));
    assert.ok(names.includes('Write'));
    assert.ok(!names.includes('agent_spawn'));
    assert.ok(!names.includes(AGENT_SWARM_TOOL_NAME));
    assert.ok(!names.includes('agent_list'));
    assert.ok(!names.includes('agent_output'));
    assert.ok(!names.includes('inventory_submit'));
    assert.ok(!names.includes('todo_update'));
    assert.ok(!names.includes('self_check_plan_submit'));
    assert.ok(!names.includes('self_check_submit'));
    assert.ok(!names.some((name) => name.startsWith('task_')));
    assert.equal(names.filter((name) => name === 'Bash').length, 1);
    assert.deepEqual(
      buildChildAgentTools(tools).map((tool) => tool.name),
      ['Read', 'Glob', 'Grep'],
    );
    assert.ok(
      !buildChildAgentTools(tools).some((tool) => ['Bash', 'Write', 'Edit'].includes(tool.name)),
    );
  });

  test('task experiment tools are included only when a task ledger store is enabled', () => {
    const tools = buildIsolatedHeadlessTools(
      {
        async exec() {
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
      {
        taskLedgerExperiment: {
          store: createInMemoryTaskLedgerExperimentStore({ now: () => 1, newId: () => 'task-1' }),
        },
      },
    );

    const names = tools.map((tool) => tool.name);
    for (const taskToolName of TASK_LEDGER_EXPERIMENT_TODO_TOOL_NAMES) {
      assert.ok(names.includes(taskToolName));
    }
    assert.ok(!names.some((name) => name.startsWith('task_')));
  });

  test('progress and self-check tools are included only when heavy-task recorders are enabled', () => {
    const tools = buildIsolatedHeadlessTools(
      {
        async exec() {
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
      {
        heavyTaskProgress: {
          async recordInventory(input) {
            return {
              schemaVersion: 1,
              inventoryId: 'inventory-1',
              taskRunId: 'run-1',
              ts: 1,
              summary: input.summary,
              items: input.items,
              source: { kind: 'model_tool', toolCallId: 'tool-1' },
            };
          },
          async recordTodos(input) {
            return {
              schemaVersion: 1,
              todoSetId: 'todos-1',
              taskRunId: 'run-1',
              ts: 1,
              items: input.items,
              source: { kind: 'model_tool', toolCallId: 'tool-1' },
            };
          },
        },
        heavyTaskSelfCheck: {
          async recordSelfCheckPlan(input) {
            return {
              accepted: true,
              plan: {
                schemaVersion: 1,
                planId: 'plan-1',
                taskRunId: 'run-1',
                ts: 1,
                finalArtifacts: input.finalArtifacts,
                selfCheckScratch: input.selfCheckScratch,
                workspaceGuardPlan: input.workspaceGuardPlan,
                publicReason: input.publicReason,
                guard: {
                  status: 'accepted',
                  checkedAt: 1,
                  categories: [],
                  publicReason: 'Accepted as public, task-derived advisory self-check plan.',
                },
                source: { kind: 'model_tool', toolCallId: 'tool-1' },
              },
            };
          },
          async recordSelfCheck(input) {
            return {
              accepted: true,
              selfCheck: {
                schemaVersion: 1,
                selfCheckId: 'self-check-1',
                taskRunId: 'run-1',
                ts: 1,
                status: input.status,
                publicReason: input.publicReason,
                commandEvidence: input.commandEvidence ?? [],
                artifactEvidence: input.artifactEvidence ?? [],
                guard: {
                  status: 'accepted',
                  checkedAt: 1,
                  categories: [],
                  publicReason: 'Accepted as public, task-derived advisory self-check evidence.',
                },
                source: { kind: 'model_tool', toolCallId: 'tool-1' },
              },
            };
          },
        },
      },
    );

    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes('inventory_submit'));
    assert.ok(names.includes('todo_update'));
    assert.ok(names.includes('self_check_plan_submit'));
    assert.ok(names.includes('self_check_submit'));
    assert.ok(!names.includes('engineering_record'));
    assert.ok(!names.includes('check_record'));
  });

  test('Write, Glob, and Grep delegate to native isolated executor methods', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-tools-host-'));
    await writeFile(join(cwd, 'target.txt'), 'host\n', 'utf8');
    const calls: Array<{ name: string; input: unknown }> = [];
    const nativeSignals: Array<AbortSignal | undefined> = [];
    const tools = buildIsolatedHeadlessTools({
      async exec() {
        throw new Error('file tools must use native isolated methods when available');
      },
      async writeFile(input, control) {
        nativeSignals.push(control?.abortSignal);
        calls.push({ name: 'Write', input });
        return { ok: true, path: input.path, bytes: Buffer.byteLength(input.content, 'utf8') };
      },
      async globFiles(input, control) {
        nativeSignals.push(control?.abortSignal);
        calls.push({ name: 'Glob', input });
        return { files: ['container.txt'] };
      },
      async grepFiles(input, control) {
        nativeSignals.push(control?.abortSignal);
        calls.push({ name: 'Grep', input });
        return { matches: ['container.txt:1:needle'] };
      },
    });

    assert.deepEqual(
      await tool(tools, 'Write').impl(
        { path: join(cwd, 'target.txt'), content: 'external\n' },
        toolCtx(cwd),
      ),
      {
        ok: true,
        path: 'target.txt',
        bytes: 9,
      },
    );
    assert.deepEqual(
      await tool(tools, 'Glob').impl(
        { pattern: `${cwd}/*.txt`, cwd: join(cwd, 'src') },
        toolCtx(cwd),
      ),
      {
        files: ['container.txt'],
      },
    );
    assert.deepEqual(
      await tool(tools, 'Grep').impl(
        {
          pattern: 'needle',
          path: join(cwd, 'src'),
          glob: `${cwd}/*.txt`,
        },
        toolCtx(cwd),
      ),
      {
        matches: ['container.txt:1:needle'],
      },
    );

    assert.equal(await readFile(join(cwd, 'target.txt'), 'utf8'), 'host\n');
    assert.deepEqual(calls, [
      { name: 'Write', input: { cwd, path: 'target.txt', content: 'external\n' } },
      { name: 'Glob', input: { cwd, pattern: '*.txt', searchCwd: 'src' } },
      { name: 'Grep', input: { cwd, pattern: 'needle', path: 'src', glob: '*.txt' } },
    ]);
    assert.equal(nativeSignals.length, 3);
    assert.ok(nativeSignals.every((signal) => signal instanceof AbortSignal));
  });

  test('Read ignores any native readFile hook and always formats via READ_SCRIPT', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-read-nofastpath-'));
    await writeFile(join(cwd, 'f.txt'), 'alpha\nbeta\n', 'utf8');
    // An executor that DOES expose a native readFile returning raw, unformatted
    // bytes. Read must ignore it and run READ_SCRIPT, so the result is line-numbered
    // — a regression guard against re-introducing a Read native fast path.
    const executor: IsolatedToolExecutor = {
      async exec(input) {
        try {
          const { stdout, stderr } = await execAsync(input.command, {
            cwd: input.cwd,
            env: process.env,
            maxBuffer: 4 * 1024 * 1024,
          });
          return { exitCode: 0, stdout, stderr };
        } catch (error: any) {
          return {
            exitCode: typeof error?.code === 'number' ? error.code : 1,
            stdout: typeof error?.stdout === 'string' ? error.stdout : '',
            stderr: typeof error?.stderr === 'string' ? error.stderr : String(error),
          };
        }
      },
    };
    (executor as { readFile?: () => Promise<{ content: string }> }).readFile = async () => ({
      content: 'RAW-NATIVE-BYPASS\n',
    });
    const tools = buildIsolatedHeadlessTools(executor);

    const r = (await tool(tools, 'Read').impl({ path: join(cwd, 'f.txt') }, toolCtx(cwd))) as {
      content: string;
    };
    assert.equal(
      r.content,
      '     1\talpha\n     2\tbeta\n',
      'formatted via READ_SCRIPT, not the raw native readFile',
    );
    assert.ok(!r.content.includes('RAW-NATIVE-BYPASS'), 'the native readFile result is never used');
  });

  test('Read snapshots an isolated screenshot for model vision', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-read-image-'));
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
      'base64',
    );
    await writeFile(join(cwd, 'screen.png'), pngBytes);
    const snapshots: Array<{ name: string; bytes: Uint8Array; mimeType: string }> = [];
    const executor: IsolatedToolExecutor = {
      async exec(input) {
        try {
          const { stdout, stderr } = await execAsync(input.command, {
            cwd: input.cwd,
            env: process.env,
            maxBuffer: 16 * 1024 * 1024,
          });
          return { exitCode: 0, stdout, stderr };
        } catch (error: any) {
          return {
            exitCode: typeof error?.code === 'number' ? error.code : 1,
            stdout: typeof error?.stdout === 'string' ? error.stdout : '',
            stderr: typeof error?.stderr === 'string' ? error.stderr : String(error),
          };
        }
      },
    };
    const tools = buildIsolatedHeadlessTools(executor, {
      snapshotImage: async (input: {
        sessionId: string;
        turnId: string;
        name: string;
        bytes: Uint8Array;
        mimeType: string;
      }) => {
        snapshots.push({ name: input.name, bytes: input.bytes, mimeType: input.mimeType });
        return {
          kind: 'session_file' as const,
          sessionId: input.sessionId,
          relativePath: 'artifacts/screen.png',
        };
      },
    } as any);

    const result = await tool(tools, 'Read').impl({ path: 'screen.png' }, toolCtx(cwd));

    assert.deepEqual(result, {
      kind: 'image',
      mimeType: 'image/png',
      ref: {
        kind: 'session_file',
        sessionId: 's',
        relativePath: 'artifacts/screen.png',
      },
    });
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.name, 'screen.png');
    assert.equal(snapshots[0]?.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(snapshots[0]?.bytes ?? []), pngBytes);
  });

  test('Read rejects an invalid isolated image before snapshotting it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-read-image-'));
    await writeFile(join(cwd, 'screen.png'), Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'));
    let snapshotCalls = 0;
    const executor: IsolatedToolExecutor = {
      async exec(input) {
        try {
          const { stdout, stderr } = await execAsync(input.command, {
            cwd: input.cwd,
            env: process.env,
            maxBuffer: 16 * 1024 * 1024,
          });
          return { exitCode: 0, stdout, stderr };
        } catch (error: any) {
          return {
            exitCode: typeof error?.code === 'number' ? error.code : 1,
            stdout: typeof error?.stdout === 'string' ? error.stdout : '',
            stderr: typeof error?.stderr === 'string' ? error.stderr : String(error),
          };
        }
      },
    };
    const tools = buildIsolatedHeadlessTools(executor, {
      snapshotImage: async () => {
        snapshotCalls += 1;
        return {
          kind: 'session_file' as const,
          sessionId: 's',
          relativePath: 'artifacts/screen.png',
        };
      },
    });

    await assert.rejects(
      async () => await tool(tools, 'Read').impl({ path: 'screen.png' }, toolCtx(cwd)),
      /dimensions/i,
    );
    assert.equal(snapshotCalls, 0);
  });

  test('Read rejects executor stdout outside its output frame', async () => {
    const tools = buildIsolatedHeadlessTools({
      async exec() {
        return {
          exitCode: 0,
          stdout: `${fileToolOutputFrame('Read', '     1\talpha\n')}[1]+ Done cleanup\n`,
          stderr: '',
        };
      },
    });

    await assert.rejects(
      async () => await tool(tools, 'Read').impl({ path: 'data.txt' }, toolCtx('/workspace')),
      /Read output transport integrity check failed/,
    );
  });

  test('Glob rejects executor stdout outside its output frame', async () => {
    const tools = buildIsolatedHeadlessTools({
      async exec() {
        return {
          exitCode: 0,
          stdout: `profile noise\n${fileToolOutputFrame('Glob', 'src/a.ts\n')}`,
          stderr: '',
        };
      },
    });

    await assert.rejects(
      async () => await tool(tools, 'Glob').impl({ pattern: '**/*.ts' }, toolCtx('/workspace')),
      /Glob output transport integrity check failed/,
    );
  });

  test('Grep rejects executor stdout outside its output frame', async () => {
    const tools = buildIsolatedHeadlessTools({
      async exec() {
        return {
          exitCode: 0,
          stdout: `${fileToolOutputFrame('Grep', 'src/a.ts:1:needle\n')}cleanup complete\n`,
          stderr: '',
        };
      },
    });

    await assert.rejects(
      async () => await tool(tools, 'Grep').impl({ pattern: 'needle' }, toolCtx('/workspace')),
      /Grep output transport integrity check failed/,
    );
  });

  test('Grep rejects framed decoded output above the existing 10 MiB capacity', async () => {
    const tools = buildIsolatedHeadlessTools({
      async exec() {
        return {
          exitCode: 0,
          stdout: fileToolOutputFrame('Grep', 'x'.repeat(10 * 1024 * 1024 + 1)),
          stderr: '',
        };
      },
    });

    await assert.rejects(
      async () => await tool(tools, 'Grep').impl({ pattern: 'x' }, toolCtx('/workspace')),
      /Grep output transport integrity check failed: decoded payload exceeds 10485760 bytes/,
    );
  });

  test('Edit ignores native file ops and still uses the shared replacer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-tools-edit-native-'));
    await mkdir(join(cwd, 'src'));
    const file = join(cwd, 'src', 'f.ts');
    await writeFile(file, 'function f() {\n    return 1;\n}\n', 'utf8');
    const nativeCalls: string[] = [];
    // A fully native-capable executor: Edit must still bypass these and run the
    // shared computeEditedSource path (there is no native Edit hook).
    const tools = buildIsolatedHeadlessTools({
      async exec(input) {
        try {
          const { stdout, stderr } = await execAsync(input.command, {
            cwd: input.cwd,
            maxBuffer: 1024 * 1024,
          });
          return { exitCode: 0, stdout, stderr };
        } catch (error: any) {
          return {
            exitCode: typeof error?.code === 'number' ? error.code : 1,
            stdout: typeof error?.stdout === 'string' ? error.stdout : '',
            stderr: typeof error?.stderr === 'string' ? error.stderr : String(error),
          };
        }
      },
      async writeFile(input) {
        nativeCalls.push('writeFile');
        return { ok: true, path: input.path, bytes: 0 };
      },
      async globFiles() {
        nativeCalls.push('globFiles');
        return { files: [] };
      },
      async grepFiles() {
        nativeCalls.push('grepFiles');
        return { matches: [] };
      },
    });

    // The fuzzy match works and returns the shared-replacer metadata
    // (matchedVia/startLine/endLine) — proof it went through computeEditedSource,
    // not a native shortcut — and no native file op was consulted for Edit.
    assert.deepEqual(
      await tool(tools, 'Edit').impl(
        {
          path: 'src/f.ts',
          old_string: 'function f() {\n  return 1;\n}',
          new_string: 'function f() {\n    return 2;\n}',
        },
        toolCtx(cwd),
      ),
      {
        ok: true,
        path: 'src/f.ts',
        replacements: 1,
        matchedVia: 'line-trimmed',
        startLine: 1,
        endLine: 3,
      },
    );
    assert.equal(await readFile(file, 'utf8'), 'function f() {\n    return 2;\n}\n');
    assert.deepEqual(nativeCalls, []);
  });

  test('Edit rejects unframed file bytes mixed with executor stdout noise before writing', async () => {
    const source = Buffer.from('alpha marker', 'utf8');
    let execCalls = 0;
    const tools = buildIsolatedHeadlessTools({
      async exec() {
        execCalls += 1;
        if (execCalls === 1) {
          return {
            exitCode: 0,
            stdout: `${source.toString('base64')}\n[1]+ Done env MAKA_HARBOR_COMMAND_SCOPE=test\n`,
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    await assert.rejects(
      async () =>
        await tool(tools, 'Edit').impl(
          { path: 'data.txt', old_string: 'alpha', new_string: 'beta' },
          toolCtx('/workspace'),
        ),
      /Edit read transport integrity check failed/,
    );
    assert.equal(execCalls, 1, 'a rejected read must not reach the write command');
  });

  test('Edit rejects ambiguous or corrupted read frames before writing', async (t) => {
    const source = Buffer.from('alpha', 'utf8');
    const valid = editReadFrame(source);
    const cases = [
      { name: 'output before the frame', stdout: `job started\n${valid}` },
      {
        name: 'output after the frame',
        stdout: `${valid}[1]+ Done env MAKA_HARBOR_COMMAND_SCOPE=test\n`,
      },
      { name: 'duplicate frame', stdout: `${valid}${valid}` },
      { name: 'truncated frame', stdout: valid.replace('MAKA_EDIT_BYTES_END\n', '') },
      {
        name: 'unsupported frame version',
        stdout: valid.replace('MAKA_EDIT_BYTES_V1', 'MAKA_EDIT_BYTES_V2'),
      },
      { name: 'non-canonical Base64', stdout: valid.replace('YWxwaGE=', 'YWxwaGE') },
      { name: 'byte length mismatch', stdout: valid.replace('length=5', 'length=6') },
      { name: 'SHA-256 mismatch', stdout: valid.replace(/sha256=./, 'sha256=0') },
    ];

    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        let execCalls = 0;
        const tools = buildIsolatedHeadlessTools({
          async exec() {
            execCalls += 1;
            return execCalls === 1
              ? { exitCode: 0, stdout: scenario.stdout, stderr: '' }
              : { exitCode: 0, stdout: '', stderr: '' };
          },
        });

        await assert.rejects(
          async () =>
            await tool(tools, 'Edit').impl(
              { path: 'data.txt', old_string: 'alpha', new_string: 'beta' },
              toolCtx('/workspace'),
            ),
          /Edit read transport integrity check failed/,
        );
        assert.equal(execCalls, 1, 'a rejected frame must not reach the write command');
      });
    }
  });

  test('Edit rejects a successful write result when the stored bytes do not match', async () => {
    const source = Buffer.from('alpha marker', 'utf8');
    let execCalls = 0;
    const tools = buildIsolatedHeadlessTools({
      async exec() {
        execCalls += 1;
        if (execCalls === 2) return { exitCode: 0, stdout: '', stderr: '' };
        return { exitCode: 0, stdout: editReadFrame(source), stderr: '' };
      },
    });

    await assert.rejects(
      async () =>
        await tool(tools, 'Edit').impl(
          { path: 'data.txt', old_string: 'alpha', new_string: 'beta' },
          toolCtx('/workspace'),
        ),
      /Edit post-write verification failed/,
    );
    assert.equal(execCalls, 3, 'Edit must read the stored bytes after the write reports success');
  });

  test('enabled heavy-task evidence recorder captures Bash, Read, Grep, Write, and Edit results', async () => {
    const store = createInMemoryTaskRunStore();
    let id = 0;
    const recorder = createHeavyTaskEvidenceRecorder({
      taskRunId: 'run-evidence',
      attemptId: 'attempt-1',
      store,
      now: () => 100 + id,
      newId: () => `id-${++id}`,
    });
    let editBytes = Buffer.from('old payload', 'utf8');
    const tools = buildIsolatedHeadlessTools(
      {
        async exec(input) {
          if (input.command.includes('Edit path') && input.command.includes('base64 < "$target"')) {
            return { exitCode: 0, stdout: editReadFrame(editBytes), stderr: '' };
          }
          if (input.command.includes('Edit path')) {
            editBytes = Buffer.from('new payload', 'utf8');
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          // Read now runs through READ_SCRIPT (no native fast path); the script
          // carries the distinctive 'Read path' label, so stub its content here.
          if (input.command.includes('Read path')) {
            return {
              exitCode: 0,
              stdout: fileToolOutputFrame('Read', `read src/file.ts\n${'r'.repeat(5_000)}`),
              stderr: '',
            };
          }
          return {
            exitCode: 2,
            stdout: `large stdout\n${'x'.repeat(5_000)}`,
            stderr: 'short stderr\n',
          };
        },
        async writeFile(input) {
          return { ok: true, path: input.path, bytes: Buffer.byteLength(input.content, 'utf8') };
        },
        async grepFiles() {
          return { matches: ['src/file.ts:1:needle'] };
        },
      },
      { heavyTaskEvidence: recorder },
    );
    const ctx = { ...toolCtx('/workspace'), runId: 'agent-run-1' };

    await tool(tools, 'Bash').impl({ command: 'npm test' }, ctx);
    await tool(tools, 'Read').impl({ path: 'src/file.ts', limit: 10 }, ctx);
    await tool(tools, 'Grep').impl({ pattern: 'needle', path: 'src' }, ctx);
    await tool(tools, 'Write').impl(
      { path: 'src/out.txt', content: 'write payload must be omitted' },
      ctx,
    );
    await tool(tools, 'Edit').impl(
      { path: 'src/out.txt', old_string: 'old payload', new_string: 'new payload' },
      ctx,
    );

    const projection = await store.project('run-evidence');
    assert.deepEqual(
      projection.heavyTaskEvidence.map((item) => item.tool?.name),
      ['Bash', 'Read', 'Grep', 'Write', 'Edit'],
    );
    assert.ok(
      projection.heavyTaskEvidence.every((item) => item.source.agentRunId === 'agent-run-1'),
    );
    assert.equal(projection.latestHeavyTaskEvidence?.tool?.name, 'Edit');
    assert.equal(projection.heavyTaskEvidence[0]?.tool?.outputs[0]?.truncated, true);
    const serialized = JSON.stringify(projection.heavyTaskEvidence);
    assert.doesNotMatch(serialized, /write payload must be omitted|old payload|new payload/);
  });

  test('sh-backed file tools fall back to command-backed isolated operations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-tools-fallback-'));
    await mkdir(join(cwd, 'src'));
    const absoluteFile = join(cwd, 'src', 'file.txt');
    const absoluteSrc = join(cwd, 'src');
    const absoluteGlob = `${cwd}/**/*.txt`;
    const calls: string[] = [];
    const tools = buildIsolatedHeadlessTools({
      async exec(input) {
        calls.push(input.command);
        try {
          const { stdout, stderr } = await execAsync(input.command, {
            cwd: input.cwd,
            env: { ...process.env, PATH: '/usr/bin:/bin' },
            maxBuffer: 1024 * 1024,
          });
          return { exitCode: 0, stdout, stderr };
        } catch (error: any) {
          return {
            exitCode: typeof error?.code === 'number' ? error.code : 1,
            stdout: typeof error?.stdout === 'string' ? error.stdout : '',
            stderr: typeof error?.stderr === 'string' ? error.stderr : String(error),
          };
        }
      },
    });

    assert.deepEqual(
      await tool(tools, 'Write').impl(
        { path: absoluteFile, content: 'hello\nneedle\n' },
        toolCtx(cwd),
      ),
      {
        ok: true,
        path: 'src/file.txt',
        bytes: 13,
      },
    );
    assert.deepEqual(
      await tool(tools, 'Read').impl({ path: absoluteFile, offset: 1, limit: 1 }, toolCtx(cwd)),
      {
        content: '     2\tneedle\n', // cat -n: absolute line number + tab + content
      },
    );
    assert.deepEqual(await tool(tools, 'Glob').impl({ pattern: absoluteGlob }, toolCtx(cwd)), {
      files: ['src/file.txt'],
    });
    assert.deepEqual(
      await tool(tools, 'Grep').impl(
        { pattern: 'needle', path: absoluteSrc, glob: absoluteGlob },
        toolCtx(cwd),
      ),
      {
        matches: ['src/file.txt:2:needle'],
      },
    );
    assert.equal(await readFile(join(cwd, 'src/file.txt'), 'utf8'), 'hello\nneedle\n');
    // Read/Write/Glob/Grep stay POSIX-sh scripts that must work with only base
    // coreutils on PATH (here pinned to /usr/bin:/bin).
    assert.ok(calls.length >= 4);
    assert.ok(calls.every((command) => command.startsWith("sh -c '")));
    assert.ok(calls.every((command) => !command.includes('node -e')));
  });

  test('Glob rg path enumerates the same files as the find path', async (t) => {
    try {
      await execAsync('rg --version', { env: process.env });
    } catch {
      t.skip('ripgrep not installed');
      return;
    }
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-glob-rg-'));
    await mkdir(join(cwd, 'sub'));
    await writeFile(join(cwd, 'visible.txt'), '', 'utf8');
    await writeFile(join(cwd, '.hidden.txt'), '', 'utf8'); // hidden -> kept by --hidden
    await writeFile(join(cwd, '.gitignore'), 'ignored.txt\n', 'utf8');
    await writeFile(join(cwd, 'ignored.txt'), '', 'utf8'); // gitignored -> kept by --no-ignore
    await writeFile(join(cwd, 'real.txt'), '', 'utf8');
    await symlink('real.txt', join(cwd, 'link.txt')); // file symlink -> excluded (parity with find -type f)
    await writeFile(join(cwd, 'sub', 'deep.txt'), '', 'utf8');

    const mkTools = (env: NodeJS.ProcessEnv) =>
      buildIsolatedHeadlessTools({
        async exec(input) {
          try {
            const { stdout, stderr } = await execAsync(input.command, {
              cwd: input.cwd,
              env,
              maxBuffer: 1024 * 1024,
            });
            return { exitCode: 0, stdout, stderr };
          } catch (error: any) {
            return {
              exitCode: typeof error?.code === 'number' ? error.code : 1,
              stdout: typeof error?.stdout === 'string' ? error.stdout : '',
              stderr: typeof error?.stderr === 'string' ? error.stderr : String(error),
            };
          }
        },
      });
    const rgTools = mkTools(process.env); // rg on PATH -> rg --files branch
    // Guarantee the find branch: a PATH with the coreutils GLOB_SCRIPT needs but
    // NOT rg. A fixed '/usr/bin:/bin' would not do it — on some Linux CI rg lives
    // in /usr/bin, so findTools would silently run rg and the parity check below
    // would be vacuous.
    const noRgBin = await mkdtemp(join(tmpdir(), 'maka-headless-norg-bin-'));
    for (const bin of ['sh', 'find', 'sed', 'awk', 'sort', 'dirname', 'basename', 'base64']) {
      const resolved = (await execAsync(`command -v ${bin}`, { env: process.env })).stdout.trim();
      await symlink(resolved, join(noRgBin, bin));
    }
    const findTools = mkTools({ ...process.env, PATH: noRgBin }); // no rg -> find branch

    const glob = async (tools: ReturnType<typeof buildIsolatedHeadlessTools>) =>
      (
        (await tool(tools, 'Glob').impl({ pattern: '*.txt' }, toolCtx(cwd))) as { files: string[] }
      ).files
        .slice()
        .sort();

    const rgFiles = await glob(rgTools);
    const findFiles = await glob(findTools);
    assert.deepEqual(rgFiles, findFiles, 'rg and find enumerate the same files');
    // *.txt matches top-level .txt only; hidden + gitignored kept, file symlink excluded.
    assert.deepEqual(rgFiles, ['.hidden.txt', 'ignored.txt', 'real.txt', 'visible.txt']);

    // >200 matches: rg and find traverse in different orders, so the 200-cap must
    // be applied AFTER a deterministic sort or the truncated sets would diverge.
    // Read .files raw (no test-side sort) to prove the script sorts before capping.
    await mkdir(join(cwd, 'many'));
    for (let i = 0; i < 250; i += 1) {
      await writeFile(join(cwd, 'many', `f${String(i).padStart(3, '0')}.txt`), '', 'utf8');
    }
    const globRaw = async (tools: ReturnType<typeof buildIsolatedHeadlessTools>) =>
      (
        (await tool(tools, 'Glob').impl({ pattern: 'many/*.txt' }, toolCtx(cwd))) as {
          files: string[];
        }
      ).files;
    const rgMany = await globRaw(rgTools);
    const findMany = await globRaw(findTools);
    assert.equal(rgMany.length, 200, 'capped at 200');
    assert.deepEqual(rgMany, findMany, 'same capped set regardless of enumeration order');
    // The cap is the sorted first 200 (f000..f199), not whatever each tool happened to enumerate first.
    assert.equal(rgMany[0], 'many/f000.txt');
    assert.equal(rgMany[199], 'many/f199.txt');
  });

  test('the Glob rg branch pins its enumeration flags and checks rg exit (non-skippable safety net)', async () => {
    let captured = '';
    const tools = buildIsolatedHeadlessTools({
      async exec(input) {
        captured = input.command;
        return { exitCode: 0, stdout: fileToolOutputFrame('Glob', ''), stderr: '' };
      },
    });
    await tool(tools, 'Glob').impl({ pattern: '*.txt' }, toolCtx('/workspace'));
    // Pin the exact rg enumeration so --no-config (hermetic against a host
    // RIPGREP_CONFIG_PATH) and --no-ignore/--hidden (find parity) cannot be
    // silently dropped. Asserts the script text, so it runs with or without rg.
    assert.match(captured, /rg --no-config --files --no-ignore --hidden -- "\$rel_base"/);
    // ...and rg's exit code must be inspected: rc>1 is a real error, not "no files".
    assert.match(captured, /rc=\$\?/);
    assert.match(captured, /\[ "\$rc" -gt 1 \] &&/);
  });

  test('Glob surfaces a ripgrep runtime error instead of returning an empty list', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-glob-rgfail-'));
    await writeFile(join(cwd, 'real.txt'), '', 'utf8');
    // rg present but failing at runtime (exit 2). Prepending a fake rg to PATH
    // shadows the real one; the script must not swallow the failure into an empty
    // result — it surfaces the error (mirrors the Grep rg branch).
    const binDir = await mkdtemp(join(tmpdir(), 'maka-headless-fakerg-'));
    await writeFile(
      join(binDir, 'rg'),
      '#!/bin/sh\necho "rg: simulated failure" >&2\nexit 2\n',
      'utf8',
    );
    await chmod(join(binDir, 'rg'), 0o755);
    const tools = buildIsolatedHeadlessTools({
      async exec(input) {
        try {
          const { stdout, stderr } = await execAsync(input.command, {
            cwd: input.cwd,
            env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
            maxBuffer: 1024 * 1024,
          });
          return { exitCode: 0, stdout, stderr };
        } catch (error: any) {
          return {
            exitCode: typeof error?.code === 'number' ? error.code : 1,
            stdout: typeof error?.stdout === 'string' ? error.stdout : '',
            stderr: typeof error?.stderr === 'string' ? error.stderr : String(error),
          };
        }
      },
    });
    await assert.rejects(
      () => tool(tools, 'Glob').impl({ pattern: '*.txt' }, toolCtx(cwd)) as Promise<unknown>,
      /ripgrep failed \(exit 2\)/,
    );
  });

  test('Glob rg success branch (fake rg) pins flags and applies ./-strip, ERE filter, sort, cap', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-glob-fakerg-ok-'));
    const binDir = await mkdtemp(join(tmpdir(), 'maka-headless-fakerg-ok-'));
    const argvLog = join(binDir, 'argv.txt');
    // A fake rg that records its argv and prints a fixed `--files` listing in
    // REVERSE order, with ./ prefixes and one non-.txt entry. This exercises the
    // success branch end-to-end on a host with no real rg, so a regression in the
    // pinned flags, ./ stripping, ERE filtering, sort, or the 200 cap is caught.
    const rgScript = [
      '#!/bin/sh',
      `printf '%s ' "$@" > ${JSON.stringify(argvLog)}`,
      'i=250',
      `while [ "$i" -ge 1 ]; do printf './f%03d.txt\\n' "$i"; i=$((i - 1)); done`,
      `printf '%s\\n' './notes.md' 'a.txt'`,
      '',
    ].join('\n');
    await writeFile(join(binDir, 'rg'), rgScript, 'utf8');
    await chmod(join(binDir, 'rg'), 0o755);
    const tools = buildIsolatedHeadlessTools({
      async exec(input) {
        try {
          const { stdout, stderr } = await execAsync(input.command, {
            cwd: input.cwd,
            env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
            maxBuffer: 1024 * 1024,
          });
          return { exitCode: 0, stdout, stderr };
        } catch (error: any) {
          return {
            exitCode: typeof error?.code === 'number' ? error.code : 1,
            stdout: typeof error?.stdout === 'string' ? error.stdout : '',
            stderr: typeof error?.stderr === 'string' ? error.stderr : String(error),
          };
        }
      },
    });

    const r = (await tool(tools, 'Glob').impl({ pattern: '*.txt' }, toolCtx(cwd))) as {
      files: string[];
    };
    assert.equal(r.files.length, 200, 'capped at 200');
    assert.equal(r.files[0], 'a.txt', 'sorted ascending despite reverse-order rg output');
    assert.equal(r.files[1], 'f001.txt');
    assert.equal(r.files[199], 'f199.txt');
    assert.ok(!r.files.includes('notes.md'), '.md filtered out by the *.txt ERE');
    assert.ok(!r.files.some((f) => f.startsWith('./')), 'leading ./ stripped from every path');
    // rg was invoked with exactly the pinned safety flags.
    const argv = await readFile(argvLog, 'utf8');
    assert.match(argv, /--no-config --files --no-ignore --hidden --/);
  });

  test('Read (command path) numbers lines, caps by default, and guards binaries', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-read-'));
    await writeFile(
      join(cwd, 'big.txt'),
      Array.from({ length: 2500 }, (_, i) => `line${i + 1}`).join('\n') + '\n',
      'utf8',
    );
    await writeFile(join(cwd, 'data.bin'), Buffer.from([0, 1, 2, 0, 65, 66])); // 6 bytes, contains NUL
    const tools = buildIsolatedHeadlessTools({
      async exec(input) {
        try {
          const { stdout, stderr } = await execAsync(input.command, {
            cwd: input.cwd,
            env: process.env,
            maxBuffer: 4 * 1024 * 1024,
          });
          return { exitCode: 0, stdout, stderr };
        } catch (error: any) {
          return {
            exitCode: typeof error?.code === 'number' ? error.code : 1,
            stdout: typeof error?.stdout === 'string' ? error.stdout : '',
            stderr: typeof error?.stderr === 'string' ? error.stderr : String(error),
          };
        }
      },
    });

    // Default read: cat -n numbering from line 1, capped at 2000 with a continuation hint.
    const def = (await tool(tools, 'Read').impl({ path: join(cwd, 'big.txt') }, toolCtx(cwd))) as {
      content: string;
    };
    assert.ok(def.content.startsWith('     1\tline1\n'), 'numbers from line 1');
    assert.ok(def.content.includes('  2000\tline2000\n'), 'shows up to the 2000-line cap');
    assert.ok(!def.content.includes('line2001'), 'does not exceed the cap');
    assert.ok(def.content.includes('truncated at line 2000'), 'hints how to continue');

    // Offset keeps absolute line numbers; reading the tail shows no hint.
    const tail = (await tool(tools, 'Read').impl(
      { path: join(cwd, 'big.txt'), offset: 2498, limit: 2 },
      toolCtx(cwd),
    )) as { content: string };
    assert.equal(tail.content, '  2499\tline2499\n  2500\tline2500\n');

    // Binary guard.
    const bin = (await tool(tools, 'Read').impl({ path: join(cwd, 'data.bin') }, toolCtx(cwd))) as {
      content: string;
    };
    assert.equal(bin.content, '[binary file: 6 bytes, contents omitted]');

    // Binary guard must hold when an invalid high byte precedes the NUL: in a
    // UTF-8 locale BSD/macOS tr would otherwise abort and misclassify it as text.
    await writeFile(join(cwd, 'highbyte.bin'), Buffer.from([0xff, 0x00, 0x41]));
    const highBin = (await tool(tools, 'Read').impl(
      { path: join(cwd, 'highbyte.bin') },
      toolCtx(cwd),
    )) as { content: string };
    assert.equal(highBin.content, '[binary file: 3 bytes, contents omitted]');
  });

  test('Read clips an over-long single line at 2000 bytes with a marker', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-read-clip-'));
    await writeFile(join(cwd, 'long.txt'), 'X'.repeat(2500) + '\n', 'utf8'); // one 2500-byte line
    const tools = buildIsolatedHeadlessTools({
      async exec(input) {
        try {
          const { stdout, stderr } = await execAsync(input.command, {
            cwd: input.cwd,
            env: process.env,
            maxBuffer: 4 * 1024 * 1024,
          });
          return { exitCode: 0, stdout, stderr };
        } catch (error: any) {
          return {
            exitCode: typeof error?.code === 'number' ? error.code : 1,
            stdout: typeof error?.stdout === 'string' ? error.stdout : '',
            stderr: typeof error?.stderr === 'string' ? error.stderr : String(error),
          };
        }
      },
    });

    const r = (await tool(tools, 'Read').impl({ path: join(cwd, 'long.txt') }, toolCtx(cwd))) as {
      content: string;
    };
    assert.ok(r.content.startsWith('     1\t'), 'line-number prefix present');
    assert.ok(r.content.includes('... [line truncated]'), 'clip marker present');
    assert.equal(
      r.content.match(/X/g)?.length,
      2000,
      'only the first 2000 bytes kept, clipped tail dropped',
    );
  });

  test('Grep prefers ripgrep when on PATH and skips binary files', async (t) => {
    try {
      await execAsync('rg --version', { env: process.env });
    } catch {
      t.skip('ripgrep not installed');
      return;
    }
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-grep-rg-'));
    await mkdir(join(cwd, 'src'));
    await writeFile(join(cwd, 'src', 'file.txt'), 'hello\nneedle\n', 'utf8');
    // A binary file that contains the needle: ripgrep detects the NUL bytes and
    // skips it, where the find/awk fallback would match its bytes. A clean
    // result therefore proves the ripgrep path ran.
    await writeFile(
      join(cwd, 'src', 'data.bin'),
      Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from('needle\n')]),
    );
    const tools = buildIsolatedHeadlessTools({
      async exec(input) {
        try {
          const { stdout, stderr } = await execAsync(input.command, {
            cwd: input.cwd,
            env: process.env, // full PATH so rg resolves
            maxBuffer: 1024 * 1024,
          });
          return { exitCode: 0, stdout, stderr };
        } catch (error: any) {
          return {
            exitCode: typeof error?.code === 'number' ? error.code : 1,
            stdout: typeof error?.stdout === 'string' ? error.stdout : '',
            stderr: typeof error?.stderr === 'string' ? error.stderr : String(error),
          };
        }
      },
    });

    assert.deepEqual(await tool(tools, 'Grep').impl({ pattern: 'needle' }, toolCtx(cwd)), {
      matches: ['src/file.txt:2:needle'],
    });
    // Single-file search must still carry the path prefix (rg --with-filename).
    assert.deepEqual(
      await tool(tools, 'Grep').impl(
        { pattern: 'needle', path: join(cwd, 'src', 'file.txt') },
        toolCtx(cwd),
      ),
      { matches: ['src/file.txt:2:needle'] },
    );
  });

  test('Grep with rg ignores RIPGREP_CONFIG_PATH and will not follow a symlink out of the workspace', async (t) => {
    try {
      await execAsync('rg --version', { env: process.env });
    } catch {
      t.skip('ripgrep not installed');
      return;
    }
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-grep-cfg-'));
    await mkdir(join(cwd, 'src'));
    await writeFile(join(cwd, 'src', 'file.txt'), 'hello\nneedle\n', 'utf8');
    // A file OUTSIDE the workspace, reachable only by following a symlink.
    const outside = await mkdtemp(join(tmpdir(), 'maka-headless-grep-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'needle\n', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(cwd, 'src', 'evil.txt'));
    // An rg config that turns symlink-following ON. --no-config must make rg
    // ignore it; without --no-config rg would read it, follow src/evil.txt, and
    // leak the external file — exactly the workspace-escape this guards against.
    const rgConfig = join(await mkdtemp(join(tmpdir(), 'maka-headless-rgcfg-')), 'rg.conf');
    await writeFile(rgConfig, '--follow\n', 'utf8');
    const tools = buildIsolatedHeadlessTools({
      async exec(input) {
        try {
          const { stdout, stderr } = await execAsync(input.command, {
            cwd: input.cwd,
            env: { ...process.env, RIPGREP_CONFIG_PATH: rgConfig }, // host passes it through (childProcessEnv)
            maxBuffer: 1024 * 1024,
          });
          return { exitCode: 0, stdout, stderr };
        } catch (error: any) {
          return {
            exitCode: typeof error?.code === 'number' ? error.code : 1,
            stdout: typeof error?.stdout === 'string' ? error.stdout : '',
            stderr: typeof error?.stderr === 'string' ? error.stderr : String(error),
          };
        }
      },
    });

    const result = (await tool(tools, 'Grep').impl({ pattern: 'needle' }, toolCtx(cwd))) as {
      matches: string[];
    };
    assert.ok(
      result.matches.includes('src/file.txt:2:needle'),
      'the in-workspace match is still returned',
    );
    assert.ok(
      !result.matches.some((m) => m.includes('evil.txt')),
      'the symlink out of the workspace is not followed despite RIPGREP_CONFIG_PATH=--follow',
    );
  });

  test('Grep routes glob filters through the fallback dialect, not ripgrep --glob (parity with/without rg)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-grep-glob-'));
    // Three root files all containing the needle. The glob "{a,c}.txt" diverges by
    // dialect: ripgrep's --glob brace-expands it to a.txt/c.txt, while the
    // fallback's globPatternToEre treats { } , as literals and matches only the
    // file literally named "{a,c}.txt". The fix routes every glob through the
    // fallback, so the result is the literal file in BOTH rg-present and
    // rg-absent environments — this assertion fails if rg ever handles the glob.
    await writeFile(join(cwd, 'a.txt'), 'needle\n', 'utf8');
    await writeFile(join(cwd, 'c.txt'), 'needle\n', 'utf8');
    await writeFile(join(cwd, '{a,c}.txt'), 'needle\n', 'utf8');
    const tools = buildIsolatedHeadlessTools({
      async exec(input) {
        try {
          const { stdout, stderr } = await execAsync(input.command, {
            cwd: input.cwd,
            env: process.env, // full PATH: if rg is installed, it is a candidate
            maxBuffer: 1024 * 1024,
          });
          return { exitCode: 0, stdout, stderr };
        } catch (error: any) {
          return {
            exitCode: typeof error?.code === 'number' ? error.code : 1,
            stdout: typeof error?.stdout === 'string' ? error.stdout : '',
            stderr: typeof error?.stderr === 'string' ? error.stderr : String(error),
          };
        }
      },
    });

    const result = (await tool(tools, 'Grep').impl(
      { pattern: 'needle', glob: '{a,c}.txt' },
      toolCtx(cwd),
    )) as { matches: string[] };
    assert.deepEqual(
      result.matches,
      ['{a,c}.txt:1:needle'],
      'glob uses the literal fallback dialect, not rg brace-expansion',
    );
  });

  test('the ripgrep Grep branch pins its safety flags and never re-grows --glob (non-skippable safety net)', async () => {
    let captured = '';
    const tools = buildIsolatedHeadlessTools({
      async exec(input) {
        captured = input.command;
        return { exitCode: 0, stdout: fileToolOutputFrame('Grep', ''), stderr: '' };
      },
    });
    await tool(tools, 'Grep').impl({ pattern: 'needle' }, toolCtx('/workspace'));
    // Pin the exact rg invocation (not just a comment mention) so the config- and
    // symlink-escape guards cannot be silently dropped — runs with or without rg.
    assert.match(captured, /rg --no-config --no-follow .* -e "\$grep_pattern" -- "\$search"/);
    // The rg branch is gated on no-glob; every glob must route through the fallback
    // dialect, so this assertion holds even on a machine without rg installed.
    assert.match(captured, /\[ -z "\$glob" \] && command -v rg/);
    // ...and the deleted dynamic --glob assembly must never come back into rg.
    assert.doesNotMatch(captured, /--glob "\$glob"/);
  });

  test('command-backed Edit runs the shared fuzzy matcher without executor node', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-tools-edit-'));
    await mkdir(join(cwd, 'src'));
    const file = join(cwd, 'src', 'f.ts');
    // 4-space indented body on disk; the model's old_string uses 2-space indent.
    await writeFile(file, 'function f() {\n    return 1;\n}\n', 'utf8');
    await chmod(file, 0o600); // editing must preserve the original mode, not widen it
    const calls: string[] = [];
    const tools = buildIsolatedHeadlessTools({
      async exec(input) {
        calls.push(input.command);
        if (input.command.startsWith("node -e '")) {
          return { exitCode: 127, stdout: '', stderr: 'node: not found' };
        }
        try {
          const { stdout, stderr } = await execAsync(input.command, {
            cwd: input.cwd,
            maxBuffer: 1024 * 1024,
          });
          return { exitCode: 0, stdout, stderr };
        } catch (error: any) {
          return {
            exitCode: typeof error?.code === 'number' ? error.code : 1,
            stdout: typeof error?.stdout === 'string' ? error.stdout : '',
            stderr: typeof error?.stderr === 'string' ? error.stderr : String(error),
          };
        }
      },
    });

    // Fuzzy: indentation drift is forgiven, and the matched span/strategy is reported.
    assert.deepEqual(
      await tool(tools, 'Edit').impl(
        {
          path: 'src/f.ts',
          old_string: 'function f() {\n  return 1;\n}',
          new_string: 'function f() {\n    return 2;\n}',
        },
        toolCtx(cwd),
      ),
      {
        ok: true,
        path: 'src/f.ts',
        replacements: 1,
        matchedVia: 'line-trimmed',
        startLine: 1,
        endLine: 3,
      },
    );
    assert.equal(await readFile(file, 'utf8'), 'function f() {\n    return 2;\n}\n');

    // Exact match still works and reports matchedVia: 'exact'.
    assert.deepEqual(
      await tool(tools, 'Edit').impl(
        { path: 'src/f.ts', old_string: 'return 2;', new_string: 'return 3;' },
        toolCtx(cwd),
      ),
      {
        ok: true,
        path: 'src/f.ts',
        replacements: 1,
        matchedVia: 'exact',
        startLine: 2,
        endLine: 2,
      },
    );
    assert.equal(await readFile(file, 'utf8'), 'function f() {\n    return 3;\n}\n');
    assert.equal((await stat(file)).mode & 0o777, 0o600); // mode preserved across the tmp+rename

    // Edit refuses to follow a symlink out of the workspace (mirrors existing_target()).
    const outside = await mkdtemp(join(tmpdir(), 'maka-headless-tools-edit-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'secret\n', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(cwd, 'src', 'link.txt'));
    await assert.rejects(
      async () =>
        await tool(tools, 'Edit').impl(
          { path: 'src/link.txt', old_string: 'secret', new_string: 'edited' },
          toolCtx(cwd),
        ),
      /inside workspace/,
    );
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'secret\n');

    assert.ok(calls.length >= 3);
    assert.ok(calls.every((command) => !command.startsWith("node -e '")));
  });

  test('command-backed Edit edits a binary file byte-exactly without corrupting non-UTF-8 bytes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-tools-edit-bin-'));
    await mkdir(join(cwd, 'src'));
    const file = join(cwd, 'src', 'b.bin');
    // Lone 0xff / 0xfe are invalid UTF-8; decoding as utf8 would replace them with
    // U+FFFD and corrupt the file. The edit path must keep them byte-for-byte.
    await writeFile(
      file,
      Buffer.concat([Buffer.from([0xff]), Buffer.from('ABC', 'utf8'), Buffer.from([0xfe])]),
    );
    const tools = buildIsolatedHeadlessTools({
      async exec(input) {
        try {
          const { stdout, stderr } = await execAsync(input.command, {
            cwd: input.cwd,
            maxBuffer: 1024 * 1024,
          });
          return { exitCode: 0, stdout, stderr };
        } catch (error: any) {
          return {
            exitCode: typeof error?.code === 'number' ? error.code : 1,
            stdout: typeof error?.stdout === 'string' ? error.stdout : '',
            stderr: typeof error?.stderr === 'string' ? error.stderr : String(error),
          };
        }
      },
    });

    // Exact byte-level replacement: the surrounding non-UTF-8 bytes are preserved.
    const result = await tool(tools, 'Edit').impl(
      { path: 'src/b.bin', old_string: 'ABC', new_string: 'XYZ' },
      toolCtx(cwd),
    );
    assert.equal((result as { matchedVia?: string }).matchedVia, 'exact');
    assert.deepEqual([...(await readFile(file))], [0xff, 0x58, 0x59, 0x5a, 0xfe]);

    // A non-exact (fuzzy) edit on a binary file is refused, not guessed — and the
    // file is left untouched.
    await assert.rejects(
      async () =>
        await tool(tools, 'Edit').impl(
          { path: 'src/b.bin', old_string: 'X Y Z', new_string: 'Q' },
          toolCtx(cwd),
        ),
      /looks binary/,
    );
    assert.deepEqual([...(await readFile(file))], [0xff, 0x58, 0x59, 0x5a, 0xfe]);
  });

  test('concurrent Edits to the same file serialize — no lost update', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-tools-lock-'));
    const file = join(cwd, 'data.txt');
    const n = 20;
    const markers = Array.from({ length: n }, (_, i) => `marker-${String(i).padStart(2, '0')}`);
    await writeFile(file, `${markers.join('\n')}\n`, 'utf8');
    // Run through the real shell so the read-modify-write actually hits disk.
    const tools = execBackedTools();
    // Fire all edits concurrently. Each rewrites the whole file, so without the
    // per-path lock the last rename would clobber the others and most edits vanish.
    const results = await Promise.all(
      markers.map((m, i) =>
        tool(tools, 'Edit').impl(
          { path: file, old_string: m, new_string: `done-${String(i).padStart(2, '0')}` },
          toolCtx(cwd),
        ),
      ),
    );
    assert.ok(results.every((r: any) => r.ok === true && r.replacements === 1));
    const expected = `${Array.from({ length: n }, (_, i) => `done-${String(i).padStart(2, '0')}`).join('\n')}\n`;
    assert.equal(await readFile(file, 'utf8'), expected, 'every concurrent edit landed');
  });

  test('concurrent Edits via different path spellings serialize on one key', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-tools-lockkey-'));
    const file = join(cwd, 'data.txt');
    const n = 20;
    const markers = Array.from({ length: n }, (_, i) => `marker-${String(i).padStart(2, '0')}`);
    await writeFile(file, `${markers.join('\n')}\n`, 'utf8');
    const tools = execBackedTools();
    // Alternate the spelling of the same file. Without lexical key normalization
    // 'data.txt' and './data.txt' hash to different mutex keys, so the two groups
    // run concurrently and clobber each other; normalization collapses them.
    const results = await Promise.all(
      markers.map((m, i) =>
        tool(tools, 'Edit').impl(
          {
            path: i % 2 === 0 ? 'data.txt' : './data.txt',
            old_string: m,
            new_string: `done-${String(i).padStart(2, '0')}`,
          },
          toolCtx(cwd),
        ),
      ),
    );
    assert.ok(results.every((r: any) => r.ok === true));
    const expected = `${Array.from({ length: n }, (_, i) => `done-${String(i).padStart(2, '0')}`).join('\n')}\n`;
    assert.equal(
      await readFile(file, 'utf8'),
      expected,
      'every edit landed despite mixed path spellings',
    );
  });

  test('a Write and an Edit on the same file serialize — they never overlap at the executor boundary', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-tools-write-edit-'));
    // Both Write (WRITE_SCRIPT) and Edit byte read/write reach the filesystem through
    // executor.exec; with no native file hook they share the same executor boundary.
    // The spy counts concurrently-active exec calls. Sharing one fileWriteKey the
    // two must run strictly one-at-a-time (max 1 active); without the lock they
    // overlap (2 active) and their read-modify-write could lose an update. The two
    // setImmediate yields force an overlap window when serialization is absent.
    let active = 0;
    let maxActive = 0;
    let editBytes = Buffer.from('alpha marker', 'utf8');
    const tools = buildIsolatedHeadlessTools({
      async exec(input) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        active -= 1;
        if (input.command.includes('base64 < "$target"')) {
          return { exitCode: 0, stdout: editReadFrame(editBytes), stderr: '' };
        }
        if (input.command.includes('Edit path')) editBytes = Buffer.from('beta marker', 'utf8');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    await Promise.all([
      tool(tools, 'Write').impl({ path: 'data.txt', content: 'WRITTEN\n' }, toolCtx(cwd)),
      tool(tools, 'Edit').impl(
        { path: 'data.txt', old_string: 'alpha marker', new_string: 'beta marker' },
        toolCtx(cwd),
      ),
    ]);
    assert.equal(maxActive, 1, 'Write and Edit on one path must not run concurrently');
  });

  test('command-backed file tools do not follow symlinks outside the isolated workspace', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-headless-tools-symlink-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-headless-tools-outside-'));
    await mkdir(join(cwd, 'src'));
    await writeFile(join(outside, 'secret.txt'), 'outside needle\n', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(cwd, 'src', 'link.txt'));
    const tools = buildIsolatedHeadlessTools({
      async exec(input) {
        try {
          const { stdout, stderr } = await execAsync(input.command, {
            cwd: input.cwd,
            env: { ...process.env, PATH: '/usr/bin:/bin' },
            maxBuffer: 1024 * 1024,
          });
          return { exitCode: 0, stdout, stderr };
        } catch (error: any) {
          return {
            exitCode: typeof error?.code === 'number' ? error.code : 1,
            stdout: typeof error?.stdout === 'string' ? error.stdout : '',
            stderr: typeof error?.stderr === 'string' ? error.stderr : String(error),
          };
        }
      },
    });

    await assert.rejects(
      async () =>
        await tool(tools, 'Write').impl(
          { path: 'src/link.txt', content: 'overwrite\n' },
          toolCtx(cwd),
        ),
      /inside workspace/,
    );
    await assert.rejects(
      async () => await tool(tools, 'Read').impl({ path: 'src/link.txt' }, toolCtx(cwd)),
      /inside workspace/,
    );
    assert.deepEqual(
      await tool(tools, 'Grep').impl({ pattern: 'outside', glob: '**/*.txt' }, toolCtx(cwd)),
      {
        matches: [],
      },
    );
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'outside needle\n');
  });

  test('isolated file tools reject path escapes before executor invocation', async () => {
    let calls = 0;
    const tools = buildIsolatedHeadlessTools({
      async exec() {
        calls += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const ctx = toolCtx('/workspace');

    await assert.rejects(
      async () => await tool(tools, 'Read').impl({ path: '/etc/passwd' }, ctx),
      /inside the isolated workspace/,
    );
    await assert.rejects(
      async () => await tool(tools, 'Write').impl({ path: '../x', content: '' }, ctx),
      /inside the isolated workspace/,
    );
    await assert.rejects(
      async () =>
        await tool(tools, 'Edit').impl(
          { path: 'nested/../../x', old_string: 'a', new_string: 'b' },
          ctx,
        ),
      /inside the isolated workspace/,
    );
    await assert.rejects(
      async () => await tool(tools, 'Glob').impl({ pattern: '/tmp/*.txt' }, ctx),
      /inside the isolated workspace/,
    );
    await assert.rejects(
      async () => await tool(tools, 'Grep').impl({ pattern: 'x', glob: '../*.txt' }, ctx),
      /inside the isolated workspace/,
    );
    assert.equal(calls, 0);
  });

  test('standard isolated tool availability does not advertise agent tools or a loader', () => {
    const tools = buildIsolatedHeadlessTools({
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const plan = new ToolAvailabilityRuntime(
      tools,
      buildIsolatedHeadlessToolAvailability(tools.map((tool) => tool.name)),
      {
        name: 'invalid',
        description: 'invalid',
        parameters: {},
        impl: () => ({}),
      },
    ).prepare([
      {
        content: {
          kind: 'function_call',
          name: LOAD_TOOLS_NAME,
          args: { group: 'agent' },
        },
      },
    ]);

    assert.ok(plan.activeTools.includes('Bash'));
    assert.ok(plan.activeTools.includes('Read'));
    assert.ok(!plan.activeTools.includes(LOAD_TOOLS_NAME));
    assert.ok(!plan.activeTools.includes('agent_spawn'));
    assert.ok(!plan.activeTools.includes(AGENT_SWARM_TOOL_NAME));
    assert.ok(!plan.activeTools.includes('agent_list'));
    assert.ok(!plan.activeTools.includes('agent_output'));
    assert.ok(!plan.providerTools.some((tool) => tool.name === LOAD_TOOLS_NAME));
    assert.ok(!plan.providerTools.some((tool) => tool.name.startsWith('agent_')));
    assert.equal(plan.projectActiveTools, undefined);
  });

  test('explicitly enabled agent tools remain deferred behind the catalog loader', () => {
    const tools = buildIsolatedHeadlessTools(
      {
        async exec() {
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
      { agentTools: true },
    );
    const plan = new ToolAvailabilityRuntime(
      tools,
      buildIsolatedHeadlessToolAvailability(tools.map((tool) => tool.name)),
      {
        name: 'invalid',
        description: 'invalid',
        parameters: {},
        impl: () => ({}),
      },
    ).prepare([]);

    assert.ok(plan.activeTools.includes(LOAD_TOOLS_NAME));
    assert.ok(!plan.activeTools.includes('agent_spawn'));
    assert.ok(!plan.activeTools.includes(AGENT_SWARM_TOOL_NAME));
    assert.ok(!plan.activeTools.includes('agent_list'));
    assert.ok(!plan.activeTools.includes('agent_output'));
    const loaded = plan.projectActiveTools!({
      completedSteps: [{ toolCalls: [{ toolName: LOAD_TOOLS_NAME, input: { group: 'agent' } }] }],
    }).activeTools;
    assert.ok(loaded.includes('agent_spawn'));
    assert.ok(loaded.includes(AGENT_SWARM_TOOL_NAME));
    assert.ok(loaded.includes('agent_list'));
    assert.ok(loaded.includes('agent_output'));
  });

  test('standard isolated tool availability does not reintroduce agent tools into local-read children', () => {
    const parentTools = buildIsolatedHeadlessTools(
      {
        async exec() {
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
      { agentTools: true },
    );
    const childTools = buildChildAgentTools(parentTools);
    const plan = new ToolAvailabilityRuntime(
      childTools,
      buildIsolatedHeadlessToolAvailability(parentTools.map((tool) => tool.name)),
      {
        name: 'invalid',
        description: 'invalid',
        parameters: {},
        impl: () => ({}),
      },
    ).prepare([]);

    assert.deepEqual([...plan.activeTools].sort(), ['Glob', 'Grep', 'Read']);
    assert.equal(plan.projectActiveTools, undefined);
    assert.ok(!plan.activeTools.includes(LOAD_TOOLS_NAME));
    assert.ok(!plan.activeTools.includes('agent_spawn'));
    assert.ok(!plan.activeTools.includes(AGENT_SWARM_TOOL_NAME));
  });

  test('README real-backend sketch preserves child tool overrides', async () => {
    const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');

    assert.ok(readme.includes('ctx.tools ??'));
    assert.ok(readme.includes('agentTools: context.config.agentTools,'));
  });
});

function execBackedTools(env: NodeJS.ProcessEnv = process.env) {
  return buildIsolatedHeadlessTools({
    async exec(input) {
      try {
        const { stdout, stderr } = await execAsync(input.command, {
          cwd: input.cwd,
          env,
          maxBuffer: 1024 * 1024,
        });
        return { exitCode: 0, stdout, stderr };
      } catch (error: any) {
        return {
          exitCode: typeof error?.code === 'number' ? error.code : 1,
          stdout: typeof error?.stdout === 'string' ? error.stdout : '',
          stderr: typeof error?.stderr === 'string' ? error.stderr : String(error),
        };
      }
    },
  });
}

function tool(tools: ReturnType<typeof buildIsolatedHeadlessTools>, name: string) {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function toolCtx(cwd: string) {
  return {
    sessionId: 's',
    turnId: 't',
    cwd,
    toolCallId: 'tool-1',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

function editReadFrame(content: Buffer): string {
  const digest = createHash('sha256').update(content).digest('hex');
  return `MAKA_EDIT_BYTES_V1 length=${content.length} sha256=${digest}\n${content.toString('base64')}\nMAKA_EDIT_BYTES_END\n`;
}

function fileToolOutputFrame(toolName: string, content: string): string {
  const nonce = '1';
  const bytes = Buffer.concat([
    Buffer.from(content, 'utf8'),
    Buffer.from(`\0MAKA_FILE_TOOL_STATUS_${nonce}=0`, 'ascii'),
  ]);
  return `MAKA_FILE_TOOL_OUTPUT_V1 tool=${toolName} nonce=${nonce}\n${bytes.toString('base64')}\nMAKA_FILE_TOOL_OUTPUT_END\n`;
}

function fileToolOutputForCommand(command: string): string {
  for (const toolName of ['Read', 'Glob', 'Grep']) {
    if (command.includes(`-- '${toolName}' `)) return fileToolOutputFrame(toolName, '');
  }
  return '';
}
