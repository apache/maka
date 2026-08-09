import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  HostedExecutionCompletion,
  HostedExecutionListener,
  HostedExecutionRef,
  HostedExecutionSnapshot,
} from '../server/hosted-execution-authority.js';
import { waitForHostedExecutionTerminal } from '../server/hosted-execution-wait.js';

test('Hosted Execution wait rejects an authority failure after the active owner is released', async () => {
  const execution: HostedExecutionRef = {
    sessionId: 'session-wait',
    turnId: 'turn-wait',
    runId: 'run-wait',
  };
  const running = snapshot(execution, 'running');
  let settleCompletion!: (completion: HostedExecutionCompletion) => void;
  const completion = new Promise<HostedExecutionCompletion>((resolve) => {
    settleCompletion = resolve;
  });
  const listeners = new Set<HostedExecutionListener>();
  const waiting = waitForHostedExecutionTerminal(
    {
      reconcile: async () => running,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    execution,
    running,
    { completion },
  );

  settleCompletion({
    kind: 'authority_error',
    execution,
    reason: 'terminal authority write failed',
  });

  await assert.rejects(waiting, /terminal authority write failed/u);
  assert.equal(listeners.size, 0);
});

function snapshot(
  execution: HostedExecutionRef,
  status: Extract<HostedExecutionSnapshot['status'], 'running'>,
): HostedExecutionSnapshot {
  return {
    ...execution,
    status,
  };
}
