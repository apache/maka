/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
// Probe contract for the shared "Maka Dev" owner probe (#3359): pgrep -f for
// PIDs, ps -o command= for full argv (pgrep's -a/-l flag semantics differ
// between Linux and BSD), with exit 1 on either step meaning "nothing
// running". These tests stub spawnSync so the full chain is exercised.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSharedAppProbe, sharedDevelopmentAppCommandLines } from './dev-app-runtime.mjs';

function spawnStub(pgrep, ps) {
  return (command, args) => {
    if (command === 'pgrep') return pgrep(args);
    if (command === 'ps') return ps(args);
    throw new Error(`unexpected command ${command}`);
  };
}

test('a pgrep exit outside 0/1 is a probe error, not an empty result', () => {
  const probe = createSharedAppProbe(spawnStub(() => ({ status: 2, stdout: Buffer.from('') })));
  assert.throws(() => sharedDevelopmentAppCommandLines({ probe }), /pgrep failed/);
});

test('pgrep exit 1 means no matches', () => {
  const probe = createSharedAppProbe(spawnStub(() => ({ status: 1, stdout: Buffer.from('') })));
  assert.deepEqual(sharedDevelopmentAppCommandLines({ probe }), []);
});

test('ps exit 1 (no such pids) also means no command lines', () => {
  const probe = createSharedAppProbe(
    spawnStub(
      () => ({ status: 0, stdout: Buffer.from('4242\n') }),
      () => ({ status: 1, stdout: Buffer.from('') }),
    ),
  );
  assert.deepEqual(sharedDevelopmentAppCommandLines({ probe }), []);
});

test('ps output lines are the command lines', () => {
  const lines = [
    '4242 /Users/me/codebase/.maka-dev/Maka Dev.app/Contents/MacOS/Electron --inspect=9229',
    '4243 /Users/other/codebase/.maka-dev/Maka Dev.app/Contents/MacOS/Electron --no-sandbox',
  ];
  const probe = createSharedAppProbe(
    spawnStub(
      () => ({ status: 0, stdout: Buffer.from('4242\n4243\n') }),
      () => ({ status: 0, stdout: Buffer.from(`${lines.join('\n')}\n`) }),
    ),
  );
  assert.deepEqual(sharedDevelopmentAppCommandLines({ probe }), lines);
});

test('sharedDevelopmentAppOwner uses the profile authority', async () => {
  const { sharedDevelopmentAppOwner } = await import('./dev-app-runtime.mjs');
  const ownRoot = '/Users/me/codebase';
  const other = '/Users/other/codebase/apps/desktop/.maka-dev/Maka Dev.app/Contents/MacOS/Electron';
  const envFor = (path) => {
    if (path.endsWith('/apps/desktop/.maka-dev/dev-env.json')) {
      return JSON.stringify({ schemaVersion: 1, env: {}, userDataDir: undefined, electronArgs: [] });
    }
    throw new Error(`unexpected env read: ${path}`);
  };
  const own = `${ownRoot}/apps/desktop/.maka-dev/Maka Dev.app/Contents/MacOS/Electron --inspect`;
  assert.equal(sharedDevelopmentAppOwner({ ownRoot, commandLines: [own, `${other} --inspect`], readFile: envFor }), `${other} --inspect`);
  assert.equal(sharedDevelopmentAppOwner({ ownRoot, commandLines: [own] }), undefined);
  // explicit isolated profile is not the shared default owner
  assert.equal(
    sharedDevelopmentAppOwner({
      ownRoot,
      targetProfile: '/Users/other/Isolated',
      commandLines: [`${other} --inspect`],
      readFile: envFor,
    }),
    undefined,
  );
});

test('devAppProcessPattern selects every shape that can hold the lock', async () => {
  const { devAppProcessPattern } = await import('./dev-app-runtime.mjs');
  const pattern = new RegExp(devAppProcessPattern());
  // kabi's five real-shape lines: TCC bundle, plain shim, resolved Electron,
  // space-rooted bundle, foreign project (no maka marker, but .bin/electron
  // still appears — the rough filter DOES select it; owner judgment later
  // excludes it via hasMakaDevMarker).
  assert.equal(pattern.test('/Users/dev/maka/apps/desktop/.maka-dev/Maka Dev.app/Contents/MacOS/Electron /Users/dev/maka/apps/desktop'), true);
  assert.equal(pattern.test('node /tmp/maka-work/node_modules/.bin/electron /tmp/maka-work/review-fixtures/electron-argv --user-data-dir=/tmp/Maka Profile With Spaces --no-sandbox'), true);
  assert.equal(pattern.test('/tmp/maka-work/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /tmp/maka-work/review-fixtures/electron-argv'), true);
  assert.equal(pattern.test('/Users/dev/Dropbox (Personal)/maka/apps/desktop/.maka-dev/Maka Dev.app/Contents/MacOS/Electron /Users/dev/Dropbox (Personal)/maka/apps/desktop'), true);
  assert.equal(pattern.test('/Users/dev/some-other-app/node_modules/.bin/electron /Users/dev/some-other-app'), true);
  assert.equal(pattern.test('/usr/bin/something --headless'), false);
});

