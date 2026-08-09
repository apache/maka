import assert from 'node:assert/strict';
import test from 'node:test';
import { type ExecuteCodeCellInput, executeCodeCell, serializedByteLength } from '../index.js';

function execute(code: string, input: Partial<Omit<ExecuteCodeCellInput, 'code'>> = {}) {
  return executeCodeCell({
    code,
    tools: [],
    callTool: async () => null,
    ...input,
  });
}

test('counts the bounded JSON representation used at the tool boundary', () => {
  const repeated = Array.from({ length: 1_024 }, () => '\0'.repeat(128));

  assert.equal(serializedByteLength('\0'.repeat(10)), 62);
  assert.equal(serializedByteLength(repeated, 32), 33);
});

test('executes standard JavaScript without an interpreter subset', async () => {
  const result = await execute(`
    const key = 'answer';
    const message = await Promise.reject(new Error('expected'))
      .catch((error) => error.message);
    return { [key]: 42, message };
  `);

  assert.deepEqual(result, {
    ok: true,
    value: { answer: 42, message: 'expected' },
    toolCalls: [],
  });
});

test('executes TypeScript syntax', async () => {
  const result = await execute(`
    interface Answer { value: number }
    const answer: Answer = { value: 42 };
    return answer;
  `);

  assert.deepEqual(result, { ok: true, value: { value: 42 }, toolCalls: [] });
});

test('reports invalid source as a parse error', async () => {
  const result = await execute('const value = ;');

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, 'parse_error');
});

test('runs nested tools concurrently inside one cell', async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  let active = 0;
  let maxActive = 0;
  const result = await execute(
    `return await Promise.all([
      tools.lookup({ id: 'a' }),
      tools.lookup({ id: 'b' }),
    ]);`,
    {
      tools: [{ name: 'lookup' }],
      callTool: async (name, input) => {
        calls.push({ name, input });
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return input;
      },
    },
  );

  assert.equal(maxActive, 2);
  assert.deepEqual(calls, [
    { name: 'lookup', input: { id: 'a' } },
    { name: 'lookup', input: { id: 'b' } },
  ]);
  assert.deepEqual(result, {
    ok: true,
    value: [{ id: 'a' }, { id: 'b' }],
    toolCalls: [
      { index: 1, name: 'lookup' },
      { index: 2, name: 'lookup' },
    ],
  });
});

test('does not expose Node capabilities to cell code', async () => {
  const result = await execute(`
    let functionConstructor;
    try {
      Function('return 1')();
      functionConstructor = 'allowed';
    } catch (error) {
      functionConstructor = error.message;
    }
    return {
      process: typeof globalThis.process,
      require: typeof globalThis.require,
      fetch: typeof globalThis.fetch,
      webAssembly: typeof globalThis.WebAssembly,
      eval: typeof globalThis.eval,
      functionConstructor,
    };
  `);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    process: 'undefined',
    require: 'undefined',
    fetch: 'undefined',
    webAssembly: 'undefined',
    eval: 'undefined',
    functionConstructor: 'Function constructor is not allowed',
  });
});

test('starts each cell in a fresh global context', async () => {
  const first = await execute('globalThis.transient = 42; return globalThis.transient;');
  const second = await execute('return globalThis.transient ?? null;');

  assert.equal(first.ok ? first.value : undefined, 42);
  assert.equal(second.ok ? second.value : undefined, null);
});

test('uses normal partial-execution semantics before an unknown tool failure', async () => {
  const calls: string[] = [];
  const result = await execute(
    `
      await tools.allowed({});
      return await tools.missing({});
    `,
    {
      tools: [{ name: 'allowed' }],
      callTool: async (name) => {
        calls.push(name);
        return null;
      },
    },
  );

  assert.deepEqual(calls, ['allowed']);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, 'unknown_tool');
});

