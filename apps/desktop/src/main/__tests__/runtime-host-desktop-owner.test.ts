import assert from 'node:assert/strict';
import test from 'node:test';
import type { BotIncomingMessage } from '@maka/runtime';
import type {
  DesktopRuntimeHostCandidate,
  DesktopRuntimeHostCandidateStartInput,
  DesktopRuntimeHostCandidateStartResult,
} from '../runtime-host-desktop-candidate.js';
import { startRuntimeHostDesktopOwner } from '../runtime-host-desktop-owner.js';

test('replaces a disconnected generation without falling back to embedded Runtime', { timeout: 10_000 }, async () => {
  const first = candidateHarness({ delayDisconnect: true });
  const second = candidateHarness();
  const queue = [ready(first.candidate), ready(second.candidate)];
  let starts = 0;
  let resolveSecondStart!: () => void;
  let releaseSecond!: () => void;
  const secondStarted = new Promise<void>((resolve) => {
    resolveSecondStart = resolve;
  });
  const secondReleased = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const owner = await startRuntimeHostDesktopOwner({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async () => {
      starts += 1;
      if (starts === 2) {
        resolveSecondStart();
        await secondReleased;
      }
      const result = queue.shift();
      assert.ok(result);
      return result;
    },
  });

  first.disconnect();
  const botMessage = owner.handleBotIncomingMessage({ text: 'hello' } as BotIncomingMessage);
  const stop = owner.stopSession('session-1');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  assert.equal(first.botMessages, 0);
  assert.deepEqual(first.stoppedSessions, []);
  first.finishDisconnect();
  await secondStarted;
  assert.equal(second.botMessages, 0);
  assert.deepEqual(second.stoppedSessions, []);
  releaseSecond();
  await Promise.all([botMessage, stop]);

  assert.equal(first.botMessages, 0);
  assert.equal(second.botMessages, 1);
  assert.deepEqual(second.stoppedSessions, ['session-1']);
  await owner.close();
  assert.equal(second.closeCalls, 1);
});

test('keeps reconnecting with bounded backoff until the Desktop adapter is restored', async () => {
  const first = candidateHarness();
  const replacement = candidateHarness();
  let starts = 0;
  const delays: number[] = [];
  let resolveRestored!: () => void;
  const restored = new Promise<void>((resolve) => {
    resolveRestored = resolve;
  });
  const owner = await startRuntimeHostDesktopOwner({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async (): Promise<DesktopRuntimeHostCandidateStartResult> => {
      starts += 1;
      if (starts === 1) return ready(first.candidate);
      if (starts < 4) return { kind: 'failed', reason: 'host_unresponsive' };
      resolveRestored();
      return ready(replacement.candidate);
    },
    reconnectBackoff: {
      minMs: 100,
      maxMs: 150,
      random: () => 0.5,
      wait: async (delayMs) => {
        delays.push(delayMs);
      },
    },
  });

  first.disconnect();
  await restored;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts, 4);
  assert.deepEqual(delays, [100, 150]);
  await owner.handleBotIncomingMessage({ text: 'restored' } as BotIncomingMessage);
  assert.equal(replacement.botMessages, 1);
  await owner.close();
});

test('stops reconnecting when the replacement Host is incompatible', async () => {
  const first = candidateHarness();
  let reportFatal!: (error: Error) => void;
  const fatalReported = new Promise<Error>((resolve) => {
    reportFatal = resolve;
  });
  const owner = await startRuntimeHostDesktopOwner({} as DesktopRuntimeHostCandidateStartInput, {
    startCandidate: async () =>
      first.closeCalls === 0
        ? ready(first.candidate)
        : {
            kind: 'incompatible',
            handshake: {
              kind: 'incompatible',
              hostEpoch: 'replacement-host',
              protocolMin: 1,
              protocolMax: 1,
              compatibilityEpoch: 1,
              state: 'ready',
              replacement: 'wait_for_idle_exit',
            },
          },
    onFatalError: reportFatal,
  });

  await first.candidate.close();
  const fatal = await fatalReported;
  assert.match(fatal.message, /incompatible/);
  await owner.close();
});

function candidateHarness(options: { delayDisconnect?: boolean } = {}) {
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closeCalls = 0;
  let botMessages = 0;
  const stoppedSessions: string[] = [];
  let lifecycleState: 'ready' | 'unavailable' = 'ready';
  const candidate = {
    closed,
    client: {
      get lifecycleState() {
        return lifecycleState;
      },
    },
    botIncoming: {
      async handleBotIncomingMessage() {
        botMessages += 1;
      },
    },
    async close() {
      closeCalls += 1;
      lifecycleState = 'unavailable';
      resolveClosed?.();
    },
    async stopSession(sessionId: string) {
      stoppedSessions.push(sessionId);
    },
  } as unknown as DesktopRuntimeHostCandidate;
  return {
    candidate,
    disconnect: () => {
      lifecycleState = 'unavailable';
      if (!options.delayDisconnect) resolveClosed?.();
    },
    finishDisconnect: () => resolveClosed?.(),
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
