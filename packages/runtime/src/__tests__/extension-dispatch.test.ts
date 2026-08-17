import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchExtensionHandlers } from '../extension-dispatch.js';

test('dispatches transform, bail, serial, and contained failures deterministically', async () => {
  const signal = new AbortController().signal;
  const transform = await dispatchExtensionHandlers({
    mode: 'transform',
    payload: { count: 1 },
    signal,
    handlers: [
      {
        identity: 'a',
        invoke: async (value) => ({ count: (value as { count: number }).count + 1 }),
      },
      { identity: 'bad', invoke: async () => await Promise.reject(new Error('contained')) },
      {
        identity: 'b',
        invoke: async (value) => ({ count: (value as { count: number }).count * 3 }),
      },
    ],
  });
  assert.deepEqual(transform.value, { count: 6 });
  assert.deepEqual(
    transform.settlements.map(({ status }) => status),
    ['fulfilled', 'rejected', 'fulfilled'],
  );

  const bail = await dispatchExtensionHandlers({
    mode: 'bail',
    payload: {},
    signal,
    handlers: [
      { identity: 'empty', invoke: async () => undefined },
      { identity: 'answer', invoke: async () => ({ answer: 42 }) },
      { identity: 'unreached', invoke: async () => ({ answer: 0 }) },
    ],
  });
  assert.deepEqual(bail.value, { answer: 42 });
  assert.equal(bail.stopped, true);
  assert.deepEqual(
    bail.settlements.map(({ identity }) => identity),
    ['empty', 'answer'],
  );

  const serial = await dispatchExtensionHandlers({
    mode: 'serial',
    payload: { id: 'x' },
    signal,
    handlers: [
      { identity: 1, invoke: async () => 'one' },
      { identity: 2, invoke: async () => 'two' },
    ],
  });
  assert.deepEqual(serial.value, ['one', 'two']);
});

test('parallel dispatch overlaps handlers and gate stops at first denial', async () => {
  const signal = new AbortController().signal;
  let active = 0;
  let peak = 0;
  const parallel = await dispatchExtensionHandlers({
    mode: 'parallel',
    payload: { id: 1 },
    signal,
    handlers: [1, 2, 3].map((identity) => ({
      identity,
      invoke: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return identity;
      },
    })),
  });
  assert.equal(peak, 3);
  assert.deepEqual(parallel.value, [1, 2, 3]);

  const gate = await dispatchExtensionHandlers({
    mode: 'gate',
    payload: {},
    signal,
    handlers: [
      { identity: 'allow', invoke: async () => ({ decision: 'allow' }) },
      { identity: 'deny', invoke: async () => ({ decision: 'deny', reason: 'blocked' }) },
      { identity: 'unreached', invoke: async () => ({ decision: 'allow' }) },
    ],
  });
  assert.equal(gate.denied, true);
  assert.equal(gate.reason, 'blocked');
  assert.deepEqual(
    gate.settlements.map(({ identity }) => identity),
    ['allow', 'deny'],
  );
});

test('every mode has a deterministic empty-handler identity', async () => {
  const signal = new AbortController().signal;
  const payload = { value: 7 };
  const expected = new Map<string, unknown>([
    ['emit', payload],
    ['parallel', []],
    ['serial', []],
    ['bail', undefined],
    ['transform', payload],
    ['observe', payload],
    ['gate', payload],
  ]);

  for (const [mode, value] of expected) {
    const result = await dispatchExtensionHandlers({
      mode: mode as Parameters<typeof dispatchExtensionHandlers>[0]['mode'],
      payload,
      signal,
      handlers: [],
    });
    assert.deepEqual(result.value, value, `${mode} returned the wrong identity`);
    assert.deepEqual(result.settlements, []);
    assert.equal(result.stopped, false);
    assert.equal(result.denied, false);
  }
});

test('bail ignores empty and failed answers, then stops on the first value', async () => {
  const invoked: string[] = [];
  const result = await dispatchExtensionHandlers({
    mode: 'bail',
    payload: { question: 'answer' },
    signal: new AbortController().signal,
    handlers: [
      {
        identity: 'undefined',
        invoke: async () => {
          invoked.push('undefined');
          return undefined;
        },
      },
      {
        identity: 'failed',
        invoke: async () => {
          invoked.push('failed');
          throw new Error('contained');
        },
      },
      {
        identity: 'answer',
        invoke: async () => {
          invoked.push('answer');
          return { value: 42 };
        },
      },
      {
        identity: 'unreached',
        invoke: async () => {
          invoked.push('unreached');
          return { value: 0 };
        },
      },
    ],
  });

  assert.deepEqual(invoked, ['undefined', 'failed', 'answer']);
  assert.deepEqual(result.value, { value: 42 });
  assert.equal(result.stopped, true);
  assert.deepEqual(
    result.settlements.map(({ status }) => status),
    ['fulfilled', 'rejected', 'fulfilled'],
  );
});

test('dispatch clones handler inputs and propagates cancellation authority', async () => {
  const payload = { nested: { value: 1 } };
  const isolated = await dispatchExtensionHandlers({
    mode: 'serial',
    payload,
    signal: new AbortController().signal,
    handlers: [
      {
        identity: 'mutator',
        invoke: async (value) => {
          (value as typeof payload).nested.value = 99;
          return 'mutated-private-copy';
        },
      },
      {
        identity: 'observer',
        invoke: async (value) => (value as typeof payload).nested.value,
      },
    ],
  });
  assert.deepEqual(payload, { nested: { value: 1 } });
  assert.deepEqual(isolated.value, ['mutated-private-copy', 1]);

  const controller = new AbortController();
  await assert.rejects(
    dispatchExtensionHandlers({
      mode: 'serial',
      payload,
      signal: controller.signal,
      handlers: [
        {
          identity: 'abort',
          invoke: async () => {
            controller.abort(new Error('authority revoked'));
            return 'ignored';
          },
        },
        { identity: 'unreached', invoke: async () => 'unreached' },
      ],
    }),
    /authority revoked/u,
  );
});
