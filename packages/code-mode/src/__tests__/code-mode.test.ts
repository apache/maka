import assert from 'node:assert/strict';
import test from 'node:test';
import { executeCodeCell, serializedByteLength } from '../index.js';

test('caps serialized-byte traversal before materializing an oversized representation', () => {
  const repeated = Array.from({ length: 1_024 }, () => '\0'.repeat(128));
  const customArray: unknown[] = [];
  Object.defineProperty(customArray, 'toJSON', { value: () => 'custom' });

  assert.equal(serializedByteLength('\0'.repeat(10)), 62);
  assert.equal(serializedByteLength(repeated, 32), 33);
  assert.equal(serializedByteLength(customArray, 32), Number.POSITIVE_INFINITY);
});

test('runs a tool call and returns transformed plain data', async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const result = await executeCodeCell({
    code: `
      const issue = await tools.lookup({ id: "42" });
      return { id: issue.id, open: issue.status !== "closed" };
    `,
    tools: [
      {
        name: 'lookup',
      },
    ],
    callTool: async (name, input) => {
      calls.push({ name, input });
      return { id: '42', status: 'open' };
    },
  });

  assert.deepEqual(calls, [{ name: 'lookup', input: { id: '42' } }]);
  assert.deepEqual(result, {
    ok: true,
    value: { id: '42', open: true },
    toolCalls: [{ index: 1, name: 'lookup' }],
  });
});

test('uses one tool result to select a dependent second call', async () => {
  const calls: string[] = [];
  const result = await executeCodeCell({
    code: `
      const first = await tools.lookup({ id: "root" });
      if (first.next) {
        const second = await tools.lookup({ id: first.next });
        return [first.id, second.id];
      }
      return [];
    `,
    tools: [{ name: 'lookup' }],
    callTool: async (_name, input) => {
      const id = (input as { id: string }).id;
      calls.push(id);
      return id === 'root' ? { id, next: 'child' } : { id };
    },
  });

  assert.deepEqual(calls, ['root', 'child']);
  assert.deepEqual(result, {
    ok: true,
    value: ['root', 'child'],
    toolCalls: [
      { index: 1, name: 'lookup' },
      { index: 2, name: 'lookup' },
    ],
  });
});

test('runs independent tool calls concurrently through Promise.all', async () => {
  let active = 0;
  let maxActive = 0;
  const result = await executeCodeCell({
    code: `
      const pending = [
        tools.lookup({ id: "a" }),
        tools.lookup({ id: "b" })
      ];
      return await Promise.all(pending);
    `,
    tools: [{ name: 'lookup' }],
    callTool: async (_name, input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return input;
    },
  });

  assert.equal(maxActive, 2);
  assert.deepEqual(result, {
    ok: true,
    value: [{ id: 'a' }, { id: 'b' }],
    toolCalls: [
      { index: 1, name: 'lookup' },
      { index: 2, name: 'lookup' },
    ],
  });
});

test('preserves nested tool concurrency through Array.map and Promise.all', async () => {
  let active = 0;
  let maxActive = 0;
  const result = await executeCodeCell({
    code: `
      const ids = ["a", "b"];
      return await Promise.all(ids.map((id) => tools.lookup({ id })));
    `,
    tools: [{ name: 'lookup' }],
    callTool: async (_name, input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return input;
    },
  });

  assert.equal(maxActive, 2);
  assert.deepEqual(result.ok ? result.value : undefined, [{ id: 'a' }, { id: 'b' }]);
});

