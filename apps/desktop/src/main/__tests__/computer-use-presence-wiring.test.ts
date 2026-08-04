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
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, test } from 'node:test';
import type { SessionEvent } from '@maka/core';
import { createComputerUseHost } from '../computer-use-host.js';
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

function streamerDeps(cleared: string[], lockCleared: string[] = []) {
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
    computerUseScreenLock: {
      clearForSession: (sessionId: string) => {
        lockCleared.push(sessionId);
      },
    },
    computerUseTools: { clearSession: () => {} } as never,
    safeSendToRenderer: () => {},
    emitSessionsChanged: () => {},
  };
}

test('a turn ending releases the menu bar item, and with it the keep-awake hold', async () => {
  const cleared: string[] = [];
  const lockCleared: string[] = [];
  const streamEvents = createSessionStreamer(streamerDeps(cleared, lockCleared) as never);

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

  // And the lock guard on exactly the same signal. It holds session ids to
  // release on unlock, and this path did not clear it: the session IPC cleared
  // it on delete, stop and archive, while a turn that simply finished left its
  // id in the set until the process exited. Two hundred turns in distinct
  // sessions across a day left two hundred ids held and every unlock walking
  // all of them. The status item was cleared here and its sibling was not,
  // which is the asymmetry this pins shut.
  assert.deepEqual(lockCleared, ['session-A']);
});

