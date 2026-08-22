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
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  assertNoCrossWorktreeOwner,
  developmentAppPath,
  sharedDevelopmentAppOwner,
} from './dev-app-runtime.mjs';

// DEV_EXECUTABLE is the app bundle's binary; the exported developmentAppPath
// is the .app bundle, so derive the executable path the same way the script
// does.
const OWN = join(developmentAppPath, 'Contents', 'MacOS', 'Electron');
const OTHER = '/Users/other/codebase/apps/desktop/.maka-dev/Maka Dev.app/Contents/MacOS/Electron';

test('a dev app from another worktree is reported as the shared-profile owner', () => {
  assert.equal(
    sharedDevelopmentAppOwner({
      ownExecutable: OWN,
      commandLines: [
        `${OTHER} --user-data-dir=/Users/other/Library/Application Support/Maka Dev --inspect=9229`,
      ],
    }),
    `${OTHER} --user-data-dir=/Users/other/Library/Application Support/Maka Dev --inspect=9229`,
  );
});

test('this worktree own app is not reported as a foreign owner', () => {
  assert.equal(
    sharedDevelopmentAppOwner({
      ownExecutable: OWN,
      commandLines: [
        `${OWN} --user-data-dir=/Users/me/Library/Application Support/Maka Dev --inspect=9229`,
      ],
    }),
    undefined,
  );
});

test('no running Maka Dev app means no owner', () => {
  assert.equal(sharedDevelopmentAppOwner({ ownExecutable: OWN, commandLines: [] }), undefined);
});

test('a foreign owner fails the launch with an explicit message', () => {
  assert.throws(
    () => assertNoCrossWorktreeOwner({ owner: `${OTHER} --remote-debugging-port=9222` }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Another worktree's Maka Dev app is running/);
      assert.match(error.message, /Quit it \(Cmd-Q\)/);
      return true;
    },
  );
});

test('the owner message names the executable path', () => {
  assert.throws(
    () => assertNoCrossWorktreeOwner({ owner: OTHER }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(OTHER));
      return true;
    },
  );
});

test('no foreign owner does not fail', () => {
  assert.doesNotThrow(() => assertNoCrossWorktreeOwner({ commandLines: [] }));
  assert.doesNotThrow(() =>
    assertNoCrossWorktreeOwner({ commandLines: [`${OWN} --no-sandbox`] }),
  );
});

// A foreign-owner path must not be confused with this worktree's own path just
// because they share the trailing `Maka Dev.app/...` suffix.
test('an owner path that merely contains our suffix is still foreign', () => {
  const sibling = join(
    '/Users/me/other-worktree/apps/desktop/.maka-dev',
    'Maka Dev.app/Contents/MacOS/Electron',
  );
  assert.equal(sharedDevelopmentAppOwner({ ownExecutable: OWN, commandLines: [sibling] }), sibling);
});
