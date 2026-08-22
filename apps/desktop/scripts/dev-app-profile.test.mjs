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
// Profile authority tests (#63): known-literal matching only — never
// reverse-parse an unknown value.
//
// The five command lines below are the REAL Darwin probe output captured by
// kabi-opus (Darwin 25.2.0 arm64, `pgrep -f` then `ps -p <ids> -o command=`):
// pgrep prints bare PIDs one per line; ps prints full argv lines with NO PID
// column, quoting/boundaries lost, ~1.3k chars not truncated; ps exits 1 only
// when ALL requested PIDs are gone.
//
// SOURCE NOTE: the TCC_BUNDLE and SPACED_ROOT path strings are DERIVED, not
// captured — that machine had no built bundle; paths were inferred from maka
// source constants, usernames masked as `dev`. PLAIN_SHIM / PLAIN_REAL are
// REAL captures by kabi-sol on a machine that ran an Electron (shim PID
// 12375, its Electron child PID 12380, both alive) — those ran OUTSIDE a Maka
// layout (fixture dir), so they pin the FORMAT but are not Maka processes.
// Pinned facts:
//   a) the shim's argv[0] happened to be `node` on that machine, but that is
//      NOT a stable feature (other Node installs show an absolute path) —
//      judgment matches known literals anywhere in the line, never argv[0];
//   b) `--user-data-dir=/tmp/Maka Profile With Spaces --no-sandbox` shows a
//      space-bearing value followed by another flag: reverse-parsing an
//      UNKNOWN value from flat text is impossible, but matching a KNOWN
//      target requires the literal followed by a flag boundary or line end;
//   c) one plain launch is TWO live candidates (shim + its Electron child) —
//      owner judgment normalizes by identity; quit/liveness must cover both.
// A real TCC bundle argv is still awaited; TCC_BUNDLE stays marked derived.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  hasMakaDevMarker,
  holdsProfile,
  isOwnDevApp,
  worktreeRootFromBundle,
} from './dev-app-profile.mjs';

// kabi's five real-shape lines:
const TCC_BUNDLE = '/Users/dev/maka/apps/desktop/.maka-dev/Maka Dev.app/Contents/MacOS/Electron /Users/dev/maka/apps/desktop';
const PLAIN_SHIM = 'node /tmp/maka-work/node_modules/.bin/electron /tmp/maka-work/review-fixtures/electron-argv --user-data-dir=/tmp/Maka Profile With Spaces --no-sandbox';
const PLAIN_REAL = '/tmp/maka-work/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /tmp/maka-work/review-fixtures/electron-argv --user-data-dir=/tmp/Maka Profile With Spaces --no-sandbox';
const SPACED_ROOT = '/Users/dev/Dropbox (Personal)/maka/apps/desktop/.maka-dev/Maka Dev.app/Contents/MacOS/Electron /Users/dev/Dropbox (Personal)/maka/apps/desktop';
const FOREIGN_ELECTRON = '/Users/dev/some-other-app/node_modules/.bin/electron /Users/dev/some-other-app';

function envFor(options = {}) {
  const { isolated = false } = options;
  return (path) => {
    if (path.endsWith('/apps/desktop/.maka-dev/dev-env.json')) {
      return JSON.stringify({
        schemaVersion: 1,
        env: {},
        userDataDir: isolated ? '/Users/dev/Library/Application Support/Isolated Dev' : undefined,
        electronArgs: [],
      });
    }
    throw new Error(`unexpected env read: ${path}`);
  };
}

test('worktreeRootFromBundle recovers a space-bearing root by literal', () => {
  assert.equal(worktreeRootFromBundle(TCC_BUNDLE), '/Users/dev/maka');
  assert.equal(worktreeRootFromBundle(SPACED_ROOT), '/Users/dev/Dropbox (Personal)/maka');
  assert.equal(worktreeRootFromBundle(FOREIGN_ELECTRON), undefined);
});

test('holdsProfile: TCC profile comes from the worktree dev-env.json (sol P1)', () => {
  // Default env (no explicit userDataDir): TCC holds the shared default.
  assert.equal(holdsProfile(TCC_BUNDLE, undefined, { readFile: envFor() }), true);
  assert.equal(holdsProfile(TCC_BUNDLE, '/Users/dev/Library/Application Support/Isolated Dev', { readFile: envFor() }), false);
  // Isolated env: TCC holds the ISOLATED profile — both directions correct.
  assert.equal(holdsProfile(TCC_BUNDLE, '/Users/dev/Library/Application Support/Isolated Dev', { readFile: envFor({ isolated: true }) }), true);
  assert.equal(holdsProfile(TCC_BUNDLE, undefined, { readFile: envFor({ isolated: true }) }), false);
  // Space-bearing root works the same (literal recovery).
  assert.equal(holdsProfile(SPACED_ROOT, undefined, { readFile: envFor() }), true);
  // env missing (abnormal): err toward the shared default (see-MORE).
  assert.equal(holdsProfile(TCC_BUNDLE, undefined, { readFile: () => { throw new Error('no env'); } }), true);
});

test('holdsProfile: captured lines against the shared default', () => {
  assert.equal(holdsProfile(SPACED_ROOT, undefined, { readFile: envFor() }), true);
  assert.equal(holdsProfile(FOREIGN_ELECTRON, undefined), false);
  // The kabi-sol captures are real FORMAT but not Maka processes (fixture dir).
  assert.equal(hasMakaDevMarker(PLAIN_SHIM), false);
  assert.equal(hasMakaDevMarker(PLAIN_REAL), false);
});

