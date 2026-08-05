import assert from 'node:assert/strict';
import test from 'node:test';
import type { BotIncomingMessage } from '@maka/runtime';
import type {
  DesktopRuntimeHostCandidate,
  DesktopRuntimeHostCandidateStartInput,
  DesktopRuntimeHostCandidateStartResult,
} from '../runtime-host-desktop-candidate.js';
import { startRuntimeHostDesktopOwner } from '../runtime-host-desktop-owner.js';

test('replaces a disconnected generation without falling back to embedded Runtime', async () => {
  const first = candidateHarness();
  const second = candidateHarness();
  const queue = [ready(first.candidate), ready(second.candidate)];
  let starts = 0;
  const owner = await startRuntimeHostDesktopOwner({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async () => {
      starts += 1;
      const result = queue.shift();
      assert.ok(result);
      return result;
    },
  });

  first.disconnect();
  await eventually(() => starts === 2);
  await owner.handleBotIncomingMessage({ text: 'hello' } as BotIncomingMessage);
  await owner.stopSession('session-1');

  assert.equal(first.botMessages, 0);
  assert.equal(second.botMessages, 1);
  assert.deepEqual(second.stoppedSessions, ['session-1']);
  await owner.close();
  assert.equal(second.closeCalls, 1);
});

test('reports exhausted reconnect attempts as fatal and never starts a fallback', async () => {
  const first = candidateHarness();
  let starts = 0;
  let fatal: Error | undefined;
  const owner = await startRuntimeHostDesktopOwner({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async (): Promise<DesktopRuntimeHostCandidateStartResult> => {
      starts += 1;
      return starts === 1
        ? ready(first.candidate)
        : { kind: 'failed', reason: 'host_unresponsive' };
    },
    onFatalError: (error) => {
      fatal = error;
    },
  });

  first.disconnect();
  await eventually(() => fatal !== undefined, 2_000);
  assert.equal(starts, 4);
  assert.match(fatal?.message ?? '', /host_unresponsive/);
  await owner.close();
});

function candidateHarness() {
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closeCalls = 0;
  let botMessages = 0;
  const stoppedSessions: string[] = [];
  const candidate = {
    closed,
    client: {},
    botIncoming: {
      async handleBotIncomingMessage() {
        botMessages += 1;
      },
    },
    async close() {
      closeCalls += 1;
      resolveClosed?.();
    },
    async stopSession(sessionId: string) {
      stoppedSessions.push(sessionId);
    },
  } as unknown as DesktopRuntimeHostCandidate;
  return {
    candidate,
    disconnect: () => resolveClosed?.(),
    get closeCalls() {
      return closeCalls;
    },
    get botMessages() {
      return botMessages;
    },
    get stoppedSessions() {
      return stoppedSessions;
    },
  };
}

function ready(candidate: DesktopRuntimeHostCandidate): DesktopRuntimeHostCandidateStartResult {
  return { kind: 'ready', candidate };
}

async function eventually(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
