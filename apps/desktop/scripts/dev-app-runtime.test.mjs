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
// Two-worktree regression for the shared "Maka Dev" profile (#3359): the
// single-instance lock is keyed on userData, so a running dev app from ANOTHER
// worktree holds the lock for this profile too. Launching must fail fast with
// the owner instead of being silently absorbed (exit-0 + `never-started`).
//
// The owner judgment is per-PROFILE. The profile is not on a process command
// line: `--user-data-dir` is stripped from electronArgs and the bootstrap
// applies `app.setPath('userData', env.userDataDir || DEV_USER_DATA_DIR)`.
// So the chain is: command line -> worktree root -> that worktree's
// `.maka-dev/dev-env.json` -> userDataDir. Plain `npm run dev` runs TWO live
// processes (the node shim and the resolved Electron binary); both shapes are
// covered, and both reach the shared profile through the bootstrap.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  assertNoCrossWorktreeOwner,
  createSharedAppProbe,
  resolveProcessUserDataDir,
  sharedDevelopmentAppCommandLines,
  sharedDevelopmentAppOwner,
  worktreeFromCommandLine,
} from './dev-app-runtime.mjs';

const OWN = '/Users/me/codebase';
const OTHER = '/Users/other/codebase';
const SHARED_PROFILE = '/Users/me/Library/Application Support/Maka Dev';
const OTHER_PROFILE = '/Users/other/Library/Application Support/Isolated Dev';

// dev env file shapes (schemaVersion 1, per dev-app-runtime.mjs).
const otherEnvDefault = JSON.stringify({
  schemaVersion: 1,
  env: {},
  userDataDir: undefined,
  electronArgs: [],
});
const otherEnvIsolated = JSON.stringify({
  schemaVersion: 1,
  env: {},
  userDataDir: OTHER_PROFILE,
  electronArgs: [],
});

function readEnvFixture(options = {}) {
  const { otherProfile = false } = options;
  return (path) => {
    if (path.includes(`${OTHER}/apps/desktop/.maka-dev/dev-env.json`)) {
      return otherProfile ? otherEnvIsolated : otherEnvDefault;
    }
    throw new Error(`unexpected env file read: ${path}`);
  };
}

// Real command-line shapes on macOS (kabi's reproduction): the bundle, the
// plain-dev node shim (`node …/.bin/electron <desktopDir> …`), and the
// resolved Electron binary the shim spawns.
const OTHER_BUNDLE = `${OTHER}/apps/desktop/.maka-dev/Maka Dev.app/Contents/MacOS/Electron`;
const OTHER_SHIM = `node ${OTHER}/node_modules/.bin/electron ${OTHER}/apps/desktop --inspect=9229`;
const OTHER_REAL = `${OTHER}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ${OTHER}/apps/desktop --inspect=9229`;

test('worktreeFromCommandLine recovers the root from bundle, shim, and resolved shapes', () => {
  assert.equal(worktreeFromCommandLine(`${OTHER_BUNDLE} --no-sandbox`), OTHER);
  assert.equal(worktreeFromCommandLine(OTHER_SHIM), OTHER);
  assert.equal(worktreeFromCommandLine(OTHER_REAL), OTHER);
  assert.equal(worktreeFromCommandLine('/usr/bin/something unrelated'), undefined);
});

test('resolveProcessUserDataDir reads the profile from the worktree dev env file', () => {
  assert.equal(
    resolveProcessUserDataDir(`${OTHER_BUNDLE} --inspect=9229`, { readFile: readEnvFixture() }),
    undefined, // env file has no explicit userDataDir -> default shared profile
  );
  assert.equal(
    resolveProcessUserDataDir(`${OTHER_BUNDLE} --inspect=9229`, {
      readFile: readEnvFixture({ otherProfile: true }),
    }),
    OTHER_PROFILE,
  );
});

test('a dev app from another worktree on the shared profile is the owner', () => {
  assert.equal(
    sharedDevelopmentAppOwner({
      ownRoot: OWN,
      targetProfile: OTHER_PROFILE,
      commandLines: [`${OTHER_BUNDLE} --inspect=9229`],
      readFile: readEnvFixture({ otherProfile: true }),
    }),
    `${OTHER_BUNDLE} --inspect=9229`,
  );
});

test('a plain shim process from another worktree on the shared profile is the owner', () => {
  assert.equal(
    sharedDevelopmentAppOwner({
      ownRoot: OWN,
      commandLines: [OTHER_SHIM],
      readFile: readEnvFixture(),
    }),
    OTHER_SHIM,
  );
});