test('holdsProfile: explicit known target matches, bounded (plain shape)', () => {
  const TARGET = '/tmp/Maka Profile With Spaces';
  // Plain shape with the maka /apps/desktop marker (argv[1] = DESKTOP_DIR).
  const makaPlain = '/Users/dev/maka/node_modules/.bin/electron /Users/dev/maka/apps/desktop';
  const plainWithSwitch = makaPlain + ' --user-data-dir=' + TARGET + ' --no-sandbox';
  assert.equal(holdsProfile(plainWithSwitch, TARGET), true);
  // Known-limitation: a no-space target that is a PREFIX of the real value
  // matches (the flat argv cannot prove where the value ends). Accepted on
  // the side of SEEING more holders (P3 wins: a switch followed by a
  // positional argument must not be missed).
  assert.equal(holdsProfile(plainWithSwitch, '/tmp/Maka'), true);
  // Switch followed by a positional argument: the no-space value is still
  // matched (P3), and the space-bearing value is not recoverable — the
  // target's own shape decides the boundary.
  assert.equal(
    holdsProfile(`${makaPlain} --user-data-dir=/tmp/x /some/app`, '/tmp/x'),
    true,
  );
  // Uniform boundary (?=\s|$): a longer real value adds a non-space
  // character (e.g. `-abc123` or `/sub`), which the whitespace boundary
  // still rejects; only the prefix-trap (value = target + space + more)
  // remains, which flat argv cannot decide — accepted, see above.
  assert.equal(
    holdsProfile(`${makaPlain} --user-data-dir=${TARGET} /a`, TARGET),
    true,
  );
  assert.equal(holdsProfile(`${makaPlain} --user-data-dir=${TARGET}-abc123`, TARGET), false);
  assert.equal(holdsProfile(`${makaPlain} --user-data-dir=${TARGET}/sub`, TARGET), false);
});

test('holdsProfile: a plain worktree that never ran TCC is still a holder (P2)', () => {
  const plainNoTrace = '/Users/me/repo/node_modules/.bin/electron /Users/me/repo/apps/desktop';
  assert.equal(holdsProfile(plainNoTrace, undefined), true);
  assert.equal(holdsProfile(plainNoTrace, '/Users/me/Isolated'), false);
});

test('isOwnDevApp matches own shapes by literal root, never a sibling prefix', () => {
  assert.equal(isOwnDevApp(TCC_BUNDLE, '/Users/dev/maka'), true);
  assert.equal(isOwnDevApp(PLAIN_SHIM, '/tmp/maka-work'), true);
  assert.equal(isOwnDevApp(SPACED_ROOT, '/Users/dev/Dropbox (Personal)/maka'), true);
  assert.equal(isOwnDevApp(FOREIGN_ELECTRON, '/Users/dev/maka'), false);
  assert.equal(isOwnDevApp('/work/wt-35/apps/desktop', '/work/wt-3'), false);
});

test('a foreign Turborepo Electron with apps/desktop IS judged a holder (known trade)', () => {
  // Same layout as Maka plain dev; the marker cannot distinguish them, and
  // the judgment errs toward blocking (see hasMakaDevMarker JSDoc).
  const foreignMonorepo = '/Users/dev/turborepo/node_modules/.bin/electron /Users/dev/turborepo/apps/desktop';
  assert.equal(hasMakaDevMarker(foreignMonorepo), true);
  assert.equal(holdsProfile(foreignMonorepo, undefined), true);
});

test('hasMakaDevMarker basics', () => {
  assert.equal(hasMakaDevMarker(TCC_BUNDLE), true);
  assert.equal(hasMakaDevMarker(SPACED_ROOT), true);
  assert.equal(hasMakaDevMarker(FOREIGN_ELECTRON), false);
});

test('drift state (env rewritten while an old process lives) judges by the new env', () => {
  // Ordering guarantee (launcher-mediated path only): assert gate -> kill old
  // (ensureNoRunning) -> writeDevelopmentEnvironment (after
  // resolveMacosDevelopmentLaunch returns), so "new env + old process alive"
  // cannot be constructed on that path — this test simulates the state anyway
  // to pin the judgment direction: the OLD process is attributed by the NEW
  // env (the only source the argv offers), and the failure direction is a
  // conservative block, not a silent absorption. Boundary of the guarantee:
  // direct `open` of the bundle (bypassing the launcher) or an env rewrite
  // by other commands after a hard kill is NOT covered.
  const oldProcess = `${TCC_BUNDLE} --inspect=9229`; // started under profile X
  const envNowIsolated = envFor({ isolated: true });
  // New env says isolated; the old process is attributed isolated → a launch
  // targeting the default is NOT blocked by it (it does not hold default).
  assert.equal(holdsProfile(oldProcess, undefined, { readFile: envNowIsolated }), false);
  // ...but a launch targeting isolated DOES see it as the holder (correct
  // direction for the recorded state; the old process actually holds X only
  // until the launcher's kill step — see ordering note above).
  assert.equal(holdsProfile(oldProcess, '/Users/dev/Library/Application Support/Isolated Dev', { readFile: envNowIsolated }), true);
});
