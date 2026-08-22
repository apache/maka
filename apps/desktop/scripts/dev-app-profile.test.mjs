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
} from './dev-app-profile.mjs';

// kabi's five real-shape lines:
const TCC_BUNDLE = '/Users/dev/maka/apps/desktop/.maka-dev/Maka Dev.app/Contents/MacOS/Electron /Users/dev/maka/apps/desktop';
const PLAIN_SHIM = 'node /tmp/maka-work/node_modules/.bin/electron /tmp/maka-work/review-fixtures/electron-argv --user-data-dir=/tmp/Maka Profile With Spaces --no-sandbox';
const PLAIN_REAL = '/tmp/maka-work/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /tmp/maka-work/review-fixtures/electron-argv --user-data-dir=/tmp/Maka Profile With Spaces --no-sandbox';
const SPACED_ROOT = '/Users/dev/Dropbox (Personal)/maka/apps/desktop/.maka-dev/Maka Dev.app/Contents/MacOS/Electron /Users/dev/Dropbox (Personal)/maka/apps/desktop';
const FOREIGN_ELECTRON = '/Users/dev/some-other-app/node_modules/.bin/electron /Users/dev/some-other-app';

test('holdsProfile: captured lines against the shared default', () => {
  assert.equal(holdsProfile(TCC_BUNDLE, undefined), true);
  assert.equal(holdsProfile(SPACED_ROOT, undefined), true);
  assert.equal(holdsProfile(FOREIGN_ELECTRON, undefined), false);
  // The kabi-sol captures are real FORMAT but not Maka processes (fixture dir).
  assert.equal(hasMakaDevMarker(PLAIN_SHIM), false);
  assert.equal(hasMakaDevMarker(PLAIN_REAL), false);
});

test('holdsProfile: explicit known target matches, bounded', () => {
  const TARGET = '/tmp/Maka Profile With Spaces';
  const makaWithSwitch = `${TCC_BUNDLE} --user-data-dir=${TARGET} --no-sandbox`;
  assert.equal(holdsProfile(makaWithSwitch, TARGET), true);
  // Known-limitation: a no-space target that is a PREFIX of the real value
  // matches (the flat argv cannot prove where the value ends). Accepted on
  // the side of SEEING more holders (P3 wins: a switch followed by a
  // positional argument must not be missed).
  assert.equal(holdsProfile(makaWithSwitch, '/tmp/Maka'), true);
  // Switch followed by a positional argument: the no-space value is still
  // matched (P3), and the space-bearing value is not recoverable — the
  // target's own shape decides the boundary.
  assert.equal(
    holdsProfile(`${TCC_BUNDLE} --user-data-dir=/tmp/x /some/app`, '/tmp/x'),
    true,
  );
  // Uniform boundary (?=\s|$): a longer real value adds a non-space
  // character (e.g. `-abc123` or `/sub`), which the whitespace boundary
  // still rejects; only the prefix-trap (value = target + space + more)
  // remains, which flat argv cannot decide — accepted, see above.
  assert.equal(
    holdsProfile(`${TCC_BUNDLE} --user-data-dir=${TARGET} /a`, TARGET),
    true,
  );
  assert.equal(holdsProfile(`${TCC_BUNDLE} --user-data-dir=${TARGET}-abc123`, TARGET), false);
  assert.equal(holdsProfile(`${TCC_BUNDLE} --user-data-dir=${TARGET}/sub`, TARGET), false);
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

test('hasMakaDevMarker basics', () => {
  assert.equal(hasMakaDevMarker(TCC_BUNDLE), true);
  assert.equal(hasMakaDevMarker(SPACED_ROOT), true);
  assert.equal(hasMakaDevMarker(FOREIGN_ELECTRON), false);
});