test('owner gate resolves a foreign plain holder through the REAL probe chain', async () => {
  const { createSharedAppProbe, sharedDevelopmentAppOwner } = await import('./dev-app-runtime.mjs');
  // Real-shape ps lines (kabi format): a foreign PLAIN dev (maka-layout shim
  // + its resolved Electron child, both alive) plus our own TCC bundle.
  const foreignShim = 'node /Users/dev/maka/node_modules/.bin/electron /Users/dev/maka/apps/desktop';
  const foreignReal = '/Users/dev/maka/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /Users/dev/maka/apps/desktop';
  const own = '/Users/me/codebase/apps/desktop/.maka-dev/Maka Dev.app/Contents/MacOS/Electron /Users/me/codebase/apps/desktop';
  // Stub spawnSync ONLY. The pgrep pattern argument must be the production
  // devAppProcessPattern (the stub asserts it, so it cannot silently change),
  // and ps returns only lines that pattern actually selects.
  const { devAppProcessPattern } = await import('./dev-app-runtime.mjs');
  const pattern = new RegExp(devAppProcessPattern());
  const selected = [foreignShim, foreignReal, own].filter((line) => pattern.test(line));
  const probe = (command, args) => {
    if (command === 'pgrep') {
      assert.equal(args[1], devAppProcessPattern());
      return { status: 0, stdout: Buffer.from(selected.map((_, i) => String(9847 + i)).join('\n') + '\n') };
    }
    if (command === 'ps') return { status: 0, stdout: Buffer.from(`${selected.join('\n')}\n`) };
    throw new Error(`unexpected ${command}`);
  };
  const owner = sharedDevelopmentAppOwner({
    ownRoot: '/Users/me/codebase', // matches the own line, so exclusion is real
    probe: createSharedAppProbe(probe),
  });
  // Our own process is excluded; the foreign plain holder (no switch, maka
  // marker via /apps/desktop) is the shared-default owner.
  assert.equal(owner, foreignShim);
});

test('plain liveness is macOS-only; off-darwin probes only the bundle', async () => {
  const { isDevelopmentAppRunning } = await import('./dev-app-runtime.mjs');
  const calls = [];
  // Linux: whatever is probed returns false (the bundle never exists off
  // macOS); the shim being alive is irrelevant because it is never probed.
  const probe = (executable) => {
    calls.push(executable);
    return false;
  };
  // Only the bundle is probed → false → the launch is NOT blocked even
  // though the shim is alive — kabi grok's P1 regression.
  assert.equal(
    isDevelopmentAppRunning({ platform: 'linux', probe, plainExecutable: '/wt/node_modules/.bin/electron', realPlainExecutable: '/wt/Electron.app/Electron' }),
    false,
  );
  assert.equal(calls.length, 1); // bundle only, shim/real never probed
  // darwin probes all three shapes.
  const calls2 = [];
  const probe2 = (executable) => { calls2.push(executable); return false; };
  assert.equal(
    isDevelopmentAppRunning({ platform: 'darwin', probe: probe2, plainExecutable: '/wt/shim', realPlainExecutable: '/wt/real' }),
    false,
  );
  assert.equal(calls2.length, 3); // all three shapes probed on darwin
});

test('DEV_EXECUTABLE carries the single-source TCC bundle suffix', async () => {
  const { DEV_EXECUTABLE } = await import('./dev-app-runtime.mjs');
  const { TCC_BUNDLE_EXECUTABLE_SUFFIX } = await import('./dev-app-profile.mjs');
  assert.ok(DEV_EXECUTABLE.endsWith(TCC_BUNDLE_EXECUTABLE_SUFFIX));
});