test('bounds the aggregate result retained by Promise.all', async () => {
  const result = await executeCodeCell({
    code: `
      const values = await Promise.all([
        tools.load({ id: 1 }),
        tools.load({ id: 2 })
      ]);
      return values.length;
    `,
    tools: [{ name: 'load' }],
    callTool: async () => 'x'.repeat(30),
    limits: { maxIntermediateBytes: 50, maxResultBytes: 100 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  assert.match(result.ok ? '' : result.error.message, /Promise\.all byte limit/i);
});

test('bounds the aggregate result retained by Promise.allSettled', async () => {
  const result = await executeCodeCell({
    code: `
      const values = await Promise.allSettled([
        tools.load({ id: 1 }),
        tools.load({ id: 2 })
      ]);
      return values.length;
    `,
    tools: [{ name: 'load' }],
    callTool: async () => 'x'.repeat(30),
    limits: { maxIntermediateBytes: 100, maxResultBytes: 100 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  assert.match(result.ok ? '' : result.error.message, /Promise\.allSettled byte limit/i);
});

test('rejects Promise.race before starting nested tool calls', async () => {
  let calls = 0;
  const result = await executeCodeCell({
    code: `
      return await Promise.race([
        tools.lookup({ id: "first" }),
        tools.lookup({ id: "second" })
      ]);
    `,
    tools: [{ name: 'lookup' }],
    callTool: async (_name, input) => {
      calls += 1;
      return input;
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'unsupported_syntax');
  assert.match(result.ok ? '' : result.error.message, /Promise\.race/);
});

test('rejects unsupported operators before starting nested tool calls', async () => {
  let calls = 0;
  const result = await executeCodeCell({
    code: 'return (await tools.mutate({ id: "x" })) ** 2;',
    tools: [{ name: 'mutate' }],
    callTool: async () => {
      calls += 1;
      return 2;
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'unsupported_syntax');
  assert.match(result.ok ? '' : result.error.message, /operator.*\*\*/i);
});

test('rejects unsupported callees before starting nested tool calls', async () => {
  let calls = 0;
  const result = await executeCodeCell({
    code: 'return (await tools.mutate({ id: "x" }))();',
    tools: [{ name: 'mutate' }],
    callTool: async () => {
      calls += 1;
      return () => null;
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'unsupported_syntax');
});

test('rejects dangerous static member access before starting nested tool calls', async () => {
  let calls = 0;
  const result = await executeCodeCell({
    code: 'return (await tools.mutate({ id: "x" }))["constructor"];',
    tools: [{ name: 'mutate' }],
    callTool: async () => {
      calls += 1;
      return {};
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'invalid_data');
});

test('rejects dangerous object keys before starting nested tool calls', async () => {
  let calls = 0;
  const result = await executeCodeCell({
    code: 'return { value: await tools.mutate({}), constructor: 1 };',
    tools: [{ name: 'mutate' }],
    callTool: async () => {
      calls += 1;
      return { ok: true };
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'invalid_data');
});

test('provides undefined as an immutable root binding', async () => {
  let calls = 0;
  const result = await executeCodeCell({
    code: 'await tools.mutate({}); return undefined;',
    tools: [{ name: 'mutate' }],
    callTool: async () => {
      calls += 1;
      return { ok: true };
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(result, {
    ok: true,
    value: null,
    toolCalls: [{ index: 1, name: 'mutate' }],
  });
});

test('rejects assignment to undefined before executing any nested call', async () => {
  let calls = 0;
  const result = await executeCodeCell({
    code: 'await tools.write({}); undefined = 1;',
    tools: [{ name: 'write' }],
    callTool: async () => {
      calls += 1;
      return { ok: true };
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'unsupported_syntax');
  assert.match(result.ok ? '' : result.error.message, /reserved interpreter root/i);
});

test('rejects unknown identifiers before executing any nested call', async () => {
  let calls = 0;
  const result = await executeCodeCell({
    code: 'await tools.write({}); return typo;',
    tools: [{ name: 'write' }],
    callTool: async () => {
      calls += 1;
      return { ok: true };
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'execution_error');
  assert.match(result.ok ? '' : result.error.message, /Unknown identifier "typo"/);
});

test('rejects every unknown tool reference before executing any nested call', async () => {
  let calls = 0;
  const result = await executeCodeCell({
    code: 'await tools.write({}); return await tools.typo({});',
    tools: [{ name: 'write' }],
    callTool: async () => {
      calls += 1;
      return { ok: true };
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'unknown_tool');
});

test('rejects aliases for every interpreter root before executing nested calls', async () => {
  for (const root of ['tools', 'Promise', 'JSON', 'Object']) {
    let calls = 0;
    const result = await executeCodeCell({
      code: `const alias = ${root}; await tools.write({}); return alias;`,
      tools: [{ name: 'write' }],
      callTool: async () => {
        calls += 1;
        return { ok: true };
      },
    });

    assert.equal(calls, 0, `${root} alias allowed an earlier tool side effect`);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.error.kind, 'unsupported_syntax');
    assert.match(result.ok ? '' : result.error.message, /interpreter root/i);
  }
});

test('keeps interpreter root names available as ordinary static data keys', async () => {
  const result = await executeCodeCell({
    code: `
      const row = { tools: 1, Promise: 2, JSON: 3, Object: 4 };
      return [row.tools, row.Promise, row.JSON, row.Object];
    `,
    tools: [],
    callTool: async () => null,
  });

  assert.deepEqual(result, { ok: true, value: [1, 2, 3, 4], toolCalls: [] });
});

test('rejects bindings that shadow interpreter roots before executing nested calls', async () => {
  let calls = 0;
  const result = await executeCodeCell({
    code: 'await tools.write({}); { const tools = { typo: 1 }; return tools.typo; }',
    tools: [{ name: 'write' }],
    callTool: async () => {
      calls += 1;
      return { ok: true };
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'unsupported_syntax');
  assert.match(result.ok ? '' : result.error.message, /reserved interpreter root/i);
});

test('rejects dynamic member access before evaluating its object or property', async () => {
  let calls = 0;
  const result = await executeCodeCell({
    code: 'return (await tools.mutate({ id: "x" }))[await tools.key({})];',
    tools: [{ name: 'mutate' }, { name: 'key' }],
    callTool: async () => {
      calls += 1;
      return 'constructor';
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'unsupported_syntax');
});

test('rejects unknown member calls before evaluating their object', async () => {
  let calls = 0;
  const result = await executeCodeCell({
    code: 'return (await tools.mutate({ id: "x" })).dangerous();',
    tools: [{ name: 'mutate' }],
    callTool: async () => {
      calls += 1;
      return {};
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'unsupported_syntax');
});

test('rejects var declarations instead of exposing block-scoped semantics', async () => {
  const result = await executeCodeCell({
    code: 'var value = 1; return value;',
    tools: [],
    callTool: async () => null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'unsupported_syntax');
  assert.match(result.ok ? '' : result.error.message, /declaration kind.*var/i);
});

test('sorts strings with deterministic UTF-16 ordering', async () => {
  const result = await executeCodeCell({
    code: 'return ["ä", "a", "A", "z"].sort();',
    tools: [],
    callTool: async () => null,
  });

  assert.deepEqual(result, {
    ok: true,
    value: ['A', 'a', 'z', 'ä'],
    toolCalls: [],
  });
});

test('keeps undefined values last in default Array.sort ordering', async () => {
  const result = await executeCodeCell({
    code: 'let missing; return [missing, "z", "a"].sort();',
    tools: [],
    callTool: async () => null,
  });

  assert.deepEqual(result, { ok: true, value: ['a', 'z', null], toolCalls: [] });
});

test('checks wall time while Array.sort prepares string keys', async () => {
  const values = Array.from({ length: 8_000 }, (_value, index) => `${'x'.repeat(256)}${index}`);
  const result = await executeCodeCell({
    code: 'return (await tools.load({})).sort();',
    tools: [{ name: 'load' }],
    callTool: async () => values,
    limits: {
      maxWallTimeMs: 1,
      maxResultBytes: 4 * 1024 * 1024,
      maxOutputBytes: 4 * 1024 * 1024,
      maxIntermediateBytes: 4 * 1024 * 1024,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  assert.match(result.ok ? '' : result.error.message, /wall-time/i);
});

test('keeps uninitialized let values as undefined until the output boundary', async () => {
  const result = await executeCodeCell({
    code: 'let value; return { isNull: value === null, kind: typeof value, fallback: value ?? "fallback" };',
    tools: [],
    callTool: async () => null,
  });

  assert.deepEqual(result, {
    ok: true,
    value: { isNull: false, kind: 'undefined', fallback: 'fallback' },
    toolCalls: [],
  });
});

test('treats an undefined Array.join separator as omitted', async () => {
  const result = await executeCodeCell({
    code: 'let separator; return ["a", "b"].join(separator);',
    tools: [],
    callTool: async () => null,
  });

  assert.deepEqual(result, { ok: true, value: 'a,b', toolCalls: [] });
});

test('allows tool names that overlap with restricted data methods', async () => {
  const result = await executeCodeCell({
    code: 'return await tools.sort({ id: "x" });',
    tools: [{ name: 'sort' }],
    callTool: async (_name, input) => input,
  });

  assert.deepEqual(result, {
    ok: true,
    value: { id: 'x' },
    toolCalls: [{ index: 1, name: 'sort' }],
  });
});

test('maps plain data through closures without exposing host array methods', async () => {
  const result = await executeCodeCell({
    code: `
      const ids: string[] = ["a", "b"];
      const rows = await Promise.all(
        ids.map(async (id) => tools.lookup({ id }))
      );
      return rows.map((row) => row.id);
    `,
    tools: [{ name: 'lookup' }],
    callTool: async (_name, input) => input,
  });

  assert.deepEqual(result, {
    ok: true,
    value: ['a', 'b'],
    toolCalls: [
      { index: 1, name: 'lookup' },
      { index: 2, name: 'lookup' },
    ],
  });
});

test('supports common control flow and plain-data transformations', async () => {
  const result = await executeCodeCell({
    code: `
      const rows = [
        { id: "a", score: 1 },
        { id: "b", score: 2 },
        { id: "c", score: 3 }
      ];
      let total = 0;
      const labels = [];
      for (const { id, score } of rows) {
        if (score < 2) continue;
        total += score;
        labels.push(\`${'${id}'}:${'${score}'}\`);
      }
      const [first, ...rest] = labels;
      const selected = rows
        .filter(({ score }) => score >= 2)
        .map(({ id }) => id);
      const summary = { total, selected };
      return {
        ...summary,
        labels: [...labels, "done"],
        first,
        rest,
        status: total === 5 && selected.length === 2 ? "ok" : "bad"
      };
    `,
    tools: [],
    callTool: async () => {
      throw new Error('not called');
    },
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      total: 5,
      selected: ['b', 'c'],
      labels: ['b:2', 'c:3', 'done'],
      first: 'b:2',
      rest: ['c:3'],
      status: 'ok',
    },
    toolCalls: [],
  });
});

test('iterates an empty string as zero for-of values', async () => {
  const result = await executeCodeCell({
    code: 'let count = 0; for (const value of "") count += 1; return count;',
    tools: [],
    callTool: async () => null,
  });

  assert.deepEqual(result, { ok: true, value: 0, toolCalls: [] });
});

test('counts Unicode string spread elements by code point', async () => {
  const result = await executeCodeCell({
    code: 'return [..."😀"];',
    tools: [],
    callTool: async () => null,
    limits: { maxCollectionItems: 1 },
  });

  assert.deepEqual(result, { ok: true, value: ['😀'], toolCalls: [] });
});

test('counts only unique keys when object spread overwrites a property', async () => {
  const result = await executeCodeCell({
    code: 'return { a: 0, ...{ a: 1 } };',
    tools: [],
    callTool: async () => null,
    limits: { maxCollectionItems: 1 },
  });

  assert.deepEqual(result, { ok: true, value: { a: 1 }, toolCalls: [] });
});

test('supports optional chaining and destructuring defaults', async () => {
  const result = await executeCodeCell({
    code: `
      const { name = "unknown", tags = [] } = await tools.lookup({ id: "a" });
      const missing = null;
      return {
        name: name?.trim()?.toLowerCase() ?? "unknown",
        tags,
        fallback: missing?.value?.trim() ?? "none"
      };
    `,
    tools: [{ name: 'lookup' }],
    callTool: async () => ({ name: ' Ada ' }),
  });

  assert.deepEqual(result, {
    ok: true,
    value: { name: 'ada', tags: [], fallback: 'none' },
    toolCalls: [{ index: 1, name: 'lookup' }],
  });
});

test('preserves the String.split limit argument', async () => {
  const result = await executeCodeCell({
    code: 'return "a,b,c".split(",", 2);',
    tools: [],
    callTool: async () => null,
  });

  assert.deepEqual(result, { ok: true, value: ['a', 'b'], toolCalls: [] });
});

test('treats an undefined String.split separator as omitted', async () => {
  const result = await executeCodeCell({
    code: 'let separator; return "aundefinedb".split(separator);',
    tools: [],
    callTool: async () => null,
  });

  assert.deepEqual(result, { ok: true, value: ['aundefinedb'], toolCalls: [] });
});

test('rejects regular-expression String.split separators explicitly', async () => {
  const result = await executeCodeCell({
    code: String.raw`return "a1b2c".split(/\d/);`,
    tools: [],
    callTool: async () => null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'unsupported_syntax');
  assert.match(result.ok ? '' : result.error.message, /regular expression/i);
});

test('preserves the supported String.substring method', async () => {
  const result = await executeCodeCell({
    code: 'return "abcdef".substring(1, 4);',
    tools: [],
    callTool: async () => null,
  });

  assert.deepEqual(result, { ok: true, value: 'bcd', toolCalls: [] });
});

test('indexes strings with JavaScript UTF-16 code-unit semantics', async () => {
  const result = await executeCodeCell({
    code: 'return ["abc"[1], "😀"[0].length];',
    tools: [],
    callTool: async () => null,
  });

  assert.deepEqual(result, { ok: true, value: ['b', 1], toolCalls: [] });
});

test('does not overestimate sparse String.split results', async () => {
  const result = await executeCodeCell({
    code: 'return (await tools.load({})).split("\\n").length;',
    tools: [{ name: 'load' }],
    callTool: async () => 'x'.repeat(100_001),
  });

  assert.deepEqual(result, {
    ok: true,
    value: 1,
    toolCalls: [{ index: 1, name: 'load' }],
  });
});

test('catches tool failures and uses allowlisted data helpers', async () => {
  const result = await executeCodeCell({
    code: `
      let failure = null;
      try {
        await tools.lookup({ id: "missing" });
      } catch ({ message }) {
        failure = message;
      }
      const parsed = JSON.parse('{"name":" Ada ","scores":[3,1,2]}');
      const keys = Object.keys(parsed).sort();
      const metadata = Object.fromEntries(
        Object.entries(parsed).filter(([key]) => key !== "scores")
      );
      return {
        failure,
        name: parsed.name.trim().toLowerCase(),
        keys: keys.join(","),
        containsName: parsed.name.includes("Ada"),
        metadata: JSON.stringify(metadata)
      };
    `,
    tools: [{ name: 'lookup' }],
    callTool: async () => {
      throw new Error('not found');
    },
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      failure: 'Tool lookup failed: not found',
      name: 'ada',
      keys: 'name,scores',
      containsName: true,
      metadata: '{"name":" Ada "}',
    },
    toolCalls: [{ index: 1, name: 'lookup' }],
  });
});

test('runs bounded for and while loops with update expressions', async () => {
  const result = await executeCodeCell({
    code: `
      let total = 0;
      for (let index = 0; index < 5; index++) {
        if (index === 1) continue;
        total += index;
      }
      let remaining = 2;
      while (remaining > 0) {
        total++;
        remaining--;
      }
      return total;
    `,
    tools: [],
    callTool: async () => null,
  });

  assert.deepEqual(result, { ok: true, value: 11, toolCalls: [] });
});

test('checks the collection cap before iterating a tool-returned string', async () => {
  const result = await executeCodeCell({
    code: `
      let count = 0;
      for (const character of await tools.load({})) count += character.length;
      return count;
    `,
    tools: [{ name: 'load' }],
    callTool: async () => 'abc',
    limits: { maxCollectionItems: 2 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  assert.match(result.ok ? '' : result.error.message, /for\.\.\.of item limit/i);
});

test('preempts a pure compute loop at the interpreter step limit', async () => {
  const result = await executeCodeCell({
    code: 'while (true) {}',
    tools: [],
    callTool: async () => null,
    limits: { maxSteps: 20 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  assert.match(result.ok ? '' : result.error.message, /step limit/i);
});

test('supervises an unawaited tool call before the cell settles', async () => {
  let completed = false;
  const result = await executeCodeCell({
    code: `
      tools.lookup({ id: "background" });
      return "done";
    `,
    tools: [{ name: 'lookup' }],
    callTool: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      completed = true;
      return { ok: true };
    },
  });

  assert.equal(completed, true);
  assert.deepEqual(result, {
    ok: true,
    value: 'done',
    toolCalls: [{ index: 1, name: 'lookup' }],
  });
});

test('aborts a pending tool call when the cell wall-time limit expires', async () => {
  let aborted = false;
  const result = await executeCodeCell({
    code: 'return await tools.lookup({ id: "slow" });',
    tools: [{ name: 'lookup' }],
    callTool: async (_name, _input, signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ tooLate: true }), 100);
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
    limits: { maxWallTimeMs: 10 },
  });

  assert.equal(aborted, true);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  assert.match(result.ok ? '' : result.error.message, /wall-time/i);
});

test('does not allow cell code to catch and suppress a wall-time limit', async () => {
  const result = await executeCodeCell({
    code: `
      try {
        return await tools.lookup({ id: "slow" });
      } catch {
        return "suppressed";
      }
    `,
    tools: [{ name: 'lookup' }],
    callTool: async (_name, _input, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    limits: { maxWallTimeMs: 10 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
});

test('does not allow Promise.allSettled to suppress a wall-time limit', async () => {
  const result = await executeCodeCell({
    code: 'return await Promise.allSettled([tools.lookup({ id: "slow" })]);',
    tools: [{ name: 'lookup' }],
    callTool: async (_name, _input, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    limits: { maxWallTimeMs: 10 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
});

for (const [name, code] of [
  ['process', 'return process;'],
  ['require', 'return require("node:fs");'],
  ['globalThis', 'return globalThis;'],
  ['console', 'return console.log("leak");'],
  ['timers', 'return setTimeout(() => null, 1);'],
  ['eval', 'return eval("1 + 1");'],
  ['Function', 'return Function("return 1")();'],
  ['dynamic import', 'return import("node:fs");'],
  ['this', 'return this;'],
] as const) {
  test(`does not expose ${name}`, async () => {
    const result = await executeCodeCell({
      code,
      tools: [],
      callTool: async () => null,
    });

    assert.equal(result.ok, false);
  });
}

test('rejects host object identity at the tool boundary', async () => {
  const result = await executeCodeCell({
    code: 'return await tools.lookup({});',
    tools: [{ name: 'lookup' }],
    callTool: async () => new Date(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'invalid_data');
  assert.match(result.ok ? '' : result.error.message, /host object/i);
});

test('bounds nested tool arguments before publishing an oversized payload', async () => {
  let calls = 0;
  const result = await executeCodeCell({
    code: `
      let value = [0];
      for (let index = 0; index < 10; index++) value = [value, value];
      return await tools.lookup(value);
    `,
    tools: [{ name: 'lookup' }],
    callTool: async () => {
      calls += 1;
      return null;
    },
    limits: { maxIntermediateBytes: 64 },
  });

  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  assert.match(result.ok ? '' : result.error.message, /tool arguments byte limit/i);
});

test('blocks prototype and constructor traversal', async () => {
  const result = await executeCodeCell({
    code: 'return ({ value: 1 }).constructor;',
    tools: [],
    callTool: async () => null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'invalid_data');
});

test('bounds synchronous string growth before allocating an oversized value', async () => {
  const result = await executeCodeCell({
    code: `
      let value = "x";
      for (let index = 0; index < 21; index++) value += value;
      return value.length;
    `,
    tools: [],
    callTool: async () => null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
});

test('bounds amplified Array.join output at the intermediate byte limit', async () => {
  const values = Array.from({ length: 1_024 }, () => 'x'.repeat(128));
  const result = await executeCodeCell({
    code: 'return (await tools.load({})).join("");',
    tools: [{ name: 'load' }],
    callTool: async () => values,
    limits: { maxIntermediateBytes: 64, maxResultBytes: 512 * 1_024 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  assert.match(result.ok ? '' : result.error.message, /Array\.join byte limit/i);
});

test('bounds amplified JSON.stringify output at the intermediate byte limit', async () => {
  const values = Array.from({ length: 1_024 }, () => '\0'.repeat(128));
  const result = await executeCodeCell({
    code: 'return JSON.stringify(await tools.load({}));',
    tools: [{ name: 'load' }],
    callTool: async () => values,
    limits: { maxIntermediateBytes: 64, maxResultBytes: 1_024 * 1_024 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  assert.match(result.ok ? '' : result.error.message, /JSON\.stringify byte limit/i);
});

test('omits undefined object properties in JSON.stringify', async () => {
  const result = await executeCodeCell({
    code: 'let missing; return JSON.stringify({ a: missing, b: 1 });',
    tools: [],
    callTool: async () => null,
  });

  assert.deepEqual(result, { ok: true, value: '{"b":1}', toolCalls: [] });
});

test('bounds amplified template interpolation at the intermediate byte limit', async () => {
  const values = Array.from({ length: 1_024 }, () => 'x'.repeat(128));
  const result = await executeCodeCell({
    code: 'return `${await tools.load({})}`;',
    tools: [{ name: 'load' }],
    callTool: async () => values,
    limits: { maxIntermediateBytes: 64, maxResultBytes: 512 * 1_024 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  assert.match(result.ok ? '' : result.error.message, /Template interpolation byte limit/i);
});

test('bounds collection amplification before splitting into too many items', async () => {
  const result = await executeCodeCell({
    code: `
      let value = "x";
      for (let index = 0; index < 17; index++) value += value;
      return value.split("").length;
    `,
    tools: [],
    callTool: async () => null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
});

test('bounds cumulative output traversal for shared DAGs', async () => {
  const result = await executeCodeCell({
    code: `
      let value = [0];
      for (let index = 0; index < 18; index++) value = [value, value];
      return value;
    `,
    tools: [],
    callTool: async () => null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  assert.match(result.ok ? '' : result.error.message, /traversal/i);
});

test('keeps traversal budget independent from per-collection item limits', async () => {
  const result = await executeCodeCell({
    code: 'return { a: { a: 1 } };',
    tools: [],
    callTool: async () => null,
    limits: { maxCollectionItems: 1 },
  });

  assert.deepEqual(result, {
    ok: true,
    value: { a: { a: 1 } },
    toolCalls: [],
  });
});

test('checks wall time while Object.fromEntries processes duplicate keys', async () => {
  const duplicateEntries = Array.from({ length: 90_000 }, () => ['same', 1]);
  const result = await executeCodeCell({
    code: 'return Object.fromEntries(await tools.load({}));',
    tools: [{ name: 'load' }],
    callTool: async () => duplicateEntries,
    limits: { maxWallTimeMs: 1, maxResultBytes: 8 * 1024 * 1024 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  assert.match(result.ok ? '' : result.error.message, /wall-time/i);
});

test('bounds aggregate Array.map callback results before retaining them', async () => {
  const result = await executeCodeCell({
    code: `
      const seed = await tools.load({});
      return "ab".split("").map(() => seed + seed);
    `,
    tools: [{ name: 'load' }],
    callTool: async () => 'x'.repeat(30),
    limits: { maxIntermediateBytes: 64 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  assert.match(result.ok ? '' : result.error.message, /Array\.map byte limit/i);
});

test('bounds the values retained by Array.filter rather than its predicates', async () => {
  const result = await executeCodeCell({
    code: `
      const seed = await tools.load({});
      const values = [seed, seed].filter(() => true);
      return values.length;
    `,
    tools: [{ name: 'load' }],
    callTool: async () => 'x'.repeat(30),
    limits: { maxIntermediateBytes: 50, maxResultBytes: 100 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  assert.match(result.ok ? '' : result.error.message, /Array\.filter byte limit/i);
});

test('bounds collection-producing array and object helpers', async () => {
  const largeArray = Array.from({ length: 100_001 }, () => 0);
  const spreadResult = await executeCodeCell({
    code: 'const values = await tools.load({}); return [...values].length;',
    tools: [{ name: 'load' }],
    callTool: async () => largeArray,
  });
  assert.equal(spreadResult.ok, false);
  assert.equal(spreadResult.ok ? undefined : spreadResult.error.kind, 'limit_exceeded');

  const mapResult = await executeCodeCell({
    code: 'const values = await tools.load({}); return values.map((value) => value).length;',
    tools: [{ name: 'load' }],
    callTool: async () => largeArray,
  });
  assert.equal(mapResult.ok, false);
  assert.equal(mapResult.ok ? undefined : mapResult.error.kind, 'limit_exceeded');

  const largeRecord = Object.fromEntries(
    Array.from({ length: 100_001 }, (_value, index) => [`key${index}`, index]),
  );
  const keysResult = await executeCodeCell({
    code: 'return Object.keys(await tools.load({})).length;',
    tools: [{ name: 'load' }],
    callTool: async () => largeRecord,
    limits: { maxResultBytes: 8 * 1024 * 1024 },
  });
  assert.equal(keysResult.ok, false);
  assert.equal(keysResult.ok ? undefined : keysResult.error.kind, 'limit_exceeded');
});

test('enforces source, call, concurrency, result, and output byte limits', async (t) => {
  await t.test('source bytes', async () => {
    const result = await executeCodeCell({
      code: 'return "too large";',
      tools: [],
      callTool: async () => null,
      limits: { maxSourceBytes: 4 },
    });
    assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  });

  await t.test('tool calls', async () => {
    const result = await executeCodeCell({
      code: `
        await tools.lookup({ id: 1 });
        return await tools.lookup({ id: 2 });
      `,
      tools: [{ name: 'lookup' }],
      callTool: async (_name, input) => input,
      limits: { maxToolCalls: 1 },
    });
    assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  });

  await t.test('concurrency', async () => {
    const result = await executeCodeCell({
      code: 'return await Promise.all([tools.lookup({ id: 1 }), tools.lookup({ id: 2 })]);',
      tools: [{ name: 'lookup' }],
      callTool: async (_name, input) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return input;
      },
      limits: { maxConcurrency: 1 },
    });
    assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  });

  await t.test('tool result bytes', async () => {
    const result = await executeCodeCell({
      code: 'return await tools.lookup({});',
      tools: [{ name: 'lookup' }],
      callTool: async () => ({ text: 'too large' }),
      limits: { maxResultBytes: 4 },
    });
    assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  });

  await t.test('tool result bytes use the serialized representation', async () => {
    const result = await executeCodeCell({
      code: 'return await tools.lookup({});',
      tools: [{ name: 'lookup' }],
      callTool: async () => '\0'.repeat(10),
      limits: { maxResultBytes: 32 },
    });
    assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  });

  await t.test('output bytes', async () => {
    const result = await executeCodeCell({
      code: 'return { text: "too large" };',
      tools: [],
      callTool: async () => null,
      limits: { maxOutputBytes: 4 },
    });
    assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
  });

  await t.test('output bytes stop amplified serialization at the configured limit', async () => {
    const repeated = Array.from({ length: 1_024 }, () => '\0'.repeat(128));
    const result = await executeCodeCell({
      code: 'return await tools.lookup({});',
      tools: [{ name: 'lookup' }],
      callTool: async () => repeated,
      limits: { maxResultBytes: 1_024 * 1_024, maxOutputBytes: 64 },
    });
    assert.equal(result.ok ? undefined : result.error.kind, 'limit_exceeded');
    assert.match(result.ok ? '' : result.error.message, /output byte limit/i);
  });
});

test('fails the cell when an unawaited owned tool call rejects', async () => {
  const result = await executeCodeCell({
    code: 'tools.lookup({}); return "premature";',
    tools: [{ name: 'lookup' }],
    callTool: async () => {
      throw new Error('background failure');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, 'tool_failure');
});

test('propagates an external abort and terminates the owned tool call', async () => {
  const controller = new AbortController();
  let toolAborted = false;
  let markToolStarted: (() => void) | undefined;
  const toolStarted = new Promise<void>((resolve) => {
    markToolStarted = resolve;
  });
  const execution = executeCodeCell({
    code: 'return await tools.lookup({});',
    tools: [{ name: 'lookup' }],
    signal: controller.signal,
    callTool: async (_name, _input, signal) =>
      new Promise((_resolve, reject) => {
        markToolStarted?.();
        signal.addEventListener(
          'abort',
          () => {
            toolAborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  });
  await toolStarted;
  controller.abort(Object.assign(new Error('stopped'), { name: 'AbortError' }));

  await assert.rejects(execution, { name: 'AbortError', message: 'stopped' });
  assert.equal(toolAborted, true);
});

test('waits for an aborted host tool operation to settle before rejecting the cell', async () => {
  const controller = new AbortController();
  let markToolStarted: (() => void) | undefined;
  const toolStarted = new Promise<void>((resolve) => {
    markToolStarted = resolve;
  });
  let releaseTool: (() => void) | undefined;
  const toolRelease = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  let toolSettled = false;
  const execution = executeCodeCell({
    code: 'return await tools.lookup({});',
    tools: [{ name: 'lookup' }],
    signal: controller.signal,
    callTool: async (_name, _input, signal) => {
      markToolStarted?.();
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      await toolRelease;
      toolSettled = true;
      throw signal.reason;
    },
  });
  let cellSettled = false;
  const outcome = execution.then(
    () => 'fulfilled',
    () => 'rejected',
  );
  void outcome.then(() => {
    cellSettled = true;
  });

  await toolStarted;
  controller.abort(Object.assign(new Error('stopped'), { name: 'AbortError' }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledBeforeTool = cellSettled;
  releaseTool?.();

  assert.equal(await outcome, 'rejected');
  assert.equal(settledBeforeTool, false);
  assert.equal(toolSettled, true);
});

test('propagates a fatal error discovered while draining a host tool operation', async () => {
  const fatalError = new Error('nested durable commit failed');
  const execution = executeCodeCell({
    code: 'tools.lookup({}); throw "cell failed";',
    tools: [{ name: 'lookup' }],
    callTool: async (_name, _input, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            setImmediate(() => reject(fatalError));
          },
          { once: true },
        );
      }),
    isFatalToolError: (error) => error === fatalError,
  });

  await assert.rejects(execution, (error) => error === fatalError);
});

test('does not allow cell code to catch and suppress a fatal tool failure', async () => {
  const fatalError = new Error('nested durable commit failed');
  const execution = executeCodeCell({
    code: `
      try {
        await tools.lookup({});
      } catch {
        return "suppressed";
      }
    `,
    tools: [{ name: 'lookup' }],
    callTool: async () => {
      throw fatalError;
    },
    isFatalToolError: (error) => error === fatalError,
  });

  await assert.rejects(execution, (error) => error === fatalError);
});

test('does not start later nested tools after a fatal failure is caught', async () => {
  const fatalError = new Error('nested durable commit failed');
  const calls: string[] = [];
  const execution = executeCodeCell({
    code: `
      try { await tools.first({}); } catch {}
      try { await tools.second({}); } catch {}
      return "suppressed";
    `,
    tools: [{ name: 'first' }, { name: 'second' }],
    callTool: async (name) => {
      calls.push(name);
      if (name === 'first') throw fatalError;
      return { ok: true };
    },
    isFatalToolError: (error) => error === fatalError,
  });

  await assert.rejects(execution, (error) => error === fatalError);
  assert.deepEqual(calls, ['first']);
});