test('a resolved plain Electron from another worktree is the owner', () => {
  assert.equal(
    sharedDevelopmentAppOwner({
      ownRoot: OWN,
      commandLines: [OTHER_REAL],
      readFile: readEnvFixture(),
    }),
    OTHER_REAL,
  );
});

test('this worktree own app is not reported as a foreign owner', () => {
  const ownBundle = `${OWN}/apps/desktop/.maka-dev/Maka Dev.app/Contents/MacOS/Electron --inspect=9229`;
  const ownShim = `node ${OWN}/node_modules/.bin/electron ${OWN}/apps/desktop --inspect=9229`;
  const ownReal = `${OWN}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ${OWN}/apps/desktop`;
  assert.equal(
    sharedDevelopmentAppOwner({ ownRoot: OWN, commandLines: [ownBundle, ownShim, ownReal] }),
    undefined,
  );
});

test('a process on a DIFFERENT profile is not an owner of this launch', () => {
  assert.equal(
    sharedDevelopmentAppOwner({
      ownRoot: OWN,
      targetProfile: OTHER_PROFILE,
      commandLines: [`${OTHER_BUNDLE} --inspect=9229`],
      readFile: readEnvFixture(), // other worktree on DEFAULT profile
    }),
    undefined,
  );
});

test('no running Maka Dev app means no owner', () => {
  assert.equal(sharedDevelopmentAppOwner({ ownRoot: OWN, commandLines: [] }), undefined);
});

test('a foreign owner fails the launch with an explicit message', () => {
  assert.throws(
    () => assertNoCrossWorktreeOwner({ owner: `${OTHER_BUNDLE} --remote-debugging-port=9222` }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Another worktree's Maka Dev app is running/);
      assert.match(error.message, /Quit it \(Cmd-Q\)/);
      return true;
    },
  );
});

test('no foreign owner does not fail', () => {
  assert.doesNotThrow(() => assertNoCrossWorktreeOwner({ commandLines: [] }));
});

// A foreign-owner path must not be confused with this worktree's own path just
// because they share the trailing `Maka Dev.app/...` suffix.
test('an owner path that merely contains our suffix is still foreign', () => {
  const sibling = `${OWN}/other-project/apps/desktop/.maka-dev/Maka Dev.app/Contents/MacOS/Electron`;
  assert.equal(
    sharedDevelopmentAppOwner({
      ownRoot: OWN,
      commandLines: [sibling],
      readFile: readEnvFixture(),
    }),
    sibling,
  );
});

// --- production probe parsing chain ---------------------------------------
// The probe runs `pgrep -f` for PIDs then `ps -o command=` for the command
// lines; these tests stub `spawnSync` so the FULL chain is exercised.
//
// Real Darwin `pgrep`/`ps` output samples are still being collected from a
// macOS machine (the review that found #3359 was reproduced there); the
// fixtures below are replaced with those samples once available. Until then
// the parsing contract is pinned by structure: PID column, then full argv.
test('the production probe resolves command lines through pgrep + ps', () => {
  const samples = {
    pgrep: '4242\n4243\n',
    ps: [OTHER_SHIM, OTHER_REAL].join('\n'),
  };
  const probe = (command, args) => {
    if (command === 'pgrep') return { status: 0, stdout: Buffer.from(samples.pgrep) };
    if (command === 'ps') return { status: 0, stdout: Buffer.from(samples.ps) };
    throw new Error(`unexpected command ${command}`);
  };
  const lines = sharedDevelopmentAppCommandLines({ probe: createSharedAppProbe(probe) });
  assert.equal(lines.length, 2);
  assert.equal(lines[0], OTHER_SHIM);
  assert.equal(lines[1], OTHER_REAL);
});


test('worktree root recovery does not confuse prefix-sibling worktrees', () => {
  assert.equal(worktreeFromCommandLine('/home/x/wt-3/apps/desktop --inspect'), '/home/x/wt-3');
  assert.equal(worktreeFromCommandLine('/home/x/wt-35/apps/desktop --inspect'), '/home/x/wt-35');
  assert.equal(worktreeFromCommandLine('/home/x/wt-3/apps/desktopish --inspect'), undefined);
  // A deeper checkout nested under our own root is NOT our own worktree.
  assert.equal(
    worktreeFromCommandLine('/home/x/wt-3/sibling/apps/desktop --inspect'),
    '/home/x/wt-3/sibling',
  );
  assert.equal(
    sharedDevelopmentAppOwner({
      ownRoot: '/home/x/wt-3',
      commandLines: ['/home/x/wt-3/sibling/apps/desktop --inspect'],
      readFile: readEnvFixture(),
    }),
    '/home/x/wt-3/sibling/apps/desktop --inspect',
  );
});
