// Lifecycle wiring for the Computer Use picture-in-picture mirror.
//
// The mirror's own behaviour is covered by computer-use-pip.test.ts, which
// builds the controller directly and hands it every dependency. That is
// precisely why it could not catch what was wrong here: the controller was
// constructed as a local inside `assembleDesktopTools` and never returned, so
// `complete`, `clearForSession`, `destroyAll` and `setStopHandler` had no
// production caller at all, and the `mainWindow` dependency the assembly
// declares was supplied by nothing in the repo. Every test passed while the
// window was never torn down, never anchored to the app, and never clickable.
//
// So these assertions are about the call sites, not the controller. boot.ts,
// app-lifecycle.ts and sessions-ipc-main.ts cannot be imported outside Electron
// — boot.ts is the whole startup chain and the other two bind `ipcMain` and
// `app` at module scope — so the wiring in those three is asserted against the
// source text, the same way this repo's other cross-file conventions are. The
// session-streamer half is a real call, because that module is importable.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { SessionActivityRegistry } from '@maka/runtime';
import type { SessionEvent } from '@maka/core';
import { createSessionStreamer } from '../session-stream.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const MAIN = resolve(REPO_ROOT, 'apps/desktop/src/main');

function read(relative: string): Promise<string> {
  return readFile(resolve(MAIN, relative), 'utf8');
}

