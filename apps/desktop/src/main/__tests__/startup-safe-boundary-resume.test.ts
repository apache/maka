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

  const logged: string[] = [];
  await resumeSafeBoundaryContinuationsOnStartup(runtime, streamEvents, (message) => {
    logged.push(message);
  });

  assert.deepEqual(calls, ['boundary:external-session']);
  // Skipping it is the admission rule holding, not a fault, so nothing is
  // reported — otherwise every harness-owned session would log on every launch.
  assert.deepEqual(logged, []);
});

test('one unreadable session does not strand the sessions after it', async () => {
  // The pass surveys every session, so anything local to one of them — a record
  // removed since `listSessions`, an unreadable boundary row — must cost that
  // session only. An unguarded loop would abort here and leave every later
  // session un-recovered, which is how a single bad row becomes an outage.
  const calls: string[] = [];
  const logged: string[] = [];
  const continuation = { sessionId: 'later', turnId: 'turn-1' };
  const runtime = {
    async listSessions() {
      return [{ id: 'broken' }, { id: 'later' }];
    },
    async readExecutionBoundary(sessionId: string) {
      calls.push(`boundary:${sessionId}`);
      if (sessionId === 'broken') throw new Error('session record is gone');
      return {
        kind: 'managed' as const,
        revision: 0,
        profile: { filesystem: { entries: [] }, network: { enabled: false } },
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

  await resumeSafeBoundaryContinuationsOnStartup(runtime, streamEvents, (message) => {
    logged.push(message);
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [
    'boundary:broken',
    'boundary:later',
    'plan:later',
    'resume:later',
    'stream:later',
  ]);
  // Reported, not swallowed: a session that could not be surveyed is a fault,
  // unlike the externally isolated session above, which is the rule holding.
  assert.deepEqual(logged, ['[startup] safe-boundary resume failed for session broken:']);
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
