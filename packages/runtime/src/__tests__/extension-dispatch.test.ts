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