test('does not start an unobserved tool call', async () => {
  let calls = 0;
  const result = await execute('tools.echo({}); return null;', {
    tools: [{ name: 'echo' }],
    callTool: async () => {
      calls += 1;
      return null;
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.ok, false);
});

test('lets cell code handle an ordinary tool failure', async () => {
  const result = await execute(
    `
      try {
        await tools.fail({});
      } catch (error) {
        return { name: error.name, message: error.message };
      }
    `,
    {
      tools: [{ name: 'fail' }],
      callTool: async () => {
        throw new Error('expected failure');
      },
    },
  );

  assert.deepEqual(result, {
    ok: true,
    value: { name: 'CodeModeToolError', message: 'expected failure' },
    toolCalls: [{ index: 1, name: 'fail' }],
  });
});

test('reports uncaught runtime and tool failures', async (t) => {
  await t.test('runtime', async () => {
    const result = await execute("throw new Error('boom');");
    assert.equal(result.ok ? undefined : result.error.kind, 'execution_error');
  });

  await t.test('tool', async () => {
    const result = await execute('return await tools.fail({});', {
      tools: [{ name: 'fail' }],
      callTool: async () => {
        throw new Error('boom');
      },
    });
    assert.equal(result.ok ? undefined : result.error.kind, 'tool_failure');
  });
});

test('enforces byte and bridge limits', async (t) => {
  await t.test('source', async () => {
    const result = await execute('return null;', { limits: { maxSourceBytes: 1 } });
    assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  });

  await t.test('tool input', async () => {
    const result = await execute("return await tools.echo({ value: '12345' });", {
      tools: [{ name: 'echo' }],
      limits: { maxToolInputBytes: 4 },
      callTool: async () => null,
    });
    assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  });

  await t.test('tool output', async () => {
    const result = await execute('return await tools.echo({});', {
      tools: [{ name: 'echo' }],
      limits: { maxToolOutputBytes: 4 },
      callTool: async () => '12345',
    });
    assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  });

  await t.test('cell output', async () => {
    const result = await execute("return '12345';", { limits: { maxOutputBytes: 4 } });
    assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  });

  await t.test('tool calls', async () => {
    const result = await execute('await tools.echo({}); return await tools.echo({});', {
      tools: [{ name: 'echo' }],
      limits: { maxToolCalls: 1 },
      callTool: async () => null,
    });
    assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  });

  await t.test('tool concurrency', async () => {
    const result = await execute('return await Promise.all([tools.echo({}), tools.echo({})]);', {
      tools: [{ name: 'echo' }],
      limits: { maxToolConcurrency: 1 },
      callTool: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return null;
      },
    });
    assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  });
});

test('enforces the configured VM stack limit', async () => {
  const result = await execute('function recurse() { return recurse(); } return recurse();', {
    limits: { maxStackBytes: 64 * 1024 },
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, 'limit_exceeded');
});

test('enforces the configured VM memory limit', async () => {
  const result = await execute('return new ArrayBuffer(16 * 1024 * 1024).byteLength;', {
    limits: { maxMemoryBytes: 8 * 1024 * 1024, maxWallTimeMs: 5_000 },
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, 'limit_exceeded');
});

test('preempts a pure compute loop at the wall-time limit', async () => {
  const result = await execute('while (true) {}', { limits: { maxWallTimeMs: 20 } });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, 'limit_exceeded');
});

test('waits for an aborted host operation to settle before rejecting', async () => {
  const controller = new AbortController();
  const reason = new Error('stop requested');
  let toolStarted!: () => void;
  let releaseTool!: () => void;
  const started = new Promise<void>((resolve) => {
    toolStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  const execution = execute('return await tools.wait({});', {
    tools: [{ name: 'wait' }],
    signal: controller.signal,
    callTool: async (_name, _input, signal) => {
      toolStarted();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      await released;
      return null;
    },
  });

  await started;
  controller.abort(reason);
  const early = await Promise.race([
    execution.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
  ]);
  assert.equal(early, 'pending');

  releaseTool();
  await assert.rejects(execution, (error) => error === reason);
});

test('does not let cell code suppress a fatal host failure', async () => {
  const fatalError = new Error('durable commit failed');
  const execution = execute(
    `
      try {
        await tools.fail({});
      } catch {}
      return 'ignored';
    `,
    {
      tools: [{ name: 'fail' }],
      callTool: async () => {
        throw fatalError;
      },
      isFatalToolError: (error) => error === fatalError,
    },
  );

  await assert.rejects(execution, (error) => error === fatalError);
});

test('preserves a fatal host rejection whose reason is undefined', async () => {
  const execution = execute(
    `
      try {
        await tools.fail({});
      } catch {}
      return 'ignored';
    `,
    {
      tools: [{ name: 'fail' }],
      callTool: async () => Promise.reject(undefined),
      isFatalToolError: (error) => error === undefined,
    },
  );

  await assert.rejects(execution, (error) => error === undefined);
});

test('serializes concurrent cells through one execution slot', async () => {
  const started: string[] = [];
  let firstStarted!: () => void;
  let releaseFirst!: () => void;
  const firstHasStarted = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const callTool = async (_name: string, input: unknown) => {
    const id = (input as { id: string }).id;
    started.push(id);
    if (id === 'first') {
      firstStarted();
      await firstCanFinish;
    }
    return id;
  };
  const run = (id: string) =>
    execute(`return await tools.hold({ id: '${id}' });`, {
      tools: [{ name: 'hold' }],
      callTool,
    });

  const first = run('first');
  await firstHasStarted;
  const second = run('second');
  await new Promise((resolve) => setImmediate(resolve));

  try {
    assert.deepEqual(started, ['first']);
  } finally {
    releaseFirst();
  }
  const results = await Promise.all([first, second]);
  assert.deepEqual(
    results.map((result) => (result.ok ? result.value : undefined)),
    ['first', 'second'],
  );
});

test('aborts a queued cell without waiting for the active cell', async () => {
  let firstStarted!: () => void;
  let releaseFirst!: () => void;
  const firstHasStarted = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = execute('return await tools.hold({});', {
    tools: [{ name: 'hold' }],
    callTool: async () => {
      firstStarted();
      await firstCanFinish;
      return null;
    },
  });
  await firstHasStarted;

  const controller = new AbortController();
  const reason = new Error('queued cell cancelled');
  let queuedToolCalls = 0;
  const queued = execute('return await tools.never({});', {
    tools: [{ name: 'never' }],
    signal: controller.signal,
    callTool: async () => {
      queuedToolCalls += 1;
      return null;
    },
  });
  controller.abort(reason);

  const outcome = await Promise.race([
    queued.then(
      () => 'resolved' as const,
      (error) => error,
    ),
    new Promise<'still-pending'>((resolve) => setImmediate(() => resolve('still-pending'))),
  ]);

  try {
    assert.equal(outcome, reason);
    assert.equal(queuedToolCalls, 0);
  } finally {
    releaseFirst();
    await Promise.allSettled([first, queued]);
  }
});
