/**
 * Call-site wiring for Computer Use presence.
 *
 * The status item, the screen-lock guard and the keep-awake hold are all
 * correct in isolation and were all unreachable: the item was a local inside
 * `assembleDesktopTools` that nothing was ever handed, so `clearForSession`,
 * `destroy` and `setStopHandler` had no production caller. The consequences
 * were a `prevent-app-suspension` blocker taken out by the first Computer Use
 * action and held until the process exited, a menu bar item that never went
 * away, and a Stop row drawn permanently disabled.
 *
 * So these tests deliberately do NOT hand the components anything. The existing
 * status-item and screen-lock suites already prove the components work when
 * wired; a test that calls `setStopHandler` itself proves exactly the thing
 * that was never in doubt. What is asserted here is that production supplies
 * the calls.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it, test } from 'node:test';
import type { SessionEvent } from '@maka/core';
import { createSessionStreamer } from '../session-stream.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const MAIN = resolve(REPO_ROOT, 'apps/desktop/src/main');

async function source(file: string): Promise<string> {
  return readFile(resolve(MAIN, file), 'utf8');
}

async function events(list: SessionEvent[]): Promise<AsyncIterable<SessionEvent>> {
  return (async function* stream() {
    for (const event of list) yield event;
  })();
}

function completeEvent(): SessionEvent {
  return {
    type: 'complete',
    id: 'e1',
    turnId: 't1',
    ts: Date.now(),
  } as SessionEvent;
}

function errorEvent(): SessionEvent {
  return {
    type: 'error',
    id: 'e1',
    turnId: 't1',
    ts: Date.now(),
    recoverable: false,
    code: 'boom',
    reason: 'boom',
    message: 'boom',
  } as SessionEvent;
}

function streamerDeps(cleared: string[]) {
  return {
    sessionActivities: {
      reserve: () => ({ release: () => {} }),
    } as never,
    goalWiring: {
      coordinator: {
        beginObservedTurn: () => ({ kind: 'registered', settle: () => {} }),
      },
    } as never,
    computerUseOverlay: { clearForSession: () => {} } as never,
    computerUseStatusItem: {
      clearForSession: (sessionId: string) => {
        cleared.push(sessionId);
      },
    },
    computerUseTools: { clearSession: () => {} } as never,
    safeSendToRenderer: () => {},
    emitSessionsChanged: () => {},
  };
}

test('a turn ending releases the menu bar item, and with it the keep-awake hold', async () => {
  const cleared: string[] = [];
  const streamEvents = createSessionStreamer(streamerDeps(cleared) as never);

  await streamEvents('session-A', await events([completeEvent()]), {
    turnId: 't1',
    goalBoundary: 'internal',
  } as never);

  // `onLiveChanged(false)` — and therefore `keepSystemAwake.release` — is
  // reachable only through `clearForSession` and `destroy`. If a finished turn
  // does not clear, one Computer Use action holds `prevent-app-suspension` for
  // the rest of the process's life and the keep-awake setting can no longer
  // stop it.
  assert.deepEqual(cleared, ['session-A']);
});

test('a turn that dies releases it too', async () => {
  const cleared: string[] = [];
  const streamerDepsWithThrow = {
    ...streamerDeps(cleared),
    safeSendToRenderer: (channel: string) => {
      if (channel.startsWith('sessions:event:')) return;
    },
  };
  const streamEvents = createSessionStreamer(streamerDepsWithThrow as never);

  await streamEvents('session-B', await events([errorEvent()]), {
    turnId: 't1',
    goalBoundary: 'internal',
  } as never);

  assert.deepEqual(cleared, ['session-B']);
});

/**
 * The remaining call sites live in modules that import `electron` at the top
 * level and therefore cannot be loaded under `node --test`; the repo already
 * pins main-process invariants this way (see `app-region-hygiene-contract`).
 * Each assertion below is about a call that had no production caller at all,
 * which is the failure mode being guarded — not about spelling.
 */
describe('Computer Use presence is reachable from production', () => {
  it('hands the status item and the lock guard out of tool assembly', async () => {
    const text = await source('tool-assembly.ts');
    const returned = text.slice(text.lastIndexOf('return {'));
    assert.match(
      returned,
      /computerUseStatusItem,/,
      'the status item must leave assembleDesktopTools or nothing can clear it',
    );
    assert.match(
      returned,
      /computerUseScreenLock,/,
      'the lock guard must leave assembleDesktopTools or nothing can dispose it',
    );
  });

  it('gives the dispatch path a lock probe', async () => {
    const text = await source('tool-assembly.ts');
    assert.match(
      text,
      /screenLocked:\s*\(\{\s*sessionId\s*\}\)\s*=>/,
      '`locked()` is only a guard once createComputerUseHost is given it',
    );
    assert.match(
      text,
      /computerUseScreenLock\.noteSessionActive\(sessionId\)/,
      'a session refused for a lock must be one the guard will release on unlock',
    );
  });

  it('routes the status item to session teardown and to the stop path', async () => {
    const text = await source('sessions-ipc-main.ts');
    assert.match(
      text,
      /computerUseStatusItem\?\.setStopHandler\(/,
      'without a stop handler the menu draws every Stop row disabled',
    );
    assert.match(
      text,
      /void stopSession\(sessionId, \{ source: 'stop_button' \}\)/,
      'the menu bar must stop a run through the same path as the in-app button',
    );
    for (const caller of ['removeSession', 'stopSession']) {
      const body = text.slice(text.indexOf(caller));
      assert.match(
        body.slice(0, 600),
        /computerUseStatusItem\?\.clearForSession\(/,
        `${caller} must retire the item`,
      );
      assert.match(
        body.slice(0, 600),
        /computerUseScreenLock\?\.clearForSession\(/,
        `${caller} must stop the guard tracking a session that is gone`,
      );
    }
  });

  it('retires both at quit', async () => {
    const text = await source('app-lifecycle.ts');
    assert.match(text, /computerUseStatusItem\.destroy\(\)/);
    assert.match(text, /computerUseScreenLock\.dispose\(\)/);
  });

  it('passes them from boot to every collaborator that must call them', async () => {
    const text = await source('boot.ts');
    for (const [anchor, needed] of [
      ['registerSessionsIpc({', ['computerUseStatusItem', 'computerUseScreenLock']],
      ['createSessionStreamer({', ['computerUseStatusItem']],
      ['wireAppLifecycle({', ['computerUseStatusItem', 'computerUseScreenLock']],
    ] as const) {
      const start = text.indexOf(anchor);
      assert.notEqual(start, -1, `${anchor} not found`);
      const block = text.slice(start, text.indexOf('});', start));
      for (const name of needed) {
        assert.match(block, new RegExp(`\\b${name},`), `${anchor} must receive ${name}`);
      }
    }
  });
});