test('probe bundle pattern stays wide: selects a prefix-less TCC line', async () => {
  const { TCC_BUNDLE_PROBE_TAIL, devAppProcessPattern } = await import('./dev-app-runtime.mjs');
  const { TCC_BUNDLE_EXECUTABLE_SUFFIX } = await import('./dev-app-profile.mjs');
  // The wide literal comes from the module (no third copy), and is a tail of
  // the exact suffix — drift between the two is visible, not silent.
  assert.ok(TCC_BUNDLE_EXECUTABLE_SUFFIX.endsWith(TCC_BUNDLE_PROBE_TAIL));
  // The line that separates wide from narrow: a TCC process whose argv lacks
  // the per-worktree prefix (translocation-shaped). A narrow pattern misses
  // it; the wide one must still select it.
  assert.equal(
    new RegExp(devAppProcessPattern()).test(
      '/private/var/folders/abc/AppTranslocation/uuid/d/Maka Dev.app/Contents/MacOS/Electron /Users/dev/maka/apps/desktop',
    ),
    true,
  );
});

test('recheckAfterAbsence: foreign holder on the target profile is reported', async () => {
  const { recheckAfterAbsence } = await import('./dev-app-runtime.mjs');
  const foreign = '/Users/other/codebase/apps/desktop/.maka-dev/Maka Dev.app/Contents/MacOS/Electron /Users/other/codebase/apps/desktop';
  // foreign present on the shared default → conflict
  assert.throws(() => recheckAfterAbsence({ commandLines: [foreign] }), /absorbed this launch/);
  // nothing on the profile → no conflict
  assert.doesNotThrow(() => recheckAfterAbsence({ commandLines: [] }));
});

test('TCC monitor recheck on appeared→exited wires the REAL quiet recheck', async () => {
  const { monitorDevelopmentApp } = await import('./dev-app-runtime.mjs');
  // No recheck stub: the production recheckAfterAbsenceQuiet runs, fed by
  // the injected command lines (the outer probe seam). A foreign holder on
  // the shared profile must print a named conflict.
  const appearedThenExited = (() => {
    let calls = 0;
    return () => { calls += 1; return calls < 3; };
  })();
  const foreign = '/Users/other/codebase/apps/desktop/.maka-dev/Maka Dev.app/Contents/MacOS/Electron /Users/other/codebase/apps/desktop';
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    const outcome = await monitorDevelopmentApp({
      isRunning: appearedThenExited,
      commandLines: [foreign],
      pollMs: 1,
      startupAttempts: 10,
    });
    assert.equal(outcome, 'exited');
  } finally {
    console.error = originalError;
  }
  assert.ok(errors.some((message) => message.includes('absorbed this launch')), `expected conflict, got ${errors.join(' | ')}`);
});

test('TCC monitor recheck on never-started wires the REAL quiet recheck', async () => {
  const { monitorDevelopmentApp } = await import('./dev-app-runtime.mjs');
  const never = (() => {
    let calls = 0;
    return () => { calls += 1; return calls >= 5; }; // never appears within the window
  })();
  const foreign = '/Users/other/codebase/apps/desktop/.maka-dev/Maka Dev.app/Contents/MacOS/Electron /Users/other/codebase/apps/desktop';
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    const outcome = await monitorDevelopmentApp({
      isRunning: never,
      commandLines: [foreign],
      pollMs: 1,
      startupAttempts: 4,
    });
    assert.equal(outcome, 'never-started');
  } finally {
    console.error = originalError;
  }
  assert.ok(errors.some((message) => message.includes('absorbed this launch')), `expected conflict, got ${errors.join(' | ')}`);
});

test('recheck still names the holder when the loser env IS readable (env halves)', async () => {
  const { monitorDevelopmentApp } = await import('./dev-app-runtime.mjs');
  const appearedThenExited = (() => {
    let calls = 0;
    return () => { calls += 1; return calls < 3; };
  })();
  // env readable and declaring the SHARED default for the foreign worktree:
  // the recheck must still match and print the conflict (not rely on the
  // unknown-blocks fallback).
  const envFor = (path) => {
    if (path.endsWith('/apps/desktop/.maka-dev/dev-env.json')) {
      return JSON.stringify({ schemaVersion: 1, env: {}, userDataDir: undefined, electronArgs: [] });
    }
    throw new Error(`unexpected env read: ${path}`);
  };
  const foreign = '/Users/other/codebase/apps/desktop/.maka-dev/Maka Dev.app/Contents/MacOS/Electron /Users/other/codebase/apps/desktop';
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    const outcome = await monitorDevelopmentApp({
      isRunning: appearedThenExited,
      commandLines: [foreign],
      readFile: envFor,
      pollMs: 1,
      startupAttempts: 10,
    });
    assert.equal(outcome, 'exited');
  } finally {
    console.error = originalError;
  }
  assert.ok(errors.some((message) => message.includes('absorbed this launch')), `expected conflict, got ${errors.join(' | ')}`);
});
