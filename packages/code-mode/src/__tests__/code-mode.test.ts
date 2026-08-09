import assert from 'node:assert/strict';
import test from 'node:test';
import { jsonSchema, tool } from 'ai';
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
  let inspectedPastLimit = false;
  const trailing = Object.defineProperty({}, 'value', {
    enumerable: true,
    get: () => {
      inspectedPastLimit = true;
      throw new Error('must not inspect values after the byte limit');
    },
  });

  assert.equal(serializedByteLength('\0'.repeat(10)), 62);
  assert.equal(serializedByteLength(['x'.repeat(128), trailing], 32), 33);
  assert.equal(inspectedPastLimit, false);
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

test('reports a runtime SyntaxError as an execution error', async () => {
  const result = await execute(`return JSON.parse('not json');`);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, 'execution_error');
});

test('runs nested tools concurrently inside one cell', async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  let active = 0;
  let maxActive = 0;
  let releaseTools!: () => void;
  let observeConcurrency!: () => void;
  const toolsReleased = new Promise<void>((resolve) => {
    releaseTools = resolve;
  });
  const concurrencyObserved = new Promise<void>((resolve) => {
    observeConcurrency = resolve;
  });
  const execution = execute(
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
        if (active === 2) observeConcurrency();
        await toolsReleased;
        active -= 1;
        return input;
      },
    },
  );

  const overlapped = await Promise.race([
    concurrencyObserved.then(() => true),
    execution.then(() => false),
  ]);
  assert.equal(overlapped, true);
  releaseTools();
  const result = await execution;

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
    let functionConstructorBlocked = false;
    try {
      Function('return 1')();
    } catch {
      functionConstructorBlocked = true;
    }
    return {
      process: typeof globalThis.process,
      require: typeof globalThis.require,
      fetch: typeof globalThis.fetch,
      webAssembly: typeof globalThis.WebAssembly,
      eval: typeof globalThis.eval,
      functionConstructorBlocked,
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
    functionConstructorBlocked: true,
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

test('does not dispatch tools inherited from Object.prototype', async () => {
  let inheritedCalls = 0;
  Object.defineProperty(Object.prototype, 'inheritedCodeModeTool', {
    configurable: true,
    value: tool({
      inputSchema: jsonSchema({}),
      execute: async () => {
        inheritedCalls += 1;
        return 'escaped';
      },
    }),
  });

  try {
    const result = await execute('return await tools.inheritedCodeModeTool({});');
    assert.equal(result.ok ? undefined : result.error.kind, 'unknown_tool');
    assert.equal(inheritedCalls, 0);
  } finally {
    delete (Object.prototype as Record<string, unknown>).inheritedCodeModeTool;
  }
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
        return error.message;
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
    value: 'expected failure',
    toolCalls: [{ index: 1, name: 'fail' }],
  });
});

test('reports uncaught runtime and tool failures', async (t) => {
  await t.test('runtime', async () => {
    const result = await execute("throw new Error('out of memory');");
    assert.equal(result.ok ? undefined : result.error.kind, 'execution_error');
  });

  await t.test('tool', async () => {
    const result = await execute('return await tools.fail({});', {
      tools: [{ name: 'fail' }],
      callTool: async () => {
        throw new Error('stack overflow');
      },
    });
    assert.equal(result.ok ? undefined : result.error.kind, 'tool_failure');
  });

  await t.test('non-serializable tool output', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = await execute('return await tools.fail({});', {
      tools: [{ name: 'fail' }],
      callTool: async () => circular,
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

  await t.test('undefined override keeps the product default', async () => {
    const result = await execute(
      `
        for (let index = 0; index < 33; index += 1) await tools.echo({ index });
        return null;
      `,
      {
        tools: [{ name: 'echo' }],
        limits: { maxToolCalls: undefined } as unknown as ExecuteCodeCellInput['limits'],
        callTool: async () => null,
      },
    );
    assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  });

  await t.test('tool concurrency', async () => {
    let started = 0;
    const result = await execute('return await Promise.all([tools.echo({}), tools.echo({})]);', {
      tools: [{ name: 'echo' }],
      limits: { maxToolConcurrency: 1, maxSandboxTimeMs: 500 },
      callTool: async (_name, _input, signal) => {
        started += 1;
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return null;
      },
    });
    assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
    assert.ok(started <= 1);
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
    limits: { maxMemoryBytes: 8 * 1024 * 1024, maxSandboxTimeMs: 5_000 },
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, 'limit_exceeded');
});

test('preempts a pure compute loop at the sandbox-time limit', async () => {
  const result = await execute('while (true) {}', { limits: { maxSandboxTimeMs: 20 } });

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

test('does not start later tools after a fatal host failure', async () => {
  const fatalError = new Error('durable commit failed');
  const calls: string[] = [];
  const execution = execute(
    `
      try { await tools.first({}); } catch {}
      try { await tools.second({}); } catch {}
      return 'ignored';
    `,
    {
      tools: [{ name: 'first' }, { name: 'second' }],
      callTool: async (name) => {
        calls.push(name);
        if (name === 'first') throw fatalError;
        return null;
      },
      isFatalToolError: (error) => error === fatalError,
    },
  );

  await assert.rejects(execution, (error) => error === fatalError);
  assert.deepEqual(calls, ['first']);
});

test('aborts and drains concurrent tools while preserving the first fatal failure', async () => {
  const firstFatal = new Error('first durable failure');
  const secondFatal = new Error('second durable failure');
  const calls: string[] = [];
  let peerStarted!: () => void;
  let peerAborted!: () => void;
  let releasePeer!: () => void;
  const peerHasStarted = new Promise<void>((resolve) => {
    peerStarted = resolve;
  });
  const peerWasAborted = new Promise<void>((resolve) => {
    peerAborted = resolve;
  });
  const peerCanFinish = new Promise<void>((resolve) => {
    releasePeer = resolve;
  });
  const execution = execute('return await Promise.all([tools.peer({}), tools.fail({})]);', {
    tools: [{ name: 'peer' }, { name: 'fail' }],
    callTool: async (name, _input, signal) => {
      calls.push(name);
      if (name === 'fail') {
        await peerHasStarted;
        throw firstFatal;
      }
      peerStarted();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      peerAborted();
      await peerCanFinish;
      throw secondFatal;
    },
    isFatalToolError: (error) => error === firstFatal || error === secondFatal,
  });

  await peerWasAborted;
  try {
    const beforeRelease = await Promise.race([
      execution.then(
        () => 'settled' as const,
        () => 'settled' as const,
      ),
      new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
    ]);
    assert.equal(beforeRelease, 'pending');
    assert.deepEqual(calls, ['peer', 'fail']);
    releasePeer();
    await assert.rejects(execution, (error) => error === firstFatal);
  } finally {
    releasePeer();
    await Promise.allSettled([execution]);
  }
});

test('bounds serial execution at one pending cell', async () => {
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
  const third = run('third');

  try {
    const excess = await Promise.race([
      third,
      new Promise<'still-pending'>((resolve) => setImmediate(() => resolve('still-pending'))),
    ]);
    assert.notEqual(excess, 'still-pending');
    if (excess !== 'still-pending') {
      assert.equal(excess.ok ? undefined : excess.error.kind, 'limit_exceeded');
      assert.deepEqual(excess.toolCalls, []);
    }
    assert.deepEqual(started, ['first']);
    releaseFirst();
    const results = await Promise.all([first, second]);
    assert.deepEqual(
      results.map((result) => (result.ok ? result.value : undefined)),
      ['first', 'second'],
    );
  } finally {
    releaseFirst();
    await Promise.allSettled([first, second, third]);
  }
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