test('a turn that dies releases it too', async () => {
  const cleared: string[] = [];
  const lockCleared: string[] = [];
  const streamerDepsWithThrow = {
    ...streamerDeps(cleared, lockCleared),
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
  assert.deepEqual(lockCleared, ['session-B']);
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

  it('the overlay hook Computer Use is given is wrapped by both presence hooks', async () => {
    // The one assertion that makes this branch safe to merge alongside the
    // others that touch the same expression.
    //
    // `createComputerUseHost({ overlay })` takes a single hook, and every
    // feature that wants to see actions go past wraps the one before it. That
    // makes the expression a merge conflict by construction: resolving it by
    // taking one side compiles, type-checks, and leaves every test in both
    // branches green while one branch's presence is silently disconnected.
    // Measured by replacing the value with the bare
    // `createComputerUseOverlayHook(computerUseOverlay)`: `tsc` exits 0 and all
    // 61 presence tests pass with a tray that never appears — so
    // `onLiveChanged` never fires, the keep-awake hold is never taken, and a
    // background run dies to idle sleep. Every one of those tests builds the
    // wrapper itself, which is exactly why none of them notices.
    //
    // So this asserts the production expression. The correct resolution nests
    // the wrappers rather than choosing between them; whichever order they end
    // up in, both of these have to be present.
    const text = await source('tool-assembly.ts');
    const overlay = /\n    overlay: ([\s\S]*?),\n  \}\);/.exec(text)?.[1];
    assert.ok(overlay, 'createComputerUseHost must be given an overlay hook');
    assert.match(
      overlay,
      /withComputerUseStatusItem\(/,
      'no status item in the chain means no live-session count, so no menu bar ' +
        'indicator and no keep-awake hold',
    );
    assert.match(
      overlay,
      /withComputerUseScreenLock\(/,
      'no lock guard in the chain means a session the executor refused for a ' +
        'lock is never registered, and screenUnlocked is its only way out',
    );
    assert.match(
      overlay,
      /createComputerUseOverlayHook\(computerUseOverlay\)/,
      'and they wrap the cursor hook rather than replacing it',
    );
  });

  it('gives tool assembly the keep-awake controller its only caller needs', async () => {
    // `keepSystemAwake` is optional on the deps, so deleting it from the call
    // costs nothing at compile time: `tsc --noEmit` stays at exit 0 and all 61
    // presence tests pass. What it costs at runtime is the whole feature —
    // `onLiveChanged` fires into `undefined`, no `prevent-app-suspension`
    // blocker is ever taken, and a background Computer Use run dies to idle
    // sleep, which is the exact failure the refcount rewrite exists to
    // prevent. Optional is right for the dependency (the tool surface is
    // assembled in contexts with no Electron power management) and wrong for
    // the one production call site, so the call site is what is pinned.
    const text = await source('boot.ts');
    const start = text.indexOf('assembleDesktopTools({');
    assert.notEqual(start, -1, 'boot.ts must assemble the tools');
    const call = text.slice(start, text.indexOf('});', start));
    assert.match(
      call,
      /\bkeepSystemAwake,/,
      'without it the status item holds nothing awake and the run sleeps',
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
    // Anchored on the declaration, not on the first place the name is spelled.
    // `text.indexOf(caller)` finds whichever mention comes first in the file,
    // which is a doc comment as soon as anyone writes one — and this branch
    // merges with another that adds exactly such a comment above the deps.
    // The window then starts hundreds of characters early and the assertion
    // fails on a merge that is entirely correct, which is the same kind of
    // wrong answer as passing when it should not.
    for (const [caller, declaration] of [
      ['removeSession', /const removeSession = async \([\s\S]*?\n  \};/],
      ['stopSession', /async function stopSession\([\s\S]*?\n  \}/],
    ] as const) {
      const body = declaration.exec(text)?.[0];
      assert.ok(body, `sessions-ipc-main.ts must declare ${caller}`);
      assert.match(
        body,
        /computerUseStatusItem\?\.clearForSession\(/,
        `${caller} must retire the item`,
      );
      assert.match(
        body,
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
      ['createSessionStreamer({', ['computerUseStatusItem', 'computerUseScreenLock']],
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

/**
 * The probe above pins the top of the wire — tool assembly hands
 * `createComputerUseHost` a `screenLocked` — and the runtime's screen-lock
 * suite pins the bottom — `buildComputerUseTools` refuses when its
 * `screenLocked` says so. Neither touches the two forwarding hops in between:
 * `computer-use-host.ts` handing it to `selectComputerUseBackend`, and
 * `select-backend.ts` handing it to `buildComputerUseTools`. Delete both and
 * every suite in the repo stays green with the guard dead in production, which
 * is the same shape of defect the rest of this file exists to catch.
 *
 * So this drives the real chain rather than reading it: a real
 * `createComputerUseHost` over a temp manifest and a stand-in binary, whose
 * tool must refuse. Nothing is stubbed between the two ends — a dropped hop
 * anywhere along it turns the refusal into a dispatch.
 *
 * `selectComputerUseBackend` is darwin-only and CI is Linux, so the platform is
 * forced rather than skipped; skipping would make this vacuous exactly where it
 * is most needed. Nothing spawns: the lock refusal happens in the tool layer
 * before the backend is ever asked for anything.
 */
test('a lock reaches the tool layer through the real host and backend selection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maka-cu-lock-wire-'));
  const binaryPath = join(dir, 'maka-cu');
  writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n');
  chmodSync(binaryPath, 0o755);
  const manifestPath = join(dir, 'bundled-tools.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      makaCu: {
        binarySha256: createHash('sha256').update(readFileSync(binaryPath)).digest('hex'),
        distributionReady: true,
      },
    }),
  );

  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  try {
    const locked: string[] = [];
    const host = createComputerUseHost({
      isPackaged: false,
      resourcesPath: dir,
      manifestPath,
      binaryPath,
      physicalInputRecentlyActive: () => false,
      screenLocked: ({ sessionId }) => {
        locked.push(sessionId);
        return true;
      },
    });

    const tools = host.selected.tools;
    assert.ok(tools, 'the fixture must select a backend, or this asserts nothing');
    const [tool] = tools;
    // A dropped hop does not return a wrong answer, it dispatches: the call
    // goes past the missing guard and tries to drive the machine, and the
    // stand-in binary fails somewhere inside the driver. Name that here rather
    // than leaving a lifecycle stack trace as the only evidence.
    let result: { text: string; error?: string };
    try {
      result = (await tool.impl({ action: 'observe', app: 'Fixture' } as never, {
        sessionId: 'session-locked',
        turnId: 'turn-1',
        toolCallId: 'observe',
        cwd: '/tmp',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      })) as { text: string; error?: string };
    } catch (error) {
      assert.fail(
        'the call reached the driver instead of being refused, so the lock never got ' +
          `to the tool layer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    assert.equal(
      result.error,
      'screen_locked',
      'the probe must be asked and its answer must refuse the call',
    );
    assert.deepEqual(
      locked,
      ['session-locked'],
      'the probe must be consulted for the session that called, not a stand-in',
    );

    host.selected.backend?.dispose?.();
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
