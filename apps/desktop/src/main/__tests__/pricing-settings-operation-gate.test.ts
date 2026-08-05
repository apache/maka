import assert from 'node:assert/strict';
import test from 'node:test';
import { PricingSettingsOperationGate } from '../../renderer/settings/pricing-settings-operation-gate.js';

test('Pricing Settings serializes reads and writes through one operation gate', () => {
  const gate = new PricingSettingsOperationGate();
  const read = gate.begin('read');
  assert.ok(read);
  assert.equal(gate.activeKind, 'read');
  assert.equal(gate.begin('write'), null);

  assert.equal(gate.finish(read), true);
  const write = gate.begin('write');
  assert.ok(write);
  assert.equal(gate.begin('read'), null);
  assert.equal(gate.finish(write), true);
  assert.equal(gate.activeKind, null);
});

test('a late read from a replaced Pricing port cannot overwrite new authority', async () => {
  const gate = new PricingSettingsOperationGate();
  const oldResponse = deferred<string>();
  const newResponse = deferred<string>();
  const committed: string[] = [];

  const oldRead = captureCurrent(gate, oldResponse.promise, committed);
  gate.replacePort();
  const newRead = captureCurrent(gate, newResponse.promise, committed);

  newResponse.resolve('new-port');
  await newRead;
  oldResponse.resolve('old-port');
  await oldRead;

  assert.deepEqual(committed, ['new-port']);
  assert.equal(gate.activeKind, null);
});

async function captureCurrent(
  gate: PricingSettingsOperationGate,
  response: Promise<string>,
  committed: string[],
): Promise<void> {
  const token = gate.begin('read');
  assert.ok(token);
  const value = await response;
  if (gate.isCurrent(token)) committed.push(value);
  gate.finish(token);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
