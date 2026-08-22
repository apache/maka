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
// single-instance lock keys on userData, so another worktree's dev app holds
// the lock for this profile too; launching must fail fast with the owner
// instead of being silently absorbed. Owner is judged per-PROFILE: command
// line -> worktree -> that worktree's dev-env.json -> userDataDir.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DEV_USER_DATA_DIR,
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
    const isKnownMakaWorktree = path.startsWith('/Users/') || path.startsWith('/home/');
    if (isKnownMakaWorktree && path.endsWith('/apps/desktop/.maka-dev/dev-env.json')) {
      if (otherProfile && path.includes(`${OTHER}/apps/desktop/.maka-dev`)) {
        return otherEnvIsolated;
      }
      return otherEnvDefault;
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
    DEV_USER_DATA_DIR, // env file has no explicit userDataDir -> shared default
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
// Stubs spawnSync so the FULL pgrep -> ps -> parse chain is exercised.
// Real Darwin output samples are still being collected (kabi's macOS review
// found #3359); fixtures are replaced with them once available.
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


test('root recovery is exact: no prefix-sibling or marker-substring confusion', () => {
  assert.equal(worktreeFromCommandLine('/home/x/wt-3/apps/desktop --inspect'), '/home/x/wt-3');
  assert.equal(worktreeFromCommandLine('/home/x/wt-35/apps/desktop --inspect'), '/home/x/wt-35');
  assert.equal(worktreeFromCommandLine('/home/x/wt-3/apps/desktopish --inspect'), undefined);
  // A deeper checkout nested under our root is NOT ours.
  const nested = '/home/x/wt-3/sibling/apps/desktop --inspect';
  assert.equal(
    sharedDevelopmentAppOwner({
      ownRoot: '/home/x/wt-3',
      commandLines: [nested],
      readFile: readEnvFixture(),
    }),
    nested,
  );
});


test('a foreign repo Electron without our dev-env.json is NOT an owner', () => {
  const foreign = '/opt/elsewhere/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /opt/elsewhere/apps/desktop';
  assert.equal(
    sharedDevelopmentAppOwner({
      ownRoot: OWN,
      commandLines: [foreign],
      readFile: readEnvFixture(),
    }),
    undefined,
  );
});

test('a worktree root with a space cannot be recovered and is not misjudged', () => {
  // argv text cannot delimit a space inside a path, so the root recovery
  // fails conservatively: the process is not attributed to any worktree and
  // therefore is not an owner (fail-safe, no false block).
  const spaced = '/Users/me/My Workspace/apps/desktop --inspect=9229';
  assert.equal(worktreeFromCommandLine(spaced), undefined);
  assert.equal(
    sharedDevelopmentAppOwner({
      ownRoot: OWN,
      commandLines: [spaced],
      readFile: readEnvFixture(),
    }),
    undefined,
  );
});