describe('picture-in-picture lifecycle wiring', () => {
  it('assembleDesktopTools hands the mirror back to its caller', async () => {
    const source = await read('desktop-native-capability-assembly.ts');
    const returned = /\n  return \{\n([\s\S]*?)\n  \};\n\}/.exec(source)?.[1];
    assert.ok(returned, 'assembleDesktopTools must end in a return literal');
    assert.match(
      returned,
      /^\s*computerUsePip,$/m,
      'a controller that is not returned has no production caller: complete, ' +
        'clearForSession, destroyAll and setStopHandler are all unreachable',
    );
  });

  it('the overlay hook Computer Use is given is wrapped by the mirror', async () => {
    // The one assertion that makes this branch safe to merge alongside the
    // others that touch the same expression.
    //
    // `createComputerUseHost({ overlay })` takes a single hook, and every
    // feature that wants to see actions go past wraps the one before it. That
    // makes the expression a merge conflict by construction: resolving it by
    // taking one side compiles, type-checks, and leaves every test in both
    // branches green while one branch's entire feed is silently disconnected.
    // Measured here by replacing the value with the bare
    // `createComputerUseOverlayHook(computerUseOverlay)`: `tsc` exits 0 and all
    // 71 mirror tests pass against a window that can never receive a frame,
    // because every one of them constructs the wrapper itself.
    //
    // So this asserts the production expression, not the wrapper's behaviour.
    // The correct resolution nests the wrappers rather than choosing between
    // them; whichever order they end up in, `withComputerUsePip` has to be one
    // of them.
    const source = await read('desktop-native-capability-assembly.ts');
    const overlay = /\n    overlay: ([\s\S]*?),\n  \}\);/.exec(source)?.[1];
    assert.ok(overlay, 'createComputerUseHost must be given an overlay hook');
    assert.match(
      overlay,
      /withComputerUsePip\(/,
      'a mirror that is not in the overlay chain is never handed a frame: no ' +
        'present, no cursor, and a window that only ever shows its placeholder',
    );
    assert.match(
      overlay,
      /createComputerUseOverlayHook\(computerUseOverlay\)/,
      'and it wraps the cursor hook rather than replacing it',
    );
  });

  it('boot.ts gives the assembly the app window it asks for', async () => {
    const source = await read('boot.ts');
    assert.match(
      source,
      /assembleDesktopTools\(\{[\s\S]*?\n  mainWindow: mainWindowController,/,
      'without this the mirror floats above every application, has no pointer ' +
        'to hover-test against, and lands on the primary display',
    );
  });

  it('the main window controller supplies all three anchor capabilities', async () => {
    const source = await read('main-window.ts');
    for (const method of ['windowBounds', 'browserWindow', 'onWindowGeometryChanged']) {
      assert.match(
        source,
        new RegExp(`^    ${method}\\(`, 'm'),
        `MainWindowController must implement ${method}`,
      );
    }
    assert.match(source, /w\.on\('move', cb\);\s*\n\s*w\.on\('resize', cb\);/);
  });

  it('boot.ts tears the mirror down when the window it belongs to closes', async () => {
    const source = await read('boot.ts');
    const handler = /onMainWindowClose = \(\) => \{([\s\S]*?)\n\};/.exec(source)?.[1];
    assert.ok(handler, 'boot.ts must assign onMainWindowClose');
    assert.match(handler, /computerUsePip\.destroyAll\(\);/);
  });

  it('boot.ts forwards the mirror to every surface that retires it', async () => {
    const source = await read('boot.ts');
    for (const [callee, pattern] of [
      ['registerSessionsIpc', /registerSessionsIpc\(\{[\s\S]*?\n  \}\);/],
      ['createSessionStreamer', /createSessionStreamer\(\{[\s\S]*?\n\}\);/],
      ['wireAppLifecycle', /wireAppLifecycle\(\{[\s\S]*?\n\}\);/],
    ] as const) {
      const call = pattern.exec(source)?.[0];
      assert.ok(call, `boot.ts must call ${callee}`);
      assert.match(call, /^\s*computerUsePip,$/m, `${callee} must receive the mirror`);
    }
  });

  it('app-lifecycle destroys the mirror on both shutdown paths', async () => {
    const source = await read('app-lifecycle.ts');
    const allClosed = /app\.on\('window-all-closed', \(\) => \{([\s\S]*?)\n  \}\);/.exec(source)?.[1];
    assert.ok(allClosed, 'app-lifecycle must handle window-all-closed');
    assert.match(allClosed, /computerUsePip\.destroyAll\(\)/);

    const quit = /async function runBeforeQuitCleanup\(\): Promise<void> \{([\s\S]*?)\n  \}/.exec(
      source,
    )?.[1];
    assert.ok(quit, 'app-lifecycle must run a before-quit cleanup');
    assert.match(quit, /computerUsePip\.destroyAll\(\)/);
  });

  it('the session IPC clears the mirror wherever it clears the cursor', async () => {
    const source = await read('sessions-ipc-main.ts');
    const overlayClears = source.match(/computerUseOverlay\.clearForSession\(/g) ?? [];
    const pipClears = source.match(/computerUsePip\?\.clearForSession\(/g) ?? [];
    assert.ok(overlayClears.length >= 3, 'sanity: the cursor is cleared on several paths');
    assert.equal(
      pipClears.length,
      overlayClears.length,
      'the mirror dies with a session on exactly the paths the cursor does: ' +
        'delete, stop, archive',
    );
  });

  it('the mirror stop control runs the same stop the app window runs', async () => {
    const source = await read('sessions-ipc-main.ts');
    assert.match(
      source,
      /computerUsePip\?\.setStopHandler\(\(sessionId\) => \{\s*\n\s*void stopSession\(sessionId, \{ source: 'stop_button' \}\);/,
      'without a handler the button in the mirror stops nothing',
    );
    assert.match(
      source,
      /ipcMain\.handle\('sessions:stop',[\s\S]*?stopSession\(sessionId, input\)/,
      'and both must be the same function, or they drift',
    );
  });

  it('a turn ending retires the mirror', async () => {
    // The real call, not the source text: this module has no Electron in it.
    // The mirror used to be cleared only on stop, archive and delete, so it
    // outlived the run it belonged to and kept showing that run's last frame
    // while the next turn drove a different application.
    const completed: string[] = [];
    const streamEvents = createSessionStreamer({
      sessionActivities: new SessionActivityRegistry(),
      goalWiring: {
        coordinator: {
          beginObservedTurn: () => ({ kind: 'registered', settle: async () => {} }),
        },
      } as never,
      computerUseOverlay: { clearForSession: () => {} } as never,
      computerUsePip: { complete: (sessionId) => completed.push(sessionId) },
      computerUseTools: { clearSession: () => {} } as never,
      safeSendToRenderer: () => {},
      emitSessionsChanged: () => {},
    });

    async function* events(): AsyncGenerator<SessionEvent> {
      yield {
        type: 'complete',
        id: 'e1',
        turnId: 't1',
        ts: 1,
      } as unknown as SessionEvent;
    }

    await streamEvents('session-a', events(), { turnId: 't1', goalBoundary: 'none' });
    assert.deepEqual(completed, ['session-a']);
  });
});
