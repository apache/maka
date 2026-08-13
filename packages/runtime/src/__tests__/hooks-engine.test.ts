import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PreToolUseHookInput, ResolvedHookDefinition } from '@maka/core/hooks';
import {
  createHookCommandRunner,
  HOOK_EXECUTION_MARKER,
  type HookCommandRunner,
} from '../hooks/command-runner.js';
import { createHookExecutionLimiter, createPreToolUseHookDispatcher } from '../hooks/engine.js';

describe('PreToolUse Hook engine', () => {
  it('freezes one snapshot per turn and skips untrusted matching definitions', async () => {
    let loads = 0;
    let runs = 0;
    const dispatcher = createPreToolUseHookDispatcher({
      loadSnapshot: async () => {
        loads += 1;
        return [definition({ trusted: false })];
      },
      commandRunner: {
        run: async () => {
          runs += 1;
          return result(0);
        },
      },
    });
    const first = await dispatcher.runPreToolUse(
      hookInput('turn-1'),
      new AbortController().signal,
      { invocationId: 'invocation-1' },
    );
    await dispatcher.runPreToolUse(hookInput('turn-1'), new AbortController().signal, {
      invocationId: 'invocation-1',
    });
    await dispatcher.runPreToolUse(hookInput('turn-2'), new AbortController().signal, {
      invocationId: 'invocation-2',
    });
    assert.equal(loads, 2);
    assert.equal(runs, 0);
    assert.equal(first.denied, false);
    assert.equal(first.audits[0]?.status, 'skipped_untrusted');
  });

  it('retains every active Turn snapshot until that Turn is released', async () => {
    let revision = 1;
    let loads = 0;
    const dispatcher = createPreToolUseHookDispatcher({
      loadSnapshot: async () => {
        loads += 1;
        return [definition({ id: `revision-${revision}`, trusted: false })];
      },
    });
    for (let index = 1; index <= 9; index += 1) dispatcher.prepareTurn(`turn-${index}`);
    await Promise.resolve();
    revision = 2;

    const retained = await dispatcher.runPreToolUse(
      hookInput('turn-1'),
      new AbortController().signal,
      { invocationId: 'invocation-1' },
    );
    assert.equal(retained.audits[0]?.handlerId, 'revision-1');
    assert.equal(loads, 9);

    dispatcher.releaseTurn('turn-1');
    const reloaded = await dispatcher.runPreToolUse(
      hookInput('turn-1'),
      new AbortController().signal,
      { invocationId: 'invocation-1-reloaded' },
    );
    assert.equal(reloaded.audits[0]?.handlerId, 'revision-2');
    assert.equal(loads, 10);
  });

  it('runs matching handlers concurrently and reports denials in configuration order', async () => {
    let active = 0;
    let maxActive = 0;
    const runner: HookCommandRunner = {
      run: async (definition) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, definition.id === 'first' ? 20 : 1));
        active -= 1;
        return {
          ...result(2),
          stderr: `${definition.id} denied`,
        };
      },
    };
    const dispatcher = createPreToolUseHookDispatcher({
      loadSnapshot: async () => [
        definition({ id: 'first', definitionOrder: 0 }),
        definition({ id: 'second', definitionOrder: 1 }),
      ],
      commandRunner: runner,
    });
    const output = await dispatcher.runPreToolUse(
      hookInput('turn-1'),
      new AbortController().signal,
      { invocationId: 'invocation-1' },
    );
    assert.equal(maxActive, 2);
    assert.equal(output.denied, true);
    assert.equal(output.reason, 'first denied\nsecond denied');
    assert.deepEqual(
      output.audits.map((audit) => audit.handlerId),
      ['first', 'second'],
    );
  });

  it('shares one concurrency ceiling across simultaneous dispatchers and sessions', async () => {
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: HookCommandRunner = {
      run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate;
        active -= 1;
        return result(0);
      },
    };
    const limiter = createHookExecutionLimiter(2);
    const createDispatcher = () =>
      createPreToolUseHookDispatcher({
        loadSnapshot: async () => [
          definition({ id: 'first', definitionOrder: 0 }),
          definition({ id: 'second', definitionOrder: 1 }),
        ],
        commandRunner: runner,
        executionLimiter: limiter,
      });
    const first = createDispatcher().runPreToolUse(
      hookInput('turn-1'),
      new AbortController().signal,
      { invocationId: 'invocation-1' },
    );
    const second = createDispatcher().runPreToolUse(
      { ...hookInput('turn-2'), session_id: 'session-2' },
      new AbortController().signal,
      { invocationId: 'invocation-2' },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(maxActive, 2);
    release();
    await Promise.all([first, second]);
    assert.equal(maxActive, 2);
  });

  it('fails open on handler and audit failures but preserves an explicit denial', async () => {
    const dispatcher = createPreToolUseHookDispatcher({
      loadSnapshot: async () => [
        definition({ id: 'failed', definitionOrder: 0 }),
        definition({ id: 'denied', definitionOrder: 1 }),
      ],
      commandRunner: {
        run: async (definition) =>
          definition.id === 'failed'
            ? { ...result(1), stderr: 'crashed' }
            : { ...result(2), stderr: 'policy denial' },
      },
      recordAudit: async () => {
        throw new Error('audit unavailable');
      },
    });
    const output = await dispatcher.runPreToolUse(
      hookInput('turn-1'),
      new AbortController().signal,
      { invocationId: 'invocation-1' },
    );
    assert.equal(output.denied, true);
    assert.equal(output.reason, 'policy denial');
    assert.deepEqual(
      output.audits.map((audit) => audit.status),
      ['failed', 'denied'],
    );
    assert.equal(output.auditWriteFailures.length, 2);
  });

  it('passes versioned JSON on stdin and accepts structured deny output', async () => {
    const runner = createHookCommandRunner();
    const structured = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'structured policy denial',
      },
    });
    const dispatcher = createPreToolUseHookDispatcher({
      loadSnapshot: async () => [
        definition({
          command: process.execPath,
          args: [
            '-e',
            `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const x=JSON.parse(s);if(x.schema_version!==1||x.tool_name!=='Bash')process.exit(9);process.stdout.write(${JSON.stringify(structured)})})`,
          ],
        }),
      ],
      commandRunner: runner,
    });
    const output = await dispatcher.runPreToolUse(
      hookInput('turn-1'),
      new AbortController().signal,
      { invocationId: 'invocation-1' },
    );
    assert.equal(output.denied, true);
    assert.equal(output.reason, 'structured policy denial');
  });

  it('marks Hook children and refuses execution in a Host recursively started by a Hook', async () => {
    const runner = createHookCommandRunner();
    const markerProbe = await runner.run(
      definition({
        command: process.execPath,
        args: [
          '-e',
          `process.exit(process.env[${JSON.stringify(HOOK_EXECUTION_MARKER)}] === '1' ? 0 : 9)`,
        ],
      }),
      hookInput('turn-1'),
      new AbortController().signal,
    );
    assert.equal(markerProbe.exitCode, 0);

    const previous = process.env[HOOK_EXECUTION_MARKER];
    process.env[HOOK_EXECUTION_MARKER] = '1';
    try {
      const recursive = await runner.run(
        definition({ command: process.execPath, args: ['-e', 'process.exit(99)'] }),
        hookInput('turn-recursive'),
        new AbortController().signal,
      );
      assert.equal(recursive.exitCode, null);
      assert.equal(recursive.spawnError, 'Recursive Hook execution is not allowed');
    } finally {
      if (previous === undefined) delete process.env[HOOK_EXECUTION_MARKER];
      else process.env[HOOK_EXECUTION_MARKER] = previous;
    }
  });

  it('terminates timed-out Hook process trees and fails open', async () => {
    const dispatcher = createPreToolUseHookDispatcher({
      loadSnapshot: async () => [
        definition({
          command: process.execPath,
          args: ['-e', 'setInterval(()=>{},1000)'],
          timeoutMs: 100,
        }),
      ],
    });
    const output = await dispatcher.runPreToolUse(
      hookInput('turn-1'),
      new AbortController().signal,
      { invocationId: 'invocation-1' },
    );
    assert.equal(output.denied, false);
    assert.equal(output.audits[0]?.status, 'failed');
    assert.equal(output.audits[0]?.message, 'Hook timed out');
  });

  it('terminates Hook process trees when the Turn is aborted', async () => {
    const dispatcher = createPreToolUseHookDispatcher({
      loadSnapshot: async () => [
        definition({
          command: process.execPath,
          args: ['-e', 'setInterval(()=>{},1000)'],
          timeoutMs: 5_000,
        }),
      ],
    });
    const controller = new AbortController();
    const pending = dispatcher.runPreToolUse(hookInput('turn-1'), controller.signal, {
      invocationId: 'invocation-1',
    });
    setTimeout(() => controller.abort(), 50);
    const output = await pending;
    assert.equal(output.denied, false);
    assert.equal(output.audits[0]?.status, 'failed');
    assert.equal(output.audits[0]?.message, 'Hook aborted with the Turn');
  });
});

function definition(input: Partial<ResolvedHookDefinition> = {}): ResolvedHookDefinition {
  return {
    id: 'policy',
    eventName: 'PreToolUse',
    matcher: 'Bash',
    command: '/usr/bin/true',
    args: [],
    timeoutMs: 1_000,
    source: 'user',
    sourceOrder: 0,
    definitionOrder: 0,
    projectIdentity: 'user',
    definitionHash: `sha256:${'a'.repeat(64)}`,
    trusted: true,
    ...input,
  };
}

function hookInput(turnId: string): PreToolUseHookInput {
  return {
    schema_version: 1,
    hook_event_name: 'PreToolUse',
    session_id: 'session-1',
    turn_id: turnId,
    run_id: `run-${turnId}`,
    tool_use_id: 'tool-use-1',
    tool_name: 'Bash',
    tool_input: { command: 'git push' },
    cwd: process.cwd(),
    permission_mode: 'ask',
    origin: 'provider',
  };
}

function result(exitCode: number) {
  return {
    exitCode,
    stdout: '',
    stderr: '',
    timedOut: false,
    aborted: false,
  };
}
