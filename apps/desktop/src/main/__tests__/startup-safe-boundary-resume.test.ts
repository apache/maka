import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionManager } from '@maka/runtime';
import type { StreamEvents } from '../session-stream.js';
import { resumeSafeBoundaryContinuationsOnStartup } from '../startup-safe-boundary-resume.js';

test('startup recovery never plans or resumes an externally isolated session', async () => {
  const calls: string[] = [];
  const runtime = {
    async listSessions() {
      return [{ id: 'external-session' }];
    },
    async readExecutionBoundary(sessionId: string) {
      calls.push(`boundary:${sessionId}`);
      return { kind: 'external' as const, revision: 0 };
    },
    async planLatestAuthoritativeSafeBoundaryContinuation(sessionId: string) {
      calls.push(`plan:${sessionId}`);
      assert.fail('Desktop must not plan an externally isolated continuation');
    },
    resumeSafeBoundaryContinuation() {
      assert.fail('Desktop must not resume an externally isolated continuation');
    },
  } as unknown as Pick<
    SessionManager,
    | 'listSessions'
    | 'readExecutionBoundary'
    | 'planLatestAuthoritativeSafeBoundaryContinuation'
    | 'resumeSafeBoundaryContinuation'
  >;
  const streamEvents = (() => {
    assert.fail('Desktop must not stream an externally isolated continuation');
  }) as unknown as StreamEvents;

  await resumeSafeBoundaryContinuationsOnStartup(runtime, streamEvents);

  assert.deepEqual(calls, ['boundary:external-session']);
});

test('startup recovery resumes an admitted managed continuation', async () => {
  const calls: string[] = [];
  const continuation = {
    sessionId: 'managed-session',
    turnId: 'turn-1',
  };
  const runtime = {
    async listSessions() {
      return [{ id: 'managed-session' }];
    },
    async readExecutionBoundary(sessionId: string) {
      calls.push(`boundary:${sessionId}`);
      return {
        kind: 'managed' as const,
        revision: 0,
        profile: {
          filesystem: { entries: [] },
          network: { enabled: false },
        },
      };
    },
    async planLatestAuthoritativeSafeBoundaryContinuation(sessionId: string) {
      calls.push(`plan:${sessionId}`);
      return { continuation };
    },
    resumeSafeBoundaryContinuation(input: typeof continuation) {
      calls.push(`resume:${input.sessionId}`);
      return (async function* () {})();
    },
  } as unknown as Pick<
    SessionManager,
    | 'listSessions'
    | 'readExecutionBoundary'
    | 'planLatestAuthoritativeSafeBoundaryContinuation'
    | 'resumeSafeBoundaryContinuation'
  >;
  const streamEvents = (async (sessionId: string) => {
    calls.push(`stream:${sessionId}`);
    return {};
  }) as unknown as StreamEvents;

  await resumeSafeBoundaryContinuationsOnStartup(runtime, streamEvents);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [
    'boundary:managed-session',
    'plan:managed-session',
    'resume:managed-session',
    'stream:managed-session',
  ]);
});
