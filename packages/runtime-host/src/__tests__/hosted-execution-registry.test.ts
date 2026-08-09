import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HostedExecutionRef } from '../server/hosted-execution-authority.js';
import { HostedExecutionRegistry } from '../server/hosted-execution-registry.js';

test('Hosted Execution registry makes replacement and stale release explicit', () => {
  const registry = new HostedExecutionRegistry<HostedExecutionRef>();
  const first = execution('run-first');
  const replacement = execution('run-replacement');

  registry.activate(first);
  assert.throws(() => registry.activate(replacement), /already has an active hosted execution/);
  assert.equal(registry.get(first.sessionId), first);

  registry.activate(replacement, first);
  assert.equal(registry.release(first), false);
  assert.equal(registry.get(first.sessionId), replacement);
  assert.equal(registry.release(replacement), true);
  assert.equal(registry.size, 0);
});

test('Hosted Execution listeners are isolated and receive immutable identity hints', () => {
  const registry = new HostedExecutionRegistry<HostedExecutionRef>();
  const received: HostedExecutionRef[] = [];
  registry.subscribe(() => {
    throw new Error('observer failure');
  });
  const unsubscribe = registry.subscribe((execution) => received.push(execution));

  registry.publish(execution('run-published'));
  unsubscribe();
  registry.publish(execution('run-ignored'));

  assert.equal(received.length, 1);
  assert.equal(received[0]?.runId, 'run-published');
  assert.equal(Object.isFrozen(received[0]), true);
});

function execution(runId: string): HostedExecutionRef {
  return { sessionId: 'session-registry', turnId: `turn-${runId}`, runId };
}
